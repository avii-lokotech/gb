<script setup>
// The player: plays a song's recording and follows it on the sheet (bars, beats, lyric lines, now/next chord),
// with a loop, a click, tempo, vocals off / drums & bass tracks and the beat offset (measured, tapped or nudged).
// The song comes from the API: its ChordPro text, which holds the timing too, and up to three tracks (the recording, vocals
// removed, drums and bass). Speed and loop are saved with the song; the beat offset belongs to this device and
// stays in its localStorage. Edit opens the song's text next to the sheet, which follows what is typed.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import AppButton, { CONTROL } from '../components/AppButton.vue';
import AppNotice from '../components/AppNotice.vue';
import SongSheet from '../components/SongSheet.vue';
import { api, errorMessage } from '../lib/api';
import { measureNode, waveOf } from '../lib/measure.js';
import { barOfBeat, barStart, beatAt, beatLen, cellIdx, layoutSong, median, mmss, parseCho, transposeChord, withTiming } from '../lib/song.js';

const props = defineProps({ id: { type: Number, required: true } }); // the song's id

const SPEEDS = [0.5, 0.6, 0.7, 0.75, 0.85, 0.9, 1];
// A line of the sheet holds two bars on a phone and four from Tailwind's sm: (40rem), as SongSheet draws it;
// the rows are cut to that, so they are laid out again when the window crosses it.
const wide = window.matchMedia('(min-width: 40rem)');
let barsPerLine = wide.matches ? 4 : 2;
function onWide() { barsPerLine = wide.matches ? 4 : 2; if (song && layout.value) applySong(); }
const TAPS_NEEDED = 8;
const DRAWER_HEIGHT = 'h-80 md:h-96';   // the editor drawer, and the space kept free for it under the sheet
const SYNC_KEY = 'guitarbook.tapsync:song:' + props.id;

const audio = ref(null);                  // the <audio> element
let song = null, sync = null;             // the parsed text and the timing it gives
const layout = shallowRef(null);

const title = ref('Loading…');
const meta = ref('');
const warn = ref('');
const playing = ref(false);
const timeText = ref('0:00 / 0:00');
const seekVal = ref(0);
const speed = ref(1);
const loopA = ref(null), loopB = ref(null), loopOn = ref(false);
const follow = ref(true), clickOn = ref(false), sounding = ref(false);
const curBar = ref(-1), curCell = ref(-1), curLine = ref(-1);
const dotsN = ref(0), dotsPos = ref(-1);
const nowChord = ref(null), nextChord = ref(null), nextIn = ref('');
let curBeat = -1, seeking = false;

const capo = computed(() => layout.value?.capo ?? 0);
const show = (c) => (sounding.value ? transposeChord(c, capo.value, layout.value.flats) : c);
const loopRange = computed(() => (loopOn.value && loopA.value !== null && loopB.value !== null ? [loopA.value, loopB.value] : null));
const loopText = computed(() => (loopOn.value && loopB.value !== null ? `Loop ${loopA.value + 1}–${loopB.value + 1}` : 'Loop'));
const pitchText = computed(() => (sounding.value ? 'Sounding' : capo.value ? `Shapes (capo ${capo.value})` : 'Shapes'));

/* ---------------- the sheet ---------------- */
function applySong() {
  const l = layoutSong(song, { barsPerLine });
  sync = l.sync;
  const m = song.meta;
  title.value = m.title || 'Untitled';
  meta.value = [m.artist, m.key && 'key ' + m.key, l.capo ? 'capo ' + l.capo : '', m.time, m.tempo && m.tempo + ' bpm']
    .filter(Boolean).join(' · ');
  document.title = (m.title || 'Song') + ' – Player';
  warn.value = l.warns.join(' ');
  layout.value = l;
  curBeat = -1; curBar.value = curCell.value = curLine.value = -1;
  tick(true);
}

