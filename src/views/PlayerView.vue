<script setup>
// The player: plays a song's recording and follows it on the sheet (bars, beats, lyric lines, now/next chord),
// with a loop, a click, tempo, vocals off / drums & bass tracks and the beat offset (measured, tapped or nudged).
// The song comes from the API: its ChordPro text, its timing and up to three tracks (the recording, vocals
// removed, drums and bass). Speed and loop are saved with the song; the beat offset belongs to this device and
// stays in its localStorage.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import SongSheet from '../components/SongSheet.vue';
import { api, errorMessage } from '../lib/api';
import { measureNode, waveOf } from '../lib/measure.js';
import { barOfBeat, barStart, beatAt, beatLen, cellIdx, layoutSong, median, mmss, parseCho, transposeChord } from '../lib/song.js';

const props = defineProps({ id: { type: Number, required: true } }); // the song's id

const SPEEDS = [0.5, 0.6, 0.7, 0.75, 0.85, 0.9, 1];
const TAPS_NEEDED = 8;
const SYNC_KEY = 'guitarbook.tapsync:song:' + props.id;

const audio = ref(null);                  // the <audio> element
let song = null, sync = null;             // the parsed .cho and its timing file
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
  const l = layoutSong(song, sync);
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
    song = parseCho(data.cho); sync = data.sync;
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
  if (e.target.matches('input, select') || e.metaKey || e.ctrlKey) return;
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
  loadSync();
  load();
  frame = requestAnimationFrame(loop);
});
onBeforeUnmount(() => {
  gone = true;
  document.removeEventListener('keydown', onKey);
  cancelAnimationFrame(frame);
  clearTimeout(measureTimer); clearTimeout(tapTimer);
  flushSetting();
  audio.value?.pause();
  for (const src of Object.values(sources)) if (src) URL.revokeObjectURL(src.url);
  if (ctx) ctx.close();
});
</script>

<template>
  <header>
    <div class="top">
      <RouterLink class="back" :to="{ name: 'songs' }">‹ Songs</RouterLink>
      <div>
        <h1>{{ title }}</h1>
        <div class="meta">{{ meta }}</div>
      </div>
      <div class="now">
        <div>
          <div class="lbl">Now <span class="beatDots"><i v-for="q in dotsN" :key="q" :class="{ on: q - 1 === dotsPos }"></i></span></div>
          <span class="nowChord">{{ nowChord ? show(nowChord) : '–' }}</span>
        </div>
        <div>
          <div class="lbl">Next</div>
          <span class="nextChord">{{ nextChord ? show(nextChord) : '–' }}</span> <span class="nextIn">{{ nextIn }}</span>
        </div>
      </div>
    </div>
    <div class="controls">
      <button class="play" title="Space" @click="togglePlay">{{ playing ? '❚❚ Pause' : '▶ Play' }}</button>
      <span class="time">{{ timeText }}</span>
      <input class="seek" type="range" min="0" max="1000" :value="seekVal" aria-label="Position"
        @input="onSeekInput" @change="seeking = false">
      <select title="[ and ] to change" :value="speed" @change="setSpeed(+$event.target.value)">
        <option v-for="s in SPEEDS" :key="s" :value="s">{{ Math.round(s * 100) }}%</option>
      </select>
      <button title="L" :class="{ on: loopOn }" @click="toggleLoop">{{ loopText }}</button>
      <button title="C" :class="{ on: clickOn }" @click="clickOn = !clickOn">Click</button>
      <button :disabled="!hasInst" :class="{ on: !vocalsOn && !rhythmOnly }" @click="toggleVocals"
        :title="hasInst ? 'V: mute or unmute the vocals' : 'No band-only track for this song'">
        {{ vocalsOn ? 'Vocals on' : 'Vocals off' }}
      </button>
      <button :disabled="!hasRhythm" :class="{ on: rhythmOnly }" @click="toggleRhythm"
        :title="hasRhythm ? 'B: play only the drums and bass' : 'No drums & bass track for this song'">
        Drums &amp; bass
      </button>
      <button title="F" :class="{ on: follow }" @click="follow = !follow">Follow</button>
      <button title="P" :class="{ on: sounding }" :disabled="!capo" @click="sounding = !sounding">{{ pitchText }}</button>
      <button class="syncBtn" :class="{ on: tapMode }" title="S: tap the space bar on every beat to sync" @click="toggleTapSync">
        {{ tapMode ? 'Tapping… (Esc)' : 'Tap to sync' }}
      </button>
      <span class="offbox" title="How much later the beats start than the audio">
        <span class="offlbl">Beats</span>
        <button title="Beats 10 ms earlier (− key)" @click="setTrim(trim + 0.01)">−</button>
        <span class="offVal" :class="{ nonzero: offDelay !== 0 }" :title="offTitle">{{ (offDelay > 0 ? '+' : '') + offDelay }} ms</span>
        <button title="Beats 10 ms later (+ key)" @click="setTrim(trim - 0.01)">+</button>
        <button class="offReset" title="Back to 0 ms: audio and beats start together" :disabled="offDelay === 0" @click="setTrim(0)">Reset</button>
      </span>
      <span class="syncStatus" :class="{ ok: syncOk }" :title="syncTitle">{{ syncStatus }}</span>
    </div>
    <div class="help">Click a bar, lyric line or time to jump · <kbd>Shift</kbd>+click a bar to loop from the last clicked bar ·
      <kbd>Space</kbd> play · <kbd>←</kbd>/<kbd>→</kbd> bar · <kbd>L</kbd> loop · <kbd>C</kbd> click · <kbd>V</kbd> vocals · <kbd>B</kbd> drums &amp; bass · <kbd>S</kbd> tap to sync · <kbd>−</kbd>/<kbd>+</kbd> beats 10 ms earlier/later</div>
    <div v-if="tapInfo" class="tapbanner">
      <span v-if="tapInfo.first">Tap the <b>space bar</b> on every beat, like tapping your foot.</span>
      <span v-else>{{ tapInfo.text }}</span>
      <template v-if="!tapInfo.done">
        <span class="dots"><i v-for="i in TAPS_NEEDED" :key="i" :class="{ on: i - 1 < tapInfo.count }"></i></span>
        <span class="sub">Esc to cancel</span>
      </template>
    </div>
  </header>
  <div v-if="warn" class="warn">{{ warn }}</div>
  <SongSheet v-if="layout" :layout="layout" :sounding="sounding" :cur-bar="curBar" :cur-cell="curCell" :cur-line="curLine"
    :loop="loopRange" :follow="follow" :playing="playing" @seek-bar="seekBar" @seek-line="seekLine" />
  <audio ref="audio" preload="auto" @play="onPlay" @pause="playing = false" @playing="scheduleMeasure"
    @seeked="onSeeked" @ratechange="updateOffset"></audio>
