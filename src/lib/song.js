// A song: the ChordPro subset song2cho writes, its timing ({ beats, bars, lines }) and the layout
// of the sheet. No DOM and no state: PlayerView and SongSheet do the drawing and the playing.

/* ---------------- ChordPro parsing (subset used by song2cho) ---------------- */
const BAR_RE = /^(\|\||\|\.|\|:|:\|:|:\||\||:?\|\d+>?)([sS])?$/;

function parseAttrs(s) {
  const o = {}; const re = /(\w+)="([^"]*)"/g; let m;
  while ((m = re.exec(s))) o[m[1]] = m[2];
  return o;
}

export function parseCho(text) {
  const meta = {}; const blocks = []; let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    const d = line.match(/^\s*\{([\w-]+)(?:[:\s]\s*(.*))?\}\s*$/);
    if (d) {
      const name = d[1].toLowerCase(), arg = (d[2] || '').trim();
      const so = name.match(/^(?:start_of_|so)(grid|verse|chorus|bridge|tab|g|v|c|b)$/);
      const eo = name.match(/^(?:end_of_|eo)(grid|verse|chorus|bridge|tab|g|v|c|b)$/);
      if (so) {
        const kind = { g: 'grid', v: 'verse', c: 'chorus', b: 'bridge' }[so[1]] || so[1];
        const at = parseAttrs(arg);
        cur = { type: kind === 'grid' ? 'grid' : 'lyrics', env: kind, label: at.label || '', rows: [], lines: [] };
        blocks.push(cur);
      } else if (eo) { cur = null; }
      else if (['comment', 'c', 'comment_italic', 'ci'].includes(name)) {
        blocks.push({ type: 'comment', text: arg });
      } else { meta[name] = arg; }
      continue;
    }
    if (/^\s*#/.test(line)) continue;              // ChordPro comment
    if (cur && cur.type === 'grid') { if (line.trim()) cur.rows.push(parseGridRow(line)); continue; }
    if (cur && cur.type === 'lyrics') { if (line.trim()) cur.lines.push(parseLyric(line)); continue; }
    if (line.trim()) {                              // lyrics outside a section
      cur = null;
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'lyrics' && last.loose) last.lines.push(parseLyric(line));
      else blocks.push({ type: 'lyrics', env: 'verse', label: '', loose: true, lines: [parseLyric(line)] });
    }
  }
  return { meta, blocks };
}

function parseGridRow(line) {
  const toks = line.trim().split(/\s+/);
  const row = { bars: [], strum: false };
  let started = false, cells = null;
  for (const t of toks) {
    const m = t.match(BAR_RE);
    if (m) {
      if (m[2]) row.strum = true;
      if (cells && cells.length) row.bars.push(cells);
      cells = []; started = true; continue;
    }
    if (started) cells.push(t);                    // tokens before the first bar line: margin text
  }
  return row;                                      // cells after the last bar line: margin text
}

function parseLyric(line) {
  const chunks = []; const re = /\[([^\]]*)\]/g; let last = 0, m, chord = '';
  while ((m = re.exec(line))) {
    const txt = line.slice(last, m.index);
    if (txt || chord) chunks.push({ c: chord, t: txt });
    chord = m[1]; last = re.lastIndex;
  }
  chunks.push({ c: chord, t: line.slice(last) });
  return chunks.filter((c, i) => c.c || c.t || i === 0);
}