/* ---------------- sync ---------------- */
function barEnd(k) {
  return k + 1 < sync.bars.length ? barStart(sync, k + 1) : (audio.value.duration || sync.beats[sync.beats.length - 1] + 1);
}
function seekBar(k, shift) {
  if (!sync || k < 0 || k >= sync.bars.length) return;
  if (shift && loopA.value !== null) {
    loopB.value = k;
    if (loopB.value < loopA.value) [loopA.value, loopB.value] = [loopB.value, loopA.value];
    loopOn.value = true;
  } else { loopA.value = k; loopB.value = null; loopOn.value = false; }
  audio.value.currentTime = Math.max(0, barStart(sync, k) - syncOffset);
  curBeat = -1;
}
function seekLine(g) {
  if (!layout.value?.linesMatch) return;
  audio.value.currentTime = Math.max(0, sync.lines[g][0] - 0.3 - syncOffset); curBeat = -1;
}

function click(accent) {
  try {
    const actx = ensureGraph();
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = accent ? 1600 : 1000;
    g.gain.setValueAtTime(0.35, actx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.05);
    o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.06);
  } catch (e) { /* audio context unavailable */ }
}

function tick(force) {
  const el = audio.value; if (!el) return;
  const at = el.currentTime, t = at + syncOffset;   // t = position in the song data
  const dur = el.duration || 0;
  timeText.value = mmss(at) + ' / ' + mmss(dur);
  if (!seeking) seekVal.value = dur ? Math.round(at / dur * 1000) : 0;
  if (!sync || !layout.value) return;
  if (loopOn.value && loopB.value !== null && !el.paused && t >= barEnd(loopB.value) - 0.01) {
    el.currentTime = Math.max(0, barStart(sync, loopA.value) - syncOffset); return;
  }
  const i = beatAt(sync, t);
  if (i !== curBeat || force) {
    const k = i >= 0 ? barOfBeat(sync, i) : -1;
    if (clickOn.value && !el.paused && i >= 0 && i === curBeat + 1 && !force) click(k >= 0 && i === sync.bars[k][0]);
    curBar.value = k;
    // the beat: its cell in the bar, and its dot
    let pos = -1, n = 0, cell = -1;
    if (k >= 0) {
      const [s, e] = sync.bars[k]; n = e - s; pos = i - s;
      const len = layout.value.cellCounts[k];
      if (len) cell = cellIdx(pos, len, n);
    }
    curCell.value = cell; dotsN.value = n; dotsPos.value = pos;
    // now / next chord
    const beatChord = layout.value.beatChord;
    const now = i >= 0 ? beatChord[i] : beatChord.find(Boolean);
    nowChord.value = now || null;
    let j = Math.max(i, 0) + 1; while (j < beatChord.length && beatChord[j] === now) j++;
    if (j < beatChord.length && beatChord[j]) {
      nextChord.value = beatChord[j];
      const beatsAway = j - Math.max(i, 0);
      nextIn.value = beatsAway <= 8 ? `in ${beatsAway} beat${beatsAway > 1 ? 's' : ''}` : `in ${Math.round(sync.beats[j] - t)}s`;
    } else { nextChord.value = null; nextIn.value = ''; }
    curBeat = i;
  }
  // lyric line
  if (layout.value.linesMatch) {
    let L = -1;
    for (let q = 0; q < sync.lines.length; q++) {   // latest line that has started
      const [a, b] = sync.lines[q];
      if (a - 0.25 > t) break;
      if (t <= b + 0.6) L = q;
    }
    curLine.value = L;
  }
}
let frame = 0;
function loop() { tick(false); frame = requestAnimationFrame(loop); }

