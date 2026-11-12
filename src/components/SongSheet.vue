<script setup>
// The sheet of a song: per section, rows of time | the bars of a lyric line | that lyric line. It draws what
// layoutSong (lib/song.js) laid out and marks where the song is; the playing is PlayerView's.
import { ref, watch } from 'vue';
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
const inLoop = (k) => props.loop !== null && k >= props.loop[0] && k <= props.loop[1];
// The current bar is tinted; a bar of the loop has the loop's colour, or its outline when it is also current.
function barClass(k) {
  if (k === props.curBar) return inLoop(k) ? 'bg-accent-soft shadow-[inset_0_0_0_2px_var(--loop-line)]' : 'bg-accent-soft';
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
  <main ref="root" class="mx-auto max-w-[1200px] p-4" :style="{ '--cols': layout.cols }">
    <template v-for="(s, si) in layout.sections" :key="si">
      <div v-if="s.comment !== undefined" class="px-1.5 text-12 italic text-muted">{{ s.comment }}</div>
      <section v-else class="mb-3.5 rounded-[10px] border border-line bg-panel px-3.5 py-3">
        <div class="mb-1.5 text-13 font-bold uppercase tracking-[.05em] text-muted">{{ [s.label, s.meter, s.bpm ? `${s.bpm} bpm` : ''].filter(Boolean).join(' - ') }}</div>
        <!-- one row = time | the bars of a lyric line | that lyric line -->
        <div v-for="(r, ri) in s.rows" :key="ri"
          class="grid grid-cols-[44px_minmax(0,1.15fr)_minmax(0,1fr)] items-center gap-x-[18px] py-[3px] max-[900px]:grid-cols-[44px_minmax(0,1fr)] max-[900px]:gap-y-0.5">
          <div class="cursor-pointer self-center text-12 tabular-nums text-muted" @click="r.bars.length && emit('seek-bar', r.bars[0].k, false)">{{ r.time }}</div>
          <!-- every beat is one column, so all beats are equally wide and bars are as long as their beats -->
          <div class="grid grid-cols-[repeat(var(--cols,16),minmax(0,1fr))] self-stretch">
            <div v-for="bar in r.bars" :key="bar.k" :data-bar="bar.k"
              class="grid min-h-[34px] cursor-pointer content-center border-l-2 border-line py-0.5 last:border-r-2"
              :class="barClass(bar.k)"
              :style="{ gridColumn: 'span ' + bar.n, gridTemplateColumns: `repeat(${bar.cells.length}, minmax(0, 1fr))` }"
              @click="emit('seek-bar', bar.k, $event.shiftKey)">
              <div v-for="(cell, i) in bar.cells" :key="i" class="min-w-0 overflow-hidden whitespace-nowrap rounded px-[3px] py-1 text-14"
                :class="[cellClass(bar, cell, i), { 'outline outline-2 -outline-offset-2 outline-beat': bar.k === curBar && i === curCell }]">
                {{ cellText(bar, cell, i) }}
              </div>
              <!-- strum pattern under the chords -->
              <div v-if="bar.strum" class="col-span-full grid" :style="{ gridTemplateColumns: `repeat(${bar.strum.length}, minmax(0, 1fr))` }">
                <div v-for="(tok, i) in bar.strum" :key="i" class="overflow-hidden whitespace-nowrap px-[3px] text-12 text-muted">{{ tok.replace(/~/g, ' ') }}</div>
              </div>
            </div>
          </div>
          <!-- lyrics with chords above the words -->
          <template v-if="s.lyrics">
            <div v-if="r.chunks" class="flex min-w-0 cursor-pointer flex-wrap items-end rounded-md px-1.5 py-[3px] hover:bg-bg max-[900px]:col-start-2"
              :class="{ 'bg-accent-soft': r.g === curLine }" @click="emit('seek-line', r.g)">
              <span v-for="(ch, i) in r.chunks" :key="i" class="inline-flex flex-col whitespace-pre">
                <span class="min-h-[1.2em] pr-1 text-13 font-bold text-chord">{{ ch.c ? show(ch.c) : '' }}</span>
                <span class="min-h-[1.3em]">{{ ch.t || (ch.c ? ' ' : '') }}</span>
              </span>
            </div>
            <div v-else class="flex min-w-0 flex-wrap items-end rounded-md px-1.5 py-[3px] max-[900px]:col-start-2"></div>
          </template>
        </div>
      </section>
    </template>
  </main>
</template>