/* ---------------- chords ---------------- */
const SH = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FL = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
export function transposeChord(c, n, flats) {
  if (!n) return c;
  return c.replace(/(^|\/)([A-G])([#b]?)/g, (_, pre, r, acc) => {
    let i = SH.indexOf(r + acc); if (i < 0) i = FL.indexOf(r + acc); if (i < 0) return pre + r + acc;
    return pre + (flats ? FL : SH)[(i + n + 12) % 12];
  });
}
export const isChordToken = (t) => /^[A-G]/.test(t);

/* ---------------- timing ---------------- */
export function mmss(t) { t = Math.max(0, t); return Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0'); }
// which of `len` grid cells covers beat q of an n-beat bar
export function cellIdx(q, len, n) { return Math.min(len - 1, Math.floor(q * len / n)); }
export function median(arr) { const a = [...arr].sort((x, y) => x - y); return a[a.length >> 1]; }

export function barStart(sync, k) { return sync.beats[sync.bars[k][0]]; }
export function beatAt(sync, t) { // index of last beat <= t
  const b = sync.beats; let lo = 0, hi = b.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (b[m] <= t + 1e-4) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}
export function barOfBeat(sync, i) {
  const bars = sync.bars; let lo = 0, hi = bars.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (i < bars[m][0]) hi = m - 1; else if (i >= bars[m][1]) lo = m + 1; else return m; }
  return -1;
}
export function beatLen(sync) {
  return sync && sync.beats.length > 1 ? (sync.beats[sync.beats.length - 1] - sync.beats[0]) / (sync.beats.length - 1) : 0.5;
}

/* ---------------- layout ---------------- */
// The sheet of a parsed song, lined up with its timing (sync, or null):
//   capo, flats     for showing the sounding chords instead of the shapes
//   sections        [{ comment }] or [{ label, bpm, lyrics, rows }]; bpm is the section's tempo; a row is a lyric line with the bars it is sung
//                   over, or bars only: { time, meter, bars: [{ k, n, cells: [{ tok, dot }], carry, strum }], chunks, g }
//   cols            beats of the longest row: every beat is one column of the sheet
//   cellCounts[k]   cells of bar k
//   beatChord[i]    the chord sounding on beat i, as written (drives Now/Next)
//   barsMatch, linesMatch   whether the text has the bars / lyric lines the timing has
//   warns           what does not line up, for the user
export function layoutSong(song, sync) {
  const warns = [];
  const meta = song.meta;
  const capo = parseInt(meta.capo || '0', 10) || 0;
  const soundingKey = transposeChord(meta.key || 'C', capo, false);
  const flats = /^(F|Bb|Eb|Ab|Db|Gb|Dm|Gm|Cm|Fm|Bbm|Ebm)$/.test(soundingKey);

  // all bars of all grids, in order (strum rows attach to the chord row above)
  const bars = [];
  const blockRange = new Map();
  song.blocks.forEach((b) => {
    if (b.type !== 'grid') return;
    const k0 = bars.length; let rowStart = k0;
    for (const row of b.rows) {
      if (row.strum) { row.bars.forEach((cells, j) => { if (bars[rowStart + j]) bars[rowStart + j].strum = cells; }); continue; }
      rowStart = bars.length;
      row.bars.forEach((cells) => bars.push({ cells, strum: null }));
    }
    blockRange.set(b, [k0, bars.length]);
  });
  const barsMatch = !!sync && bars.length === sync.bars.length;

  // beats per bar, and the effective chord for every beat
  const beatChord = []; let prevChord = null, prevCells = null;
  bars.forEach((bar, k) => {
    const cells = bar.cells.join(' ') === '%' && prevCells ? prevCells : bar.cells;
    const bt = barsMatch ? sync.bars[k] : null;
    bar.n = bt ? bt[1] - bt[0] : cells.length;
    for (let q = 0; q < bar.n; q++) {
      const tok = cells[cellIdx(q, cells.length, bar.n)] || '.';
      const cs = tok.split('~').filter(isChordToken);
      if (cs.length) prevChord = cs[cs.length - 1];
      if (bt) beatChord[bt[0] + q] = prevChord;
    }
    prevCells = cells;
  });

  // lyric lines get a global index, matching sync.lines
  let gl = 0;
  const gLines = new Map();
  for (const b of song.blocks) if (b.type === 'lyrics') gLines.set(b, b.lines.map((chunks) => ({ chunks, g: gl++ })));
  const linesMatch = !!sync && gl === sync.lines.length;
  const timed = barsMatch && linesMatch;
  if (sync && !barsMatch) warns.push(`The song's grids have ${bars.length} bars but the recording has ${sync.bars.length}. ` +
    `Add or remove bars so the counts match — until then bars and lyrics can't be lined up.`);
  else if (sync && !linesMatch) warns.push(`The song has ${gl} lyric lines but its timing has ${sync.lines.length}; ` +
    `bars and lyric lines can't be lined up until they match again.`);
  if (!sync) warns.push('This song has no timing — playback works but nothing will be highlighted.');

  // pair each grid with the lyrics section that follows it
  const items = [];
  for (let i = 0; i < song.blocks.length; i++) {
    const b = song.blocks[i], nx = song.blocks[i + 1];
    if (b.type === 'grid' && nx && nx.type === 'lyrics' && (!nx.label || nx.label === b.label)) { items.push([b, nx]); i++; }
    else items.push([b]);
  }

  // The tempo the bars [k0, k1) of a section are played at, in beats per minute, from the recording's beats;
  // 0 when the bars are not lined up with it. A recording rarely keeps one tempo, so this can differ from the
  // song's {tempo: …}, which is its middle value.
  const bpmOf = (k0, k1) => {
    if (!barsMatch || k1 <= k0) return 0;
    const i0 = sync.bars[k0][0], i1 = Math.min(sync.beats.length - 1, sync.bars[k1 - 1][1]);
    return i1 > i0 ? Math.round(60 * (i1 - i0) / (sync.beats[i1] - sync.beats[i0])) : 0;
  };

  // A row has one time signature, shown next to its time ("1:18 2/4"): a row whose bars differ in length is cut
  // where the length changes, its lyric line staying with the first piece. The signature is the bars' beats
  // over the beat's note value of the song's {time: 4/4}. None is given to a pickup (a section's first bar,
  // shorter than the next) or to one-beat bars (a tracker's stumble or a held last chord), nor when the bars
  // are not lined up with the recording.
  const unit = (meta.time || '').match(/^\d+\/(\d+)$/)?.[1] || '4';
  const oneSignature = (rows, k0, k1) => {
    const out = [];
    for (const r of rows) {
      let from = r.k0;
      for (let k = r.k0 + 1; k <= r.k1; k++) {
        if (k < r.k1 && bars[k].n === bars[from].n) continue;
        const piece = from === r.k0 ? { ...r, k1: Math.max(k, r.k0) } : { k0: from, k1: k };
        const n = piece.k1 > piece.k0 ? bars[piece.k0].n : 0;
        const pickup = piece.k0 === k0 && k0 + 1 < k1 && n < bars[k0 + 1].n;
        piece.meter = barsMatch && n >= 2 && !pickup ? `${n}/${unit}` : '';
        out.push(piece);
        from = k;
      }
    }
    return out;
  };

  // 1. cut every section into rows: a lyric line with the bars it is sung over,
  //    or (instrumental) up to 4 bars with no lyrics
  const barOfT = (t) => { const i = beatAt(sync, t); return i < 0 ? 0 : barOfBeat(sync, i); };
  const plain = (k0, k1, out) => { for (let k = k0; k < k1; k += 4) out.push({ k0: k, k1: Math.min(k1, k + 4) }); };
  const sections = [];
  for (const parts of items) {
    if (parts[0].type === 'comment') { sections.push({ comment: parts[0].text }); continue; }
    const grid = parts[0].type === 'grid' ? parts[0] : null;
    const lyr = parts.find((p) => p.type === 'lyrics');
    const lines = lyr ? gLines.get(lyr) : [];
    const [k0, k1] = grid ? blockRange.get(grid) : [0, 0];
    const rows = [];
    if (grid && lyr && timed && lines.length) {
      const starts = lines.map(({ g }) => {
        const t = sync.lines[g][0];
        let b = Math.min(k1 - 1, Math.max(k0, barOfT(t)));
        if (beatAt(sync, t) === sync.bars[b][1] - 1 && b + 1 < k1) b++;   // first word on a bar's last beat: a pickup
        return b;
      });
      // A pickup bar (a short first bar, e.g. two beats before the first full bar) is a row of its own, so the
      // full bars below it line up — unless it is really sung: at least two words of the first line start in it.
      // One word does not count: the first word's time is often just the start of the recording.
      if (starts[0] === k0 && k0 + 1 < k1 && bars[k0].n < bars[k0 + 1].n) {
        const end = barStart(sync, k0 + 1);
        const sung = (sync.lines[lines[0].g][2] || []).filter((w) => w[0] < end - 1e-4).length;
        if (sung < 2) starts[0] = k0 + 1;
      }
      for (let i = 1; i < starts.length; i++) starts[i] = Math.min(k1 - 1, Math.max(starts[i], starts[i - 1] + 1));
      if (starts[0] > k0) plain(k0, starts[0], rows);
      lines.forEach(({ chunks, g }, i) => {
        let end = i + 1 < starts.length ? starts[i + 1] : k1, tail = null;
        if (i + 1 === starts.length) {                // long instrumental after the last line: own rows
          const words = sync.lines[g][2] || [];
          const lastBar = barOfT(words.length ? words[words.length - 1][0] : sync.lines[g][1]);
          if (end - (lastBar + 1) >= 2) { tail = [lastBar + 1, end]; end = lastBar + 1; }
        }
        rows.push({ k0: starts[i], k1: Math.max(end, starts[i] + 1), chunks, g });
        if (tail) plain(tail[0], tail[1], rows);
      });
    } else {                                          // not lined up: bars first, then the lyrics
      if (grid) plain(k0, k1, rows);
      if (lyr) lines.forEach(({ chunks, g }) => rows.push({ k0: 0, k1: 0, chunks, g }));
    }
    sections.push({ label: parts[0].label || parts[0].env || '', bpm: grid ? bpmOf(k0, k1) : 0,
      rows: grid ? oneSignature(rows, k0, k1) : rows, lyrics: !!lyr });
  }

  // 2. one width for every beat: the grid has as many columns as the longest row has beats
  const rowBeats = (r) => { let n = 0; for (let k = r.k0; k < r.k1; k++) n += bars[k].n; return n; };
  let cols = 4;
  for (const s of sections) for (const r of s.rows || []) cols = Math.max(cols, rowBeats(r));

  // 3. what to draw for every row
  for (const s of sections) {
    for (const r of s.rows || []) {
      r.time = r.k1 > r.k0 && barsMatch ? mmss(barStart(sync, r.k0)) : '';
      r.bars = [];
      for (let k = r.k0; k < r.k1; k++) {
        const bar = bars[k];
        const cells = bar.cells.map((tok) => ({ tok, dot: tok === '.' || tok === '/' }));
        // the chord still ringing from the row above, shown in place of the row's first dot
        const carry = k === r.k0 && cells[0]?.dot && barsMatch ? beatChord[sync.bars[k][0]] || null : null;
        r.bars.push({ k, n: bar.n, cells, carry, strum: bar.strum });
      }
    }
  }

  return { capo, flats, sections, cols, cellCounts: bars.map((b) => b.cells.length), beatChord, barsMatch, linesMatch, warns };
}