/* ---------------- loading ---------------- */
// Versions of the song: the full mix and, optionally, the band only (vocals removed) and
// the drums + bass only. Switching jumps to the other file at the same position.
const sources = { mix: null, inst: null, rhythm: null };   // each {blob, url, wave}
let curSrc = null;
const vocalsOn = ref(true), rhythmOnly = ref(false);
const hasInst = ref(false), hasRhythm = ref(false);
function makeSource(old, blob) {
  if (old) URL.revokeObjectURL(old.url);
  return { blob, url: URL.createObjectURL(blob), wave: null };   // wave: reference for the sync measurement
}
function useSource(src, keepPosition) {
  if (!src || src === curSrc) return;
  const el = audio.value;
  const t = el.currentTime, wasPlaying = !el.paused, rate = el.playbackRate;
  curSrc = src; el.src = src.url;
  el.addEventListener('loadedmetadata', () => {
    if (keepPosition) el.currentTime = t;
    el.playbackRate = keepPosition ? rate : speed.value; el.preservesPitch = true;
    if (keepPosition && wasPlaying) el.play();
  }, { once: true });
}
function setAudio(blob) { sources.mix = makeSource(sources.mix, blob); curSrc = null; useSource(sources.mix, false); }
function setExtra(name, blob) {                   // name: "inst" or "rhythm"
  if (!blob && sources[name]) URL.revokeObjectURL(sources[name].url);
  sources[name] = blob ? makeSource(sources[name], blob) : null;
  hasInst.value = !!sources.inst; hasRhythm.value = !!sources.rhythm;
  if (!sources.inst) vocalsOn.value = true;
  if (!sources.rhythm) rhythmOnly.value = false;
}
function playChosenTrack() {
  useSource(rhythmOnly.value ? sources.rhythm : vocalsOn.value ? sources.mix : sources.inst, true);
}
function toggleVocals() {
  if (!sources.inst) return;
  if (rhythmOnly.value) rhythmOnly.value = false; else vocalsOn.value = !vocalsOn.value;   // from drums & bass: back to the song
  playChosenTrack();
}
function toggleRhythm() {
  if (!sources.rhythm) return;
  rhythmOnly.value = !rhythmOnly.value;
  playChosenTrack();
}

let gone = false;   // the player was left while something was still loading
async function load() {
  try {
    const data = await api.getSong(props.id);
    if (gone) return;
    if (data.status !== 'ready' || !data.cho) {
      title.value = data.title;
      warn.value = data.status === 'failed' ? `The conversion failed: ${data.error}` : 'This song is not converted yet.';
      return;
    }
    // a song converted before the timing was in the text: put it there (stored when the text is next saved)
    savedCho.value = withTiming(data.cho, data.sync); draftCho = withTiming(data.draft ?? data.cho, data.sync);
    song = parseCho(savedCho.value);
    applySong();
    restoreSetting(data);
    // loaded as blobs: the audio needs the session token, which an <audio> element cannot send
    const blob = await api.songAudio(props.id, 'mix');
    if (gone) return;
    setAudio(blob);
    for (const [name, track] of [['inst', 'instrumental'], ['rhythm', 'rhythm']]) {
      let extra = null;
      try { extra = data.tracks[track] ? await api.songAudio(props.id, track) : null; } catch (e) { extra = null; }
      if (gone) return;
      setExtra(name, extra);
    }
  } catch (e) {
    if (gone) return;
    if (!layout.value) title.value = 'Could not load the song';
    warn.value = errorMessage(e);
  }
}

