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

watch(() => props.curBar, (k) => {
  if (!props.follow || !props.playing || k < 0) return;
  root.value?.querySelector(`[data-bar="${k}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}, { flush: 'post' });
</script>

<template>
  <main ref="root" :style="{ '--cols': layout.cols }">
    <template v-for="(s, si) in layout.sections" :key="si">
      <div v-if="s.comment !== undefined" class="cmt">{{ s.comment }}</div>
      <section v-else class="section">
        <div class="label">{{ s.label }}</div>
        <div v-for="(r, ri) in s.rows" :key="ri" class="srow">
          <div class="margin" @click="r.bars.length && emit('seek-bar', r.bars[0].k, false)">{{ r.time }}</div>
          <div class="bars">
            <div v-for="bar in r.bars" :key="bar.k" class="bar" :data-bar="bar.k"
              :class="{ cur: bar.k === curBar, inloop: inLoop(bar.k) }"
              :style="{ gridColumn: 'span ' + bar.n, gridTemplateColumns: `repeat(${bar.cells.length}, minmax(0, 1fr))` }"
              @click="emit('seek-bar', bar.k, $event.shiftKey)">
              <div v-for="(cell, i) in bar.cells" :key="i" class="cell"
                :class="{ carry: i === 0 && bar.carry, dot: cell.dot && !(i === 0 && bar.carry), beat: bar.k === curBar && i === curCell }">
                {{ cellText(bar, cell, i) }}
              </div>
              <!-- strum pattern under the chords -->
              <div v-if="bar.strum" class="strumrow" :style="{ gridTemplateColumns: `repeat(${bar.strum.length}, minmax(0, 1fr))` }">
                <div v-for="(tok, i) in bar.strum" :key="i" class="strum">{{ tok.replace(/~/g, ' ') }}</div>
              </div>
            </div>
          </div>
          <template v-if="s.lyrics">
            <div v-if="r.chunks" class="ln line" :class="{ cur: r.g === curLine }" @click="emit('seek-line', r.g)">
              <span v-for="(ch, i) in r.chunks" :key="i" class="chunk">
                <span class="c">{{ ch.c ? show(ch.c) : '' }}</span>
                <span class="t">{{ ch.t || (ch.c ? ' ' : '') }}</span>
              </span>
            </div>
            <div v-else class="ln"></div>
          </template>
        </div>
      </section>
    </template>
  </main>
</template>

<style scoped>
main { max-width: 1200px; margin: 0 auto; padding: 16px; }
.section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px;
  margin-bottom: 14px; }
.label { font-weight: 700; font-size: 13px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted);
  margin-bottom: 6px; }
/* one row = time | the bars of a lyric line | that lyric line */
.srow { display: grid; grid-template-columns: 44px minmax(0, 1.15fr) minmax(0, 1fr); column-gap: 18px;
  align-items: center; padding: 3px 0; }
@media (max-width: 900px) {
  .srow { grid-template-columns: 44px minmax(0, 1fr); row-gap: 2px; }
  .srow .ln { grid-column: 2; }
}
.margin { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; cursor: pointer; align-self: center; }
/* every beat is one column, so all beats are equally wide and bars are as long as their beats */
.bars { display: grid; grid-template-columns: repeat(var(--cols, 16), minmax(0, 1fr)); align-self: stretch; }
.bar { display: grid; border-left: 2px solid var(--line); padding: 2px 0; cursor: pointer; min-height: 34px;
  align-content: center; }
.bar:last-child { border-right: 2px solid var(--line); }
.bar.cur { background: var(--accent-soft); }
.bar.inloop { background: var(--loop); }
.bar.cur.inloop { background: var(--accent-soft); box-shadow: inset 0 0 0 2px var(--loop-line); }
.cell { padding: 4px 3px; font-weight: 600; color: var(--chord); font-size: 14px;
  border-radius: 4px; min-width: 0; overflow: hidden; white-space: nowrap; }
.cell.dot { color: var(--line); font-weight: 400; }
.cell.carry { color: var(--muted); }
.cell.beat { outline: 2px solid var(--beat); outline-offset: -2px; }
.strumrow { grid-column: 1 / -1; display: grid; }
.strum { font-size: 12px; color: var(--muted); white-space: nowrap; padding: 0 3px; overflow: hidden; }
/* lyrics with chords above the words */
.ln { padding: 3px 6px; border-radius: 6px; display: flex; flex-wrap: wrap; align-items: flex-end; min-width: 0; }
.ln.line { cursor: pointer; }
.ln.line:hover { background: var(--bg); }
.ln.cur { background: var(--accent-soft); }
.chunk { display: inline-flex; flex-direction: column; white-space: pre; }
.chunk .c { color: var(--chord); font-weight: 700; font-size: 13px; min-height: 1.2em; padding-right: 4px; }
.chunk .t { min-height: 1.3em; }
.cmt { color: var(--muted); font-size: 12px; font-style: italic; padding: 0 6px; }
</style>
