// A song: the ChordPro subset song2cho writes, with its timing in the text, and the layout of the sheet.
// No DOM and no state: PlayerView and SongSheet do the drawing and the playing.
//
// Timing is three directives of our own (ChordPro leaves x_… to extensions; other tools skip them), with every
// time in whole milliseconds from the start of the recording:
//   {x_bars: 26160 28720 31320}   before a grid row: when each bar of that row starts
//   {x_line: 26400 31100}         before a lyric line: when it is sung, start and end
//   {x_words: 26400 26900 27450}  after it, optional: when each word of that line starts
//   {x_end: 140300}               once: when the last bar ends
// A bar has as many beats as it has cells (| . . | is two beats), evenly spaced from its start to the next
// bar's start. So the text alone says what is played and when.

/* ---------------- ChordPro parsing (subset used by song2cho) ---------------- */
const BAR_RE = /^(\|\||\|\.|\|:|:\|:|:\||\||:?\|\d+>?)([sS])?$/;

function parseAttrs(s) {
  const o = {}; const re = /(\w+)="([^"]*)"/g; let m;
  while ((m = re.exec(s))) o[m[1]] = m[2];
  return o;
}

export function parseCho(text) {
  const meta = {}; const blocks = []; let cur = null;
  let barTimes = null, lineTime = null, wordTimes = null;   // {x_bars} / {x_line} / {x_words} waiting for their row / line
  const times = (arg) => arg.split(/\s+/).filter(Boolean).map((v) => (/^\d+$/.test(v) ? +v / 1000 : NaN));
  const lyric = (block, line) => {
    block.lines.push(parseLyric(line)); block.times.push(lineTime); block.words.push(wordTimes);
    lineTime = wordTimes = null;
  };
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
        cur = { type: kind === 'grid' ? 'grid' : 'lyrics', env: kind, label: at.label || '', rows: [], lines: [], times: [], words: [] };
        blocks.push(cur);
      } else if (eo) { cur = null; }
      else if (name === 'x_bars') { barTimes = times(arg); }
      else if (name === 'x_line') { lineTime = times(arg); }
      else if (name === 'x_words') { wordTimes = times(arg); }
      else if (['comment', 'c', 'comment_italic', 'ci'].includes(name)) {
        blocks.push({ type: 'comment', text: arg });
      } else { meta[name] = arg; }
      continue;
    }
    if (/^\s*#/.test(line)) continue;              // ChordPro comment
    if (cur && cur.type === 'grid') {
      if (!line.trim()) continue;
      const row = parseGridRow(line);
      if (!row.strum) { row.times = barTimes; barTimes = null; }   // a strum row belongs to the chord row above
      cur.rows.push(row); continue;
    }
    if (cur && cur.type === 'lyrics') { if (line.trim()) lyric(cur, line); continue; }
    if (line.trim()) {                              // lyrics outside a section
      cur = null;
      let last = blocks[blocks.length - 1];
      if (!(last && last.type === 'lyrics' && last.loose)) {
        last = { type: 'lyrics', env: 'verse', label: '', loose: true, lines: [], times: [], words: [] };
        blocks.push(last);
      }
      lyric(last, line);
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
// A song converted before the timing was in the text has it apart, as { beats, bars, lines } in seconds. This
// writes that timing into the text as directives, so there is one kind of song from here on. The text comes
// back as it is when it has timing already, has none to add, or no longer has the bars and lines that timing
// was made for.
export function withTiming(cho, sync) {
  if (!sync || /^\s*\{x_bars[:\s]/m.test(cho)) return cho;
  const ms = (t) => Math.round(t * 1000);
  const out = []; let env = null, k = 0, g = 0;
  for (const raw of cho.split(/\r?\n/)) {
    const d = raw.match(/^\s*\{([\w-]+)/);
    if (d) {
      const name = d[1].toLowerCase();
      const so = name.match(/^(?:start_of_|so)(grid|verse|chorus|bridge|tab|g|v|c|b)$/);
      if (so) env = so[1] === 'grid' || so[1] === 'g' ? 'grid' : 'lyrics';
      else if (/^(?:end_of_|eo)/.test(name)) env = null;
    } else if (raw.trim() && !/^\s*#/.test(raw)) {
      if (env === 'grid') {
        const row = parseGridRow(raw);
        if (!row.strum) {
          const starts = row.bars.map(() => sync.bars[k] && ms(sync.beats[sync.bars[k++][0]]));
          if (starts.some((t) => t === undefined)) return cho;
          out.push(`{x_bars: ${starts.join(' ')}}`);
        }
      } else {
        const ln = sync.lines[g++];
        if (!ln) return cho;
        out.push(`{x_line: ${ms(ln[0])} ${ms(ln[1])}}`);
        if (ln[2] && ln[2].length) out.push(`{x_words: ${ln[2].map((w) => ms(w[0])).join(' ')}}`);
      }
    }
    out.push(raw);
  }
  if (k !== sync.bars.length || g !== sync.lines.length) return cho;
  const b = sync.beats;
  out.push(`{x_end: ${ms(b[b.length - 1] + (b.length > 1 ? (b[b.length - 1] - b[0]) / (b.length - 1) : 2))}}`);
  return out.join('\n');
}

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
// The sheet of a parsed song, lined up with the timing its text gives. barsPerLine: how many bars of the usual
// length a line of the sheet holds (SongSheet: two on a phone, four from sm:); a row is cut to fit.
//   sync            that timing, for playing: { beats: [s], bars: [[first beat, beat after last]], lines:
//                   [[start s, end s, word starts s or null]] }; null when the grid rows do not all have their
//                   bar times
//   capo, flats     for showing the sounding chords instead of the shapes
//   sections        [{ comment }] or [{ label, bpm, rows }]; bpm is the section's tempo; a row is a lyric line with the bars it is sung
//                   over, or bars only: { time, meter, bars: [{ k, n, cells: [{ tok, dot }], carry, strum }], chunks, g }
//   meter           beats of the song's usual bar, from {time: 4/4}: the sheet draws so many columns per bar
//   lines           the lyric lines, whole: [{ g, chunks }] (a row has only the part sung over its bars)
//   cellCounts[k]   cells of bar k
//   beatChord[i]    the chord sounding on beat i, as written (drives Now/Next)
//   barsMatch, linesMatch   whether the bars / the lyric lines have their times
//   warns           what does not line up, for the user
export function layoutSong(song, { barsPerLine = 4 } = {}) {
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
      row.bars.forEach((cells, j) => bars.push({ cells, strum: null, start: row.times ? row.times[j] : undefined,
        untimedRow: !row.times, miscounted: !!row.times && row.times.length !== row.bars.length }));
    }
    blockRange.set(b, [k0, bars.length]);
  });

  // The timing, from the bars' start times: a bar's beats are evenly spaced up to the next bar's start.
  let sync = null;
  const barStarts = bars.map((b) => b.start);
  const late = barStarts.findIndex((t, k) => k > 0 && !(t > barStarts[k - 1]));
  if (!bars.length || bars.every((b) => b.untimedRow)) {
    warns.push('This song has no timing — playback works but nothing will be highlighted.');
  } else if (bars.some((b) => b.untimedRow)) {
    warns.push('Some grid rows have no {x_bars: …} line before them. Every row needs the start time of each of its bars, in ms.');
  } else if (bars.some((b) => b.miscounted)) {
    warns.push(`An {x_bars: …} line must have one time for each bar of its row (near bar ${bars.findIndex((b) => b.miscounted) + 1}).`);
  } else if (!barStarts.every(Number.isFinite)) {
    warns.push(`The times of {x_bars: …} must be whole milliseconds (bar ${barStarts.findIndex((t) => !Number.isFinite(t)) + 1}).`);
  } else if (late >= 0) {
    warns.push(`Bar ${late + 1} must start after bar ${late}: its time in {x_bars: …} is not later.`);
  } else {
    const given = (meta.x_end || '').trim();
    let end = /^\d+$/.test(given) ? +given / 1000 : NaN;
    const lastStart = barStarts[barStarts.length - 1];
    if (!(end > lastStart)) end = lastStart + (barStarts.length > 1 ? lastStart - barStarts[barStarts.length - 2] : 2);
    sync = { beats: [], bars: [], lines: [] };
    let prev = null;
    bars.forEach((bar, k) => {
      const n = (bar.cells.join(' ') === '%' && prev ? prev : bar.cells).length || 1;
      const from = barStarts[k], to = k + 1 < bars.length ? barStarts[k + 1] : end;
      sync.bars.push([sync.beats.length, sync.beats.length + n]);
      for (let q = 0; q < n; q++) sync.beats.push(Math.round((from + q * (to - from) / n) * 1000) / 1000);
      prev = bar.cells.join(' ') === '%' && prev ? prev : bar.cells;
    });
  }
  const barsMatch = !!sync;

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

  // lyric lines get a global index, and their times
  let gl = 0;
  const gLines = new Map(), lineTimes = [];
  for (const b of song.blocks) {
    if (b.type !== 'lyrics') continue;
    gLines.set(b, b.lines.map((chunks, i) => {
      const t = b.times[i], w = b.words[i];
      lineTimes.push(t && t.length === 2 ? [t[0], t[1], w && w.every(Number.isFinite) ? w : null] : t);
      return { chunks, g: gl++ };
    }));
  }
  const badLine = lineTimes.findIndex((t) => !(t && t.length === 3 && t[0] >= 0 && t[1] >= t[0]));
  const linesMatch = !!sync && badLine < 0;
  if (linesMatch) sync.lines = lineTimes;
  else if (sync) warns.push(`Lyric line ${badLine + 1} has no {x_line: start end} line before it (times in ms, the end not before ` +
    `the start). Until every line has one, the lyrics can't be lined up with the bars.`);
  const timed = barsMatch && linesMatch;

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

  // A row is one line of the sheet. It has one time signature, shown next to its time ("1:18 2/4"), and no
  // more bars than a line holds (barsPerLine of the usual length, counted in beats: the same number SongSheet
  // has columns for), so its bars never wrap and its words stay beside the bars they are sung over. A row that
  // changes signature or is too long is cut into pieces, and its lyric line with it: every word goes to the
  // piece whose bars it is sung in — by its time ({x_words}), or with the words spread evenly over the line.
  // The signature is the bars' beats over the beat's note value of the song's {time: 4/4}. None is given to a
  // pickup (a section's first bar, shorter than the next) or to one-beat bars (a tracker's stumble or a held
  // last chord), nor when the bars are not lined up with the recording.
  const time = (meta.time || '').match(/^(\d+)\/(\d+)$/);   // {time: 4/4}: beats in a usual bar / the beat's note value
  const unit = time?.[2] || '4';
  const meter = time ? +time[1] : 4;
  const room = barsPerLine * (meter >= 2 && meter <= 7 ? meter : 4);   // beats a line holds
  // The words of a lyric line, each with the chord written before it: [{ c, t, word }]. A chord with no word
  // after it (at the end of a line) is an entry of its own, word false.
  const wordsOf = (chunks) => chunks.flatMap((ch) => {
    const parts = ch.t.match(/\s*\S+\s*/g) || [ch.t];
    return parts.map((t, i) => ({ c: i === 0 ? ch.c : '', t, word: /\S/.test(t) }));
  });
  const oneLine = (rows, k0, k1) => {
    const out = [];
    for (const r of rows) {
      if (r.k1 <= r.k0) { out.push(r); continue; }       // a lyric line that is not lined up with bars
      const pieces = [];
      let from = r.k0, beats = bars[r.k0].n;
      for (let k = r.k0 + 1; k <= r.k1; k++) {
        if (k < r.k1 && bars[k].n === bars[from].n && beats + bars[k].n <= room) { beats += bars[k].n; continue; }
        const piece = { k0: from, k1: k };
        const n = bars[from].n;
        const pickup = from === k0 && k0 + 1 < k1 && n < bars[k0 + 1].n;
        piece.meter = barsMatch && n >= 2 && !pickup ? `${n}/${unit}` : '';
        pieces.push(piece);
        from = k; beats = k < r.k1 ? bars[k].n : 0;
      }
      if (r.chunks) {
        const words = wordsOf(r.chunks), sung = words.filter((w) => w.word).length;
        const [start, end, given] = sync.lines[r.g];
        const at = given && given.length === sung ? given : Array.from({ length: sung }, (_, n) => start + n * (end - start) / sung);
        let n = 0, p = 0;
        for (const w of words) {
          if (w.word) {
            const k = barOfBeat(sync, Math.max(0, beatAt(sync, at[n++])));
            while (p + 1 < pieces.length && k >= pieces[p + 1].k0) p++;   // words are in time order: never back
          }
          const piece = pieces[p];
          piece.g = r.g;
          if (!piece.chunks) piece.chunks = [];
          const last = piece.chunks[piece.chunks.length - 1];
          if (last && !w.c) last.t += w.t; else piece.chunks.push({ c: w.c, t: w.t });
        }
      }
      out.push(...pieces);
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
      // full bars below it line up; the first line starts with the bar after it.
      if (starts[0] === k0 && k0 + 1 < k1 && bars[k0].n < bars[k0 + 1].n) starts[0] = k0 + 1;
      for (let i = 1; i < starts.length; i++) starts[i] = Math.min(k1 - 1, Math.max(starts[i], starts[i - 1] + 1));
      if (starts[0] > k0) plain(k0, starts[0], rows);
      lines.forEach(({ chunks, g }, i) => {
        let end = i + 1 < starts.length ? starts[i + 1] : k1, tail = null;
        if (i + 1 === starts.length) {                // long instrumental after the last line: own rows
          const lastBar = barOfT(sync.lines[g][1]);
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
      rows: grid ? oneLine(rows, k0, k1) : rows });
  }

  // 2. what to draw for every row
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

  return { sync, capo, flats, meter, lines: [...gLines.values()].flat(), sections, cellCounts: bars.map((b) => b.cells.length), beatChord, barsMatch, linesMatch, warns };
}