/* ---------------- editing the song's text ---------------- */
// The editor holds the ChordPro text; the sheet and the timing are worked out again from it while typing, so
// a bar or a line without its time shows at once. Nothing is stored until Save. Cancel goes back to the stored text; "Converted draft" puts the
// text the conversion made in the editor.
const editing = ref(false), editText = ref(''), savedCho = ref(''), saving = ref(false), editNote = ref('');
let draftCho = '', previewTimer = null;
const dirty = computed(() => editing.value && editText.value !== savedCho.value);
function preview(text) {
  clearTimeout(previewTimer);
  song = parseCho(text); applySong();
}
function startEdit() {
  if (!layout.value) return;
  editText.value = savedCho.value; editNote.value = ''; editing.value = true;
}
function onEditInput(e) {
  editText.value = e.target.value; editNote.value = '';
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => preview(editText.value), 300);
}
function useDraft() {
  editText.value = draftCho; editNote.value = 'This is the text as converted. Save to keep it.';
  preview(draftCho);
}
function cancelEdit() {
  editing.value = false; editNote.value = '';
  preview(savedCho.value);
}
async function saveEdit() {
  saving.value = true; editNote.value = '';
  try {
    const text = editText.value;
    await api.saveSongText(props.id, text);
    savedCho.value = text; preview(text);
    editNote.value = 'Saved.';
  } catch (e) {
    editNote.value = errorMessage(e);
  } finally {
    saving.value = false;
  }
}
onBeforeRouteLeave(() => {
  if (!dirty.value) return true;
  editNote.value = 'The text has changes that are not saved: Save or Cancel first.';
  return false;
});

/* ---------------- the user's setting of the song ---------------- */
let settingReady = false, pending = null, saveTimer = null, playedSaved = false, savedLoop = 'null';
function restoreSetting(s) {
  if (SPEEDS.includes(s.speed)) speed.value = s.speed;
  if (s.loop && sync && layout.value.barsMatch && s.loop[1] < sync.bars.length) {
    [loopA.value, loopB.value] = s.loop; loopOn.value = true;
    savedLoop = JSON.stringify(s.loop);
  }
  settingReady = true;
}
function saveSetting(patch) {
  if (!settingReady) return;
  pending = { ...pending, ...patch };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSetting, 800);
}
function flushSetting() {
  clearTimeout(saveTimer);
  if (!pending) return;
  const patch = pending; pending = null;
  api.saveSongSetting(props.id, patch).catch(() => { /* kept for this visit only */ });
}
watch(loopRange, (range) => {
  const key = JSON.stringify(range);
  if (!settingReady || key === savedLoop) return;
  savedLoop = key; saveSetting({ loop: range });
});

/* ---------------- controls ---------------- */
function togglePlay() {
  const el = audio.value;
  if (el.paused) { ensureGraph(); ctx.resume(); el.play(); } else el.pause();
}
function onPlay() {
  playing.value = true;
  if (!playedSaved) { playedSaved = true; saveSetting({ played: true }); }
}
function onSeekInput(e) {
  seeking = true; seekVal.value = +e.target.value;
  const el = audio.value; if (el.duration) el.currentTime = seekVal.value / 1000 * el.duration;
}
function setSpeed(v) {
  speed.value = v;
  audio.value.playbackRate = v; audio.value.preservesPitch = true;
  updateOffset(); saveSetting({ speed: v });
}
function toggleLoop() { if (loopB.value !== null) loopOn.value = !loopOn.value; }

function onKey(e) {
  if (e.target.matches('input, select, textarea') || e.metaKey || e.ctrlKey) return;
  const k = e.key;
  if (k === ' ') { e.preventDefault(); if (tapMode.value) tap(); else togglePlay(); }
  else if (k === 'Escape' && tapMode.value) stopTapSync();
  else if (k === 's' || k === 'S') toggleTapSync();
  else if (k === '+' || k === '=') setTrim(trim.value - 0.01);
  else if (k === '-') setTrim(trim.value + 0.01);
  else if (k === 'ArrowRight' && sync) { e.preventDefault(); seekBar(Math.min(sync.bars.length - 1, curBar.value + 1), false); }
  else if (k === 'ArrowLeft' && sync) { e.preventDefault(); seekBar(Math.max(0, curBar.value - 1), false); }
  else if (k === 'l' || k === 'L') toggleLoop();
  else if (k === 'c' || k === 'C') clickOn.value = !clickOn.value;
  else if (k === 'v' || k === 'V') toggleVocals();
  else if (k === 'b' || k === 'B') toggleRhythm();
  else if (k === 'f' || k === 'F') follow.value = !follow.value;
  else if ((k === 'p' || k === 'P') && capo.value) sounding.value = !sounding.value;
  else if (k === '[' || k === ']') {
    const i = Math.max(0, Math.min(SPEEDS.length - 1, SPEEDS.indexOf(speed.value) + (k === ']' ? 1 : -1)));
    setSpeed(SPEEDS[i]);
  }
}

