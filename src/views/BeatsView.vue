<script setup>
// The beats page: only a player, and under it the song two bars to a line — every beat of the bars, and to the
// right of them, as plain text, the words sung in those bars: a lyric line that goes on over the next bars goes on
// on the next line. For checking that the bars, the beats and the
// words are where the recording has them; the full sheet, with chords over the words and all the practice tools,
// is PlayerView.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import AppButton from '../components/AppButton.vue';
import AppNotice from '../components/AppNotice.vue';
import { api, errorMessage } from '../lib/api';
import { barOfBeat, barStart, beatAt, layoutSong, mmss, parseCho, withTiming } from '../lib/song.js';

const props = defineProps({ id: { type: Number, required: true } }); // the song's id

const audio = ref(null);
const list = ref(null);
const title = ref('Loading…');
const warn = ref('');
const bars = shallowRef([]);      // [{ k, time, label, cells: [chord or ''], lines: [the words of a lyric line sung in it] }]
const playing = ref(false);
const timeText = ref('0:00 / 0:00');
const seekVal = ref(0);
const curBar = ref(-1), curBeat = ref(-1);   // the bar that is playing, and the beat of it, counted from 0
let sync = null, seeking = false, gone = false, frame = 0, url = '';

// Two bars to a line; a section starts a new line.
const rows = computed(() => {
  const out = [];
  for (const bar of bars.value) {
    const last = out[out.length - 1];
    if (!last || bar.label || last.bars.length === 2) out.push({ label: bar.label, time: bar.time, bars: [bar] });
    else last.bars.push(bar);
  }
  // the words of one lyric line sung in the line's two bars are one text; another lyric line is another
  for (const row of out) {
    const [a, b] = row.bars;
    row.texts = b && a.lines.length && b.lines.length && b.continues
      ? [...a.lines.slice(0, -1), `${a.lines[a.lines.length - 1]} ${b.lines[0]}`, ...b.lines.slice(1)]
      : [...a.lines, ...(b ? b.lines : [])];
  }
  return out;
});

// One entry per bar, from the sheet's layout: its beats (a cell's chord on the beat it starts on) and, of each
// lyric line, the words that start in it, without their chords. A word is where its time puts it ({x_words});
// a line without word times, or with other words than times, has its words spread evenly over its length.
function barsOf(layout) {
  const out = [];
  for (const s of layout.sections) {
    for (const r of s.rows || []) {
      for (const bar of r.bars) {
        const chordOn = new Map(bar.cells.map((c, i) => [Math.floor(i * bar.n / bar.cells.length), c.dot ? '' : c.tok.replace(/~/g, ' ')]));
        out[bar.k] = {
          k: bar.k,
          time: mmss(barStart(sync, bar.k)),
          label: '',
          cells: Array.from({ length: bar.n }, (_, q) => chordOn.get(q) || ''),
          lines: [],
          continues: false          // its first text goes on from the bar before: the same lyric line
        };
      }
      if (r.bars.length && r === s.rows[0]) out[r.bars[0].k].label = s.label;
    }
  }
  for (const line of layout.linesMatch ? layout.lines : []) {
    {
      const words = line.chunks.map((c) => c.t).join('').trim().split(/\s+/).filter(Boolean);
      const [start, end, given] = sync.lines[line.g];
      const at = given && given.length === words.length ? given : words.map((_, n) => start + n * (end - start) / words.length);
      const perBar = new Map();
      words.forEach((word, n) => {
        const k = barOfBeat(sync, Math.max(0, beatAt(sync, at[n])));
        if (out[k]) perBar.set(k, [...(perBar.get(k) || []), word]);
      });
      for (const [k, sung] of perBar) {
        if (perBar.has(k - 1) && out[k].lines.length === 0) out[k].continues = true;
        out[k].lines.push(sung.join(' '));
      }
    }
  }
  return out.filter(Boolean);
}

async function load() {
  try {
    const data = await api.getSong(props.id);
    if (gone) return;
    title.value = data.title;
    document.title = `${data.title} – Beats`;
    if (data.status !== 'ready' || !data.cho) { warn.value = 'This song is not converted yet.'; return; }
    const layout = layoutSong(parseCho(withTiming(data.cho, data.sync)));
    sync = layout.sync;
    warn.value = layout.warns.join(' ');
    if (sync) bars.value = barsOf(layout);
    // loaded as a blob: the audio needs the session token, which an <audio> element cannot send
    const blob = await api.songAudio(props.id, 'mix');
    if (gone) return;
    url = URL.createObjectURL(blob);
    audio.value.src = url;
  } catch (e) {
    if (!gone) warn.value = errorMessage(e);
  }
}

/* The position in the song is audio.currentTime, less the time the sound takes to reach the speakers, plus the
   beat offset set in the full player for this song on this device (its "Beats" −/+ and tap to sync). */