</template>

<style scoped>
header { position: sticky; top: 0; z-index: 5; background: var(--panel); border-bottom: 1px solid var(--line);
  padding: 10px 16px; }
.top { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
.back { color: var(--muted); font-size: 13px; text-decoration: none; }
.back:hover { color: var(--accent); }
.meta { color: var(--muted); font-size: 13px; }
.controls { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
button.play { min-width: 74px; font-weight: 600; }
.time { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 13px; min-width: 92px; }
.seek { flex: 1; min-width: 140px; accent-color: var(--accent); }
.now { display: flex; gap: 22px; align-items: baseline; margin-left: auto; }
.now .lbl { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.nowChord { font-size: 30px; font-weight: 700; color: var(--chord); min-width: 2.5ch; display: inline-block; }
.nextChord { font-size: 20px; font-weight: 600; }
.nextIn { font-size: 12px; color: var(--muted); }
.beatDots { display: inline-flex; gap: 4px; margin-left: 6px; vertical-align: middle; }
.beatDots i { width: 9px; height: 9px; border-radius: 50%; background: var(--line); display: inline-block; }
.beatDots i.on { background: var(--beat); }
.help { color: var(--muted); font-size: 12px; margin-top: 6px; }
.syncStatus { font-size: 12px; color: var(--muted); }
.offbox { display: inline-flex; align-items: center; gap: 4px; }
.offlbl { font-size: 12px; color: var(--muted); }
.offbox button { min-width: 30px; font-weight: 700; }
.offbox button.offReset { font-weight: 400; }
.offReset:disabled { opacity: .45; cursor: default; }
.offVal { font-variant-numeric: tabular-nums; font-size: 13px; min-width: 58px; text-align: center; }
.offVal.nonzero { color: var(--accent); font-weight: 600; }
.syncStatus.ok { color: #16a34a; }
.syncBtn.on { background: var(--accent); border-color: var(--accent); color: #fff; }
.tapbanner { margin-top: 8px; padding: 10px 14px; border-radius: 8px; background: var(--accent-soft);
  border: 1px solid var(--accent); font-size: 15px; display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
.tapbanner .dots { display: inline-flex; gap: 5px; }
.tapbanner .dots i { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--accent); display: inline-block; }
.tapbanner .dots i.on { background: var(--accent); }
.tapbanner .sub { font-size: 12px; color: var(--muted); }
kbd { font: 11px ui-monospace, monospace; border: 1px solid var(--line); border-radius: 3px; padding: 0 4px; }
</style>