/* ---------------- sync offset ---------------- */
// Position in the song data = audio.currentTime + syncOffset, where
//   syncOffset = skew - deviceLatency * playbackRate + trim
//   skew          measured: what the player is really outputting vs. what audio.currentTime says
//   deviceLatency reported by the browser: time from output until the sound reaches the speakers
//   trim          the user's own adjustment (nudge buttons / tap)
let syncOffset = 0, skew = 0, measuredOk = false, measuring = false;
let ctx = null, elSrc = null;
const trim = ref(0);
const offDelay = ref(0);                  // ms the beats start after the audio: −trim
const syncStatus = ref(''), syncTitle = ref(''), syncOk = ref(false);
const offTitle = computed(() => (offDelay.value > 0 ? `Beats start ${offDelay.value} ms after the audio`
  : offDelay.value < 0 ? `Beats start ${-offDelay.value} ms before the audio` : 'Beats and audio start together'));

function ensureGraph() {
  if (ctx) return ctx;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  elSrc = ctx.createMediaElementSource(audio.value);   // from now on the player's sound goes through ctx
  elSrc.connect(ctx.destination);
  return ctx;
}
function deviceLatency() { return ctx ? (ctx.baseLatency || 0) + (ctx.outputLatency || 0) : 0; }
function updateOffset() {
  syncOffset = skew - deviceLatency() * (audio.value?.playbackRate || 1) + trim.value;
  const ms = (x) => Math.round(x * 1000);
  offDelay.value = -ms(trim.value) || 0;
  syncStatus.value = measuring ? 'checking sync…' : (measuredOk || trim.value) ? '✓ In sync' : '';
  syncTitle.value = `Measured: player ${ms(skew)} ms, speakers ${ms(deviceLatency())} ms, your taps ${ms(trim.value)} ms`;
  syncOk.value = !measuring && (measuredOk || !!trim.value);
  curBeat = -1; if (song) tick(true);
}
function loadSync() {
  let v = null;
  try { v = localStorage.getItem(SYNC_KEY); } catch (e) { /* storage blocked */ }
  trim.value = v !== null && isFinite(+v) ? +v : 0;
  updateOffset();
}
function setTrim(v) {
  trim.value = Math.round(Math.max(-5, Math.min(5, v)) * 1000) / 1000;
  try { localStorage.setItem(SYNC_KEY, trim.value); } catch (e) { /* storage blocked */ }
  updateOffset();
}

/* --- measuring what the player really outputs --- */
async function getRefWave() {                     // waveform of the file that is playing now
  const src = curSrc;
  if (!src) return null;
  if (!src.wave) src.wave = await waveOf(ctx, src.blob);
  return src.wave;
}
let measureSeq = 0;
async function autoMeasure() {
  const el = audio.value;
  if (!ctx || !curSrc || !el || el.paused) return;
  if (Math.abs(el.playbackRate - 1) > 1e-3) return;          // measured at 100% speed, reused at other speeds
  const my = ++measureSeq; measuring = true; updateOffset();
  let res = null;
  try { res = await measureNode(ctx, elSrc, () => el.currentTime, getRefWave); } catch (e) { res = null; }
  if (my !== measureSeq || gone) return;                         // superseded by a newer measurement
  measuring = false;
  if (res && res.score > 0.6) {
    skew = res.skew; measuredOk = true;
  }
  updateOffset();
}
let measureTimer = null;
function scheduleMeasure() {
  clearTimeout(measureTimer);
  measureTimer = setTimeout(autoMeasure, 400);
}
function onSeeked() { if (!audio.value.paused) scheduleMeasure(); }

