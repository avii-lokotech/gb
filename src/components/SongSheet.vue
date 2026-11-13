<script setup>
// The sheet of a song: per section, rows of time | the bars of a lyric line | that lyric line (on a narrow screen
// the lyric line goes under its bars). It draws what
// layoutSong (lib/song.js) laid out and marks where the song is; the playing is PlayerView's.
import { computed, ref, watch } from 'vue';
import { isChordToken, transposeChord } from '../lib/song.js';

const props = defineProps({
  layout: { type: Object, required: true },
  sounding: Boolean,                              // show the sounding chords instead of the shapes
  curBar: { type: Number, default: -1 },
  curCell: { type: Number, default: -1 },         // the cell of curBar the beat is in
  curLine: { type: Number, default: -1 },
  loop: { type: Array, default: null },           // [first bar, last bar] of the loop that is on
  follow: Boolean,                                // keep the current bar in view …
  playing: Boolean                                // … while playing
});
const emit = defineEmits(['seek-bar', 'seek-line']);

const root = ref(null);
const show = (c) => (props.sounding ? transposeChord(c, props.layout.capo, props.layout.flats) : c);
const cellText = (bar, cell, i) => (i === 0 && bar.carry
  ? show(bar.carry)
  : cell.tok.split('~').map((x) => (isChordToken(x) ? show(x) : x)).join(' '));
// A beat is one column of the bars' grid, so beats are equally wide everywhere and a bar is as long as its
// beats. A line holds two usual bars on a phone and four from sm:, and a row with more bars goes on over the
// next line. Written out per meter, since Tailwind only knows class names it can read here.
const COLUMNS = {
  2: 'grid-cols-4 sm:grid-cols-8',
  3: 'grid-cols-6 sm:grid-cols-12',
  4: 'grid-cols-8 sm:grid-cols-16',
  5: 'grid-cols-10 sm:grid-cols-20',
  6: 'grid-cols-12 sm:grid-cols-24',
  7: 'grid-cols-14 sm:grid-cols-28'
};
const columns = computed(() => COLUMNS[props.layout.meter] || COLUMNS[4]);
const inLoop = (k) => props.loop !== null && k >= props.loop[0] && k <= props.loop[1];
// The current bar is tinted; a bar of the loop has the loop's colour, or its outline when it is also current.
function barClass(k) {
  if (k === props.curBar) return inLoop(k) ? 'bg-accent-soft ring-2 ring-inset ring-loop-line' : 'bg-accent-soft';
  return inLoop(k) ? 'bg-loop' : '';
}
// A chord, a dot (the chord goes on), or at the start of a row the chord still ringing from the row above.
function cellClass(bar, cell, i) {
  if (i === 0 && bar.carry) return 'font-semibold text-muted';
  return cell.dot ? 'font-normal text-line' : 'font-semibold text-chord';
}

watch(() => props.curBar, (k) => {
  if (!props.follow || !props.playing || k < 0) return;
  root.value?.querySelector(`[data-bar="${k}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}, { flush: 'post' });
</script>

<template>
  <main ref="root" class="mx-auto max-w-7xl p-3 sm:p-4">
    <template v-for="(s, si) in layout.sections" :key="si">
      <div v-if="s.comment !== undefined" class="px-1.5 text-xs italic text-muted">{{ s.comment }}</div>
      <section v-else class="mb-3.5 rounded-lg border border-line bg-panel p-3 sm:px-3.5">
        <div class="mb-1.5 text-sm font-bold uppercase tracking-wider text-muted">{{ s.bpm ? `${s.label} - ${s.bpm} bpm` : s.label }}</div>
        <!-- one row = time and time signature | the bars of a lyric line | that lyric line; below xl the lyric
             line is under its bars -->
        <div v-for="(r, ri) in s.rows" :key="ri" class="flex items-start gap-3 py-1 xl:gap-4">
          <div class="w-16 shrink-0 cursor-pointer pt-2.5 text-xs tabular-nums text-muted" @click="r.bars.length && emit('seek-bar', r.bars[0].k, false)">{{ r.time }} {{ r.meter }}</div>
          <div class="grid min-w-0 flex-1 grid-cols-1 gap-x-4 gap-y-0.5 xl:grid-cols-2">
            <div class="grid content-start gap-y-1" :class="columns">
              <div v-for="bar in r.bars" :key="bar.k" :data-bar="bar.k"
                class="grid min-h-9 cursor-pointer content-center border-l-2 border-line py-0.5 last:border-r-2"
                :class="barClass(bar.k)"
                :style="{ gridColumn: 'span ' + bar.n, gridTemplateColumns: `repeat(${bar.cells.length}, minmax(0, 1fr))` }"
                @click="emit('seek-bar', bar.k, $event.shiftKey)">
                <div v-for="(cell, i) in bar.cells" :key="i" class="min-w-0 whitespace-nowrap rounded-sm px-0.5 py-1 text-xs sm:px-1 sm:text-sm"
                  :class="[cellClass(bar, cell, i), { 'outline-2 -outline-offset-2 outline-beat': bar.k === curBar && i === curCell }]">
                  {{ cellText(bar, cell, i) }}
                </div>
                <!-- strum pattern under the chords -->
                <div v-if="bar.strum" class="col-span-full grid" :style="{ gridTemplateColumns: `repeat(${bar.strum.length}, minmax(0, 1fr))` }">
                  <div v-for="(tok, i) in bar.strum" :key="i" class="whitespace-nowrap px-1 text-xs text-muted">{{ tok.replace(/~/g, ' ') }}</div>
                </div>
              </div>
            </div>
            <!-- lyrics with chords above the words -->
            <div v-if="r.chunks" class="flex min-w-0 cursor-pointer flex-wrap items-end self-start rounded-md px-1.5 py-1 hover:bg-bg"
              :class="{ 'bg-accent-soft': r.g === curLine }" @click="emit('seek-line', r.g)">
              <span v-for="(ch, i) in r.chunks" :key="i" class="inline-flex flex-col whitespace-pre">
                <span class="min-h-5 pr-1 text-sm font-bold text-chord">{{ ch.c ? show(ch.c) : '' }}</span>
                <span class="min-h-6">{{ ch.t || (ch.c ? ' ' : '') }}</span>
              </span>
            </div>
          </div>
        </div>
      </section>
    </template>
  </main>
</template>