let ctx = null;
const TRIM_KEY = 'guitarbook.tapsync:song:' + props.id;
function offset() {
  let trim = 0;
  try { trim = +localStorage.getItem(TRIM_KEY) || 0; } catch (e) { /* storage blocked */ }
  const latency = ctx ? (ctx.baseLatency || 0) + (ctx.outputLatency || 0) : 0;
  return trim - latency * (audio.value?.playbackRate || 1);
}
function togglePlay() {
  const el = audio.value;
  if (!el.paused) { el.pause(); return; }
  if (!ctx) {
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      ctx.createMediaElementSource(el).connect(ctx.destination);
    } catch (e) { ctx = null; }
  }
  ctx?.resume();
  el.play();
}
function seekBar(k) {
  if (sync) audio.value.currentTime = Math.max(0, barStart(sync, k) - offset());
}
function onSeekInput(e) {
  seeking = true; seekVal.value = +e.target.value;
  const el = audio.value; if (el.duration) el.currentTime = seekVal.value / 1000 * el.duration;
}

function tick() {
  frame = requestAnimationFrame(tick);
  const el = audio.value; if (!el) return;
  const at = el.currentTime, dur = el.duration || 0;
  timeText.value = mmss(at) + ' / ' + mmss(dur);
  if (!seeking) seekVal.value = dur ? Math.round(at / dur * 1000) : 0;
  if (!sync) return;
  const i = beatAt(sync, at + offset());
  const k = i >= 0 ? barOfBeat(sync, i) : -1;
  curBar.value = k;
  curBeat.value = k >= 0 ? i - sync.bars[k][0] : -1;
}

// Keep the bar that is playing in view.
watch(curBar, (k) => {
  if (playing.value && k >= 0) list.value?.querySelector(`[data-bar="${k}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}, { flush: 'post' });

function onKey(e) {
  if (e.target.matches('input, select, textarea') || e.metaKey || e.ctrlKey) return;
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
}

onMounted(() => {
  document.addEventListener('keydown', onKey);
  load();
  frame = requestAnimationFrame(tick);
});
onBeforeUnmount(() => {
  gone = true;
  document.removeEventListener('keydown', onKey);
  cancelAnimationFrame(frame);
  audio.value?.pause();
  if (url) URL.revokeObjectURL(url);
  if (ctx) ctx.close();
});
</script>

<template>
  <header class="sticky top-0 z-10 border-b border-line bg-panel px-3 py-2.5 sm:px-4">
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
      <RouterLink class="text-sm text-muted no-underline hover:text-accent" :to="{ name: 'songs' }">‹ Songs</RouterLink>
      <h1 class="min-w-0 text-lg font-bold">{{ title }}</h1>
      <RouterLink class="ml-auto text-sm text-muted no-underline hover:text-accent" :to="{ name: 'player', query: { id } }">Sheet ›</RouterLink>
    </div>
    <div class="mt-2 flex items-center gap-1.5">
      <AppButton class="min-w-20 font-semibold" title="Space" @click="togglePlay">{{ playing ? '❚❚ Pause' : '▶ Play' }}</AppButton>
      <span class="min-w-24 text-sm tabular-nums text-muted">{{ timeText }}</span>
      <input class="min-w-0 flex-1 accent-accent" type="range" min="0" max="1000" :value="seekVal" aria-label="Position"
        @input="onSeekInput" @change="seeking = false">
    </div>
  </header>
  <AppNotice v-if="warn">{{ warn }}</AppNotice>
  <!-- one line per two bars: when the first starts | their beats, a chord in the beat it starts on | the words
       sung in them (under the bars on a phone) -->
  <main ref="list" class="mx-auto max-w-4xl p-3 sm:p-4">
    <template v-for="row in rows" :key="row.bars[0].k">
      <h2 v-if="row.label" class="mb-1 mt-4 text-sm font-bold uppercase tracking-wider text-muted first:mt-0">{{ row.label }}</h2>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-1.5 py-1 sm:flex-nowrap"
        :class="{ 'bg-accent-soft': row.bars.some((bar) => bar.k === curBar) }">
        <span class="w-10 shrink-0 text-xs tabular-nums text-muted">{{ row.time }}</span>
        <span class="grid min-w-0 flex-1 grid-cols-2 gap-2 sm:w-96 sm:flex-none lg:w-lg">
          <span v-for="bar in row.bars" :key="bar.k" :data-bar="bar.k" class="flex min-w-0 cursor-pointer gap-0.5" @click="seekBar(bar.k)">
            <span v-for="(chord, q) in bar.cells" :key="q"
              class="flex h-8 min-w-0 flex-1 items-center justify-center whitespace-nowrap rounded-sm border border-line text-sm font-semibold text-chord"
              :class="{ 'outline-2 -outline-offset-2 outline-beat': bar.k === curBar && q === curBeat }">{{ chord }}</span>
          </span>
        </span>
        <span class="min-w-0 basis-full pl-12 sm:basis-auto sm:pl-0">
          <span v-for="(text, i) in row.texts" :key="i" class="block">{{ text }}</span>
        </span>
      </div>
    </template>
  </main>
  <audio ref="audio" preload="auto" @play="playing = true" @pause="playing = false"></audio>
</template>