// Tap to sync: tap the space bar on every beat; after 8 steady taps the highlighting is
// shifted so the beats line up with what you hear.
const tapMode = ref(false);
const tapInfo = ref(null);                // the banner: { first, text, done, count }, or null for none
let taps = [], tapTimer = null;
function startTapSync() {
  if (!sync) return;
  if (audio.value.paused) togglePlay();
  tapMode.value = true; taps = [];
  drawTap('', false, true);
  armTapTimeout();
}
function stopTapSync(msg) {
  tapMode.value = false; taps = []; clearTimeout(tapTimer);
  if (msg) { drawTap(msg, true); tapTimer = setTimeout(() => { tapInfo.value = null; }, 3500); }
  else tapInfo.value = null;
}
function toggleTapSync() { if (tapMode.value) stopTapSync(); else startTapSync(); }
function armTapTimeout() {
  clearTimeout(tapTimer);
  tapTimer = setTimeout(() => stopTapSync('No taps – sync unchanged.'), 6000);
}
function drawTap(text, done, first = false) {
  tapInfo.value = { first, text, done: !!done, count: taps.length };
}
function tap() {
  const el = audio.value;
  if (!tapMode.value || el.paused) return;
  armTapTimeout();
  const at = el.currentTime + syncOffset - trim.value;         // where the song is, without earlier taps
  const i = beatAt(sync, at), bs = sync.beats;
  let best = bs[Math.max(0, i)];
  if (i + 1 < bs.length && Math.abs(bs[i + 1] - at) < Math.abs(best - at)) best = bs[i + 1];
  taps.push(best - at);
  if (taps.length < TAPS_NEEDED) { drawTap('Keep tapping on every beat…'); return; }
  // line the taps up around the first one (a tap can't be more than half a beat off)
  const bl = beatLen(sync), last = taps.slice(-TAPS_NEEDED), ref0 = last[0];
  const adj = last.map((d) => d - Math.round((d - ref0) / bl) * bl);
  let med = median(adj);
  const dev = median(adj.map((d) => Math.abs(d - med)));
  // taps only tell us the distance to *a* beat: take the smallest correction, so we never
  // shift by a whole beat (big delays are already measured automatically)
  med -= Math.round(med / bl) * bl;
  if (dev > 0.06) {
    if (taps.length >= TAPS_NEEDED * 3) return stopTapSync('The taps were too uneven to use – sync unchanged. Try again.');
    drawTap('Nearly there – keep tapping steadily on every beat…'); return;
  }
  setTrim(med);
  stopTapSync('✓ In sync');
}

onMounted(() => {
  document.addEventListener('keydown', onKey);
  wide.addEventListener('change', onWide);
  loadSync();
  load();
  frame = requestAnimationFrame(loop);
});
onBeforeUnmount(() => {
  gone = true;
  document.removeEventListener('keydown', onKey);
  wide.removeEventListener('change', onWide);
  cancelAnimationFrame(frame);
  clearTimeout(measureTimer); clearTimeout(tapTimer); clearTimeout(previewTimer);
  flushSetting();
  audio.value?.pause();
  for (const src of Object.values(sources)) if (src) URL.revokeObjectURL(src.url);
  if (ctx) ctx.close();
});
</script>

<template>
  <!-- the controls: at the top of the page on a phone, staying in view from md: -->
  <header class="border-b border-line bg-panel px-3 py-2.5 sm:px-4 md:sticky md:top-0 md:z-10">
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
      <RouterLink class="text-sm text-muted no-underline hover:text-accent" :to="{ name: 'songs' }">‹ Songs</RouterLink>
      <RouterLink class="text-sm text-muted no-underline hover:text-accent" :to="{ name: 'beats', query: { id } }">Beats</RouterLink>
      <div class="min-w-0">
        <h1 class="text-lg font-bold">{{ title }}</h1>
        <div class="text-sm text-muted">{{ meta }}</div>
      </div>
      <div class="ml-auto flex items-baseline gap-6">
        <div>
          <div class="text-xs uppercase tracking-wider text-muted">Now <span class="ml-1.5 inline-flex gap-1 align-middle"><i v-for="q in dotsN" :key="q"
            class="inline-block size-2 rounded-full" :class="q - 1 === dotsPos ? 'bg-beat' : 'bg-line'"></i></span></div>
          <span class="inline-block min-w-10 text-3xl font-bold text-chord">{{ nowChord ? show(nowChord) : '–' }}</span>
        </div>
        <div>
          <div class="text-xs uppercase tracking-wider text-muted">Next</div>
          <span class="text-xl font-semibold">{{ nextChord ? show(nextChord) : '–' }}</span> <span class="text-xs text-muted">{{ nextIn }}</span>
        </div>
      </div>
    </div>
    <div class="mt-2 flex flex-wrap items-center gap-1.5">
      <AppButton class="min-w-20 font-semibold" title="Space" @click="togglePlay">{{ playing ? '❚❚ Pause' : '▶ Play' }}</AppButton>
      <span class="min-w-24 text-sm tabular-nums text-muted">{{ timeText }}</span>
      <!-- the position: a line of its own on a phone, between the other controls from sm: -->
      <input class="min-w-36 flex-1 basis-full accent-accent sm:basis-0" type="range" min="0" max="1000" :value="seekVal" aria-label="Position"
        @input="onSeekInput" @change="seeking = false">
      <select :class="CONTROL" title="[ and ] to change" :value="speed" @change="setSpeed(+$event.target.value)">
        <option v-for="s in SPEEDS" :key="s" :value="s">{{ Math.round(s * 100) }}%</option>
      </select>
      <AppButton title="L" :on="loopOn" @click="toggleLoop">{{ loopText }}</AppButton>
      <AppButton title="C" :on="clickOn" @click="clickOn = !clickOn">Click</AppButton>
      <AppButton :disabled="!hasInst" :on="!vocalsOn && !rhythmOnly" @click="toggleVocals"
        :title="hasInst ? 'V: mute or unmute the vocals' : 'No band-only track for this song'">
        {{ vocalsOn ? 'Vocals on' : 'Vocals off' }}
      </AppButton>
      <AppButton :disabled="!hasRhythm" :on="rhythmOnly" @click="toggleRhythm"
        :title="hasRhythm ? 'B: play only the drums and bass' : 'No drums & bass track for this song'">
        Drums &amp; bass
      </AppButton>
      <AppButton title="F" :on="follow" @click="follow = !follow">Follow</AppButton>
      <AppButton title="P" :on="sounding" :disabled="!capo" @click="sounding = !sounding">{{ pitchText }}</AppButton>
      <AppButton title="Correct the chords and lyrics" :on="editing" :disabled="!layout" @click="editing ? cancelEdit() : startEdit()">Edit</AppButton>
      <AppButton :variant="tapMode ? 'solid' : 'default'" title="S: tap the space bar on every beat to sync" @click="toggleTapSync">
        {{ tapMode ? 'Tapping… (Esc)' : 'Tap to sync' }}
      </AppButton>
      <span class="inline-flex items-center gap-1" title="How much later the beats start than the audio">
        <span class="text-xs text-muted">Beats</span>
        <AppButton class="min-w-8 font-bold" title="Beats 10 ms earlier (− key)" @click="setTrim(trim + 0.01)">−</AppButton>
        <span class="min-w-14 text-center text-sm tabular-nums" :class="{ 'font-semibold text-accent': offDelay !== 0 }" :title="offTitle">{{ (offDelay > 0 ? '+' : '') + offDelay }} ms</span>
        <AppButton class="min-w-8 font-bold" title="Beats 10 ms later (+ key)" @click="setTrim(trim - 0.01)">+</AppButton>
        <AppButton title="Back to 0 ms: audio and beats start together" :disabled="offDelay === 0" @click="setTrim(0)">Reset</AppButton>
      </span>
      <span class="text-xs" :class="syncOk ? 'text-ok' : 'text-muted'" :title="syncTitle">{{ syncStatus }}</span>
    </div>
    <!-- the keys: only where there is room, and likely a keyboard -->
    <div class="mt-1.5 hidden text-xs text-muted lg:block">Click a bar, lyric line or time to jump · <kbd>Shift</kbd>+click a bar to loop from the last clicked bar ·
      <kbd>Space</kbd> play · <kbd>←</kbd>/<kbd>→</kbd> bar · <kbd>L</kbd> loop · <kbd>C</kbd> click · <kbd>V</kbd> vocals · <kbd>B</kbd> drums &amp; bass · <kbd>S</kbd> tap to sync · <kbd>−</kbd>/<kbd>+</kbd> beats 10 ms earlier/later</div>
    <div v-if="tapInfo" class="mt-2 flex flex-wrap items-center gap-3.5 rounded-lg border border-accent bg-accent-soft px-3.5 py-2.5">
      <span v-if="tapInfo.first">Tap the <b>space bar</b> on every beat, like tapping your foot.</span>
      <span v-else>{{ tapInfo.text }}</span>
      <template v-if="!tapInfo.done">
        <span class="inline-flex gap-1"><i v-for="i in TAPS_NEEDED" :key="i" class="inline-block size-3 rounded-full border-2 border-accent"
          :class="{ 'bg-accent': i - 1 < tapInfo.count }"></i></span>
        <span class="text-xs text-muted">Esc to cancel</span>
      </template>
    </div>
  </header>
  <AppNotice v-if="warn">{{ warn }}</AppNotice>
  <SongSheet v-if="layout" :layout="layout" :sounding="sounding" :cur-bar="curBar" :cur-cell="curCell" :cur-line="curLine"
    :loop="loopRange" :follow="follow" :playing="playing" @seek-bar="seekBar" @seek-line="seekLine" />
  <!-- the editor: a drawer over the bottom of the page; the spacer, as high as the drawer, keeps the end of the
       sheet reachable above it -->
  <template v-if="editing">
    <div :class="DRAWER_HEIGHT"></div>
    <section class="fixed inset-x-0 bottom-0 z-20 flex flex-col border-t border-line bg-panel shadow-2xl" :class="DRAWER_HEIGHT" aria-label="The song's text">
      <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-3 py-2 sm:px-4">
        <AppButton variant="primary" :disabled="saving || !dirty" @click="saveEdit">{{ saving ? 'Saving…' : 'Save' }}</AppButton>
        <AppButton :disabled="saving" @click="cancelEdit">{{ dirty ? 'Cancel' : 'Close' }}</AppButton>
        <AppButton :disabled="saving || editText === draftCho" title="Put the text as it was converted in the editor" @click="useDraft">Converted draft</AppButton>
        <span class="text-sm text-accent" role="status">{{ editNote }}</span>
        <span class="ml-auto hidden text-xs text-muted lg:inline"><code>| D . Em . |</code> is one bar, a cell per beat, <code>.</code> keeps the chord; <code>{x_bars: …}</code> above a row is
          when each of its bars starts, <code>{x_line: start end}</code> above a lyric line when it is sung, in ms.</span>
      </div>
      <textarea class="min-h-0 w-full flex-1 resize-none overflow-auto whitespace-pre border-t border-line bg-bg px-3 py-2.5 font-mono text-sm text-ink focus:outline-2 focus:-outline-offset-2 focus:outline-accent sm:px-4"
        :value="editText" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="ChordPro text" @input="onEditInput"></textarea>
    </section>
  </template>
  <audio ref="audio" preload="auto" @play="onPlay" @pause="playing = false" @playing="scheduleMeasure"
    @seeked="onSeeked" @ratechange="updateOffset"></audio>
</template>
