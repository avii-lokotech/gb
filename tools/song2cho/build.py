"""Assemble a draft ChordPro file from beats.json, chords.json and lyrics.json.

usage: build.py WORKDIR OUT.cho --title T --artist A --audio PATH [--instrumental PATH] [--rhythm PATH] [--capo auto|N]
"""
import argparse, difflib, json, os, re
from collections import Counter
import numpy as np
from notes import SHARP, FLAT

OPEN_SHAPES = {"C", "D", "E", "G", "A", "Am", "Em", "Dm", "E7", "A7", "D7", "G7", "C7", "B7"}
EASY_BARRE = {"F", "Bm", "Fm", "Bb", "B", "F#m", "Cm", "Gm"}


def parse_chord(c):
    m = re.match(r"^([A-G][#b]?)(.*)$", c)
    return m.group(1), m.group(2)


def transpose(c, semis):
    if c == "N":
        return c
    root, q = parse_chord(c)
    i = (SHARP.index(root) if root in SHARP else FLAT.index(root))
    return SHARP[(i + semis) % 12] + q


def shape_cost(chords, capo):
    cost = 0
    for c, n in chords.items():
        s = transpose(c, -capo)
        cost += n * (0 if s in OPEN_SHAPES else 1 if s in EASY_BARRE else 3)
    return cost


def mmss(t):
    return "%d:%02d" % (int(t) // 60, int(t) % 60)


def clean_beat_chords(lab, conf, bar_last_beats=(), thr=0.75):
    """Drop 1-beat blips with low confidence; fill 'N' with neighbours.
    Beats in bar_last_beats holding a 1-beat chord that differs from both
    neighbours (passing chord / early change) take the following chord."""
    lab = list(lab)
    for i in range(1, len(lab) - 1):
        if lab[i] != lab[i - 1] and lab[i] != lab[i + 1] and conf[i] < thr:
            lab[i] = lab[i - 1]
    for i in bar_last_beats:
        # a change on the last beat of a bar is either a passing chord (dropped)
        # or a 1-beat anticipation (snapped to the downbeat): both keep the old chord
        if 0 < i < len(lab) - 1 and lab[i] != lab[i - 1]:
            lab[i] = lab[i - 1]
    for i in range(1, len(lab)):
        if lab[i] == "N":
            lab[i] = lab[i - 1]
    if lab and lab[0] == "N":
        nxt = next((x for x in lab if x != "N"), "N")
        lab = [nxt if x == "N" else x for x in lab]
    return lab


def regularize_start(bar_starts, n_beats):
    """The downbeat tracker can get the opening wrong (e.g. 4 + 2 beats before a steady
    4/4). Re-cut everything before the first run of 3 regular bars by counting back from
    it in whole bars; beats left over at the very start become a pickup bar."""
    lens = np.diff(bar_starts + [n_beats])
    meter = int(np.bincount(lens).argmax())
    first = next((bar_starts[i] for i in range(len(lens) - 2)
                  if all(n == meter for n in lens[i:i + 3])), None)
    if first is None:
        return bar_starts
    r = first % meter
    head = ([0] if r else []) + list(range(r, first, meter))
    return head + [b for b in bar_starts if b >= first]


def merge_half_bars(bar_starts, n_beats, chords):
    """The downbeat tracker can fall into marking every half bar for a stretch (2 + 2 + 2 + 2 beats where the
    song plays 4 + 4). A run of two or more half-length bars is joined in pairs into whole bars; a single one
    is left alone, as a real short bar. An odd run leaves one half bar over: at its end, or at its start when
    that puts more chord changes on the downbeats of the joined bars. Returns the bar starts and the number
    of bars joined away."""
    lens = [int(n) for n in np.diff(bar_starts + [n_beats])]
    meter = int(np.bincount(lens).argmax())
    if meter < 4 or meter % 2:
        return bar_starts, 0
    half = meter // 2
    changes = lambda starts: sum(1 for i in starts if i > 0 and chords[i] != chords[i - 1])
    out, i = [], 0
    while i < len(lens):
        j = i
        while j < len(lens) and lens[j] == half:
            j += 1
        if j - i < 2:
            out.append(bar_starts[i]); i += 1
            continue
        run = bar_starts[i:j]
        keep = run[0::2]                                  # pairs from the start; an odd run's last bar stays short
        if len(run) % 2:
            alt = [run[0]] + run[1::2]                    # the first bar stays short, pairs after it
            if changes(alt[1:]) > changes(keep[1:]):
                keep = alt
        out.extend(keep); i = j
    return out, len(bar_starts) - len(out)


def even_bars(beats, bar_starts, raw, conf):
    """A bar that lasts as long as the bars around it but has another number of beats was counted wrong: the
    tracker dropped a beat, heard one too many, or followed a slower pulse for a moment. Such a bar gets the usual
    number of beats, evenly spaced, each with the chord (and its confidence) of the tracked beat nearest to it.
    A bar that really is shorter or longer (a 2/4 bar among 4/4, a pickup) lasts differently and is left alone,
    as is the last bar, whose end is not known. Returns beats, bar starts, chords, confidences and the number of
    bars changed."""
    ends = bar_starts[1:] + [len(beats)]
    lens = [e - s for s, e in zip(bar_starts, ends)]
    meter = int(np.bincount(lens).argmax())
    t0 = [float(beats[s]) for s in bar_starts]
    durs = [t0[k + 1] - t0[k] for k in range(len(t0) - 1)]
    regular = [d for d, n in zip(durs, lens) if n == meter]
    if not regular:
        return beats, bar_starts, raw, conf, 0
    out_beats, out_raw, out_conf, out_starts, changed = [], [], [], [], 0
    for k, (s, e) in enumerate(zip(bar_starts, ends)):
        out_starts.append(len(out_beats))
        near = [durs[j] for j in range(max(0, k - 4), min(len(durs), k + 5)) if lens[j] == meter]
        usual = float(np.median(near or regular))        # the tempo drifts: compare with the bars around
        if k < len(durs) and lens[k] != meter and 0.88 * usual <= durs[k] <= 1.12 * usual:
            for q in range(meter):
                t = t0[k] + q * durs[k] / meter
                i = s + int(np.argmin(np.abs(beats[s:e] - t)))
                out_beats.append(t); out_raw.append(raw[i]); out_conf.append(conf[i])
            changed += 1
        else:
            out_beats += [float(t) for t in beats[s:e]]; out_raw += list(raw[s:e]); out_conf += list(conf[s:e])
    return np.array(out_beats), out_starts, out_raw, out_conf, changed


def sung_from(work, lines):
    """Whisper often stretches the first word of a phrase back over the music before it: the word then "starts"
    at the beginning of the recording, or of an instrumental break, long before anyone sings. For the first word
    of each line that is implausibly long, the start is moved to where the vocal track really becomes audible
    within it (or, without that track, to a normal word's length before its end). The bars before the singing
    are then not counted to it: at the start of a song they become the Intro. Returns what was moved."""
    LONG, WORD = 1.0, 0.6                                   # seconds: a suspiciously long word; a normal one
    late = [ln[0] for ln in lines if ln[0]["e"] - ln[0]["s"] > LONG]
    if not late:
        return []
    env = None
    stem = os.path.join(work, "sep", "htdemucs", os.path.basename(os.path.normpath(work)), "vocals.wav")
    if os.path.exists(stem):
        import librosa
        y, sr = librosa.load(stem, sr=11025, mono=True)
        hop = 256
        env = librosa.feature.rms(y=y, frame_length=1024, hop_length=hop)[0]
        loud = 0.1 * float(np.percentile(env, 95))          # audible: a tenth of the loud passages
        held = 6                                            # … for 6 frames on end, about 140 ms
    moved = []
    for w in late:
        start = None
        if env is not None:
            i0, i1 = int(w["s"] * sr / hop), min(len(env) - held, int((w["e"] - 0.1) * sr / hop))
            start = next((i * hop / sr for i in range(max(i0, 0), i1) if env[i:i + held].min() > loud), None)
        if start is None:
            start = w["e"] - WORD
        start = max(w["s"], start - 0.05)
        if start - w["s"] > 0.2:
            moved.append((w["w"], w["s"], start)); w["s"] = start
    return moved


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("work"); ap.add_argument("out")
    ap.add_argument("--title", default="Untitled"); ap.add_argument("--artist", default="")
    ap.add_argument("--audio", default=""); ap.add_argument("--capo", default="auto")
    ap.add_argument("--instrumental", default="", help="band-only audio (vocals removed), relative to OUT")
    ap.add_argument("--rhythm", default="", help="drums + bass only audio, relative to OUT")
    ap.add_argument("--bars-per-row", type=int, default=4)
    ap.add_argument("--keep-passing", action="store_true",
                    help="keep 1-beat passing chords / anticipations on beat 4")
    a = ap.parse_args()

    B = json.load(open(f"{a.work}/beats.json"))
    Cj = json.load(open(f"{a.work}/chords.json"))
    L = json.load(open(f"{a.work}/lyrics.json"))
    beats = np.array(B["beats"]); downs = np.array(B["downbeats"])
    beat_dur = float(np.median(np.diff(beats)))
    bpm = round(60 / beat_dur)

    raw = Cj["beat_chords"]; conf = Cj["conf"]
    bar_starts = sorted(set(int(i) for i in np.searchsorted(beats, downs - 0.05)))
    if bar_starts[0] != 0:
        bar_starts = [0] + bar_starts  # beats before the first downbeat: pickup bar
    bar_starts = regularize_start(bar_starts, len(beats))
    bar_starts, joined = merge_half_bars(bar_starts, len(beats), raw)
    if joined:
        print(f"joined {joined} pairs of half bars into whole bars")
    beats, bar_starts, raw, conf, evened = even_bars(beats, bar_starts, raw, conf)
    if evened:
        print(f"gave {evened} bars of the usual length the usual number of beats")
    last_beats = [] if a.keep_passing else [i - 1 for i in bar_starts if i > 0]
    lab = clean_beat_chords(raw, conf, last_beats)

    # --- capo / shapes -------------------------------------------------
    use = Counter(lab)
    if a.capo == "auto":
        capo = min(range(0, 6), key=lambda k: (shape_cost(use, k), k))
    else:
        capo = int(a.capo)
    lab = [transpose(c, -capo) for c in lab]
    key = transpose(Cj["key"], -capo)

    # --- bars ------------------------------------------------------------
    bars = [(s, e) for s, e in zip(bar_starts, bar_starts[1:] + [len(beats)])]
    bar_t = [beats[s] for s, _ in bars]
    meter = int(np.bincount([e - s for s, e in bars]).argmax())   # beats in a normal bar
    bar_dur = float(np.median(np.diff(bar_t)))

    def bar_of(t):
        return max(0, int(np.searchsorted(bar_t, t + 0.15 * beat_dur) - 1))

    # --- words -------------------------------------------------------------
    words = [dict(w, w=w["w"].strip()) for w in L["words"] if w["w"].strip()]
    # drop isolated short blips (typical Whisper hallucination like "Thank you.")
    for i, w in enumerate(words):
        prev_gap = w["s"] - words[i - 1]["e"] if i else 99
        next_gap = words[i + 1]["s"] - w["e"] if i + 1 < len(words) else 99
        if prev_gap <= 6 or w["e"] - w["s"] >= 0.4 or next_gap <= 0:
            continue
        island = [x for x in words if abs(x["s"] - w["s"]) < 3]
        if len(island) <= 3:
            dropped = " ".join(x["w"] for x in island)
            print(f"dropping isolated words at {mmss(w['s'])}: {dropped!r}")
            words = [x for x in words if x not in island]
            break

    # lines: use Whisper's phrase segments, then merge fragments
    segs = list(L["segments"])
    # drop hallucinated segments: very short, isolated, or stock phrases
    HALLU = {"thank you.", "thank you", "thanks for watching!", "thanks for watching.",
             "please subscribe.", "you"}
    good = []
    for i, s in enumerate(segs):
        pg = s["s"] - segs[i - 1]["e"] if i else 99
        ng = segs[i + 1]["s"] - s["e"] if i + 1 < len(segs) else 99
        if s["t"].strip().lower() in HALLU and min(pg, ng) > 3 or (s["e"] - s["s"] < 0.5 and min(pg, ng) > 5):
            print(f"dropping likely hallucination at {mmss(s['s'])}: {s['t'].strip()!r}")
            continue
        good.append(s)
    segs = good
    # assign each word to the nearest segment (by midpoint)
    groups = [[] for _ in segs]
    for w in words:
        m = (w["s"] + w["e"]) / 2
        d = [0 if s["s"] <= m <= s["e"] else min(abs(m - s["s"]), abs(m - s["e"])) for s in segs]
        k = int(np.argmin(d))
        if d[k] < 1.0:
            groups[k].append(w)
    lines = [g for g in groups if g]

    def span(a_, b_):
        return b_[-1]["e"] - a_[0]["s"]

    def gap(a_, b_):
        return b_[0]["s"] - a_[-1]["e"]

    # A lyric line is one line on the sheet: two phrases are only put together while the result is short enough
    # to read as one. In a slow song a couple of bars hold far more words than that, and each phrase is a line
    # of its own. A fragment of a few words (Whisper cutting a phrase in two) may still be put back, up to a
    # longer line, rather than stand alone.
    MAX_LINE_CHARS, MAX_MENDED_CHARS, FRAGMENT_WORDS = 60, 80, 4

    def fits(a_, b_):
        chars = sum(len(w["w"]) + 1 for w in a_ + b_) - 1
        return chars <= (MAX_MENDED_CHARS if min(len(a_), len(b_)) <= FRAGMENT_WORDS else MAX_LINE_CHARS)

    # 1) glue short fragments (<=3 words) to the closer neighbour (prefer previous)
    changed = True
    while changed:
        changed = False
        for i, ln in enumerate(lines):
            if len(ln) > 3 or len(lines) < 2:
                continue
            gp = gap(lines[i - 1], ln) if i > 0 else 99
            gn = gap(ln, lines[i + 1]) if i + 1 < len(lines) else 99
            if i > 0 and gp <= gn + 0.05 and gp < 0.8 * bar_dur and span(lines[i - 1], ln) <= 4.2 * bar_dur and fits(lines[i - 1], ln):
                lines[i - 1] = lines[i - 1] + ln; del lines[i]; changed = True; break
            if i + 1 < len(lines) and gn < 0.8 * bar_dur and span(ln, lines[i + 1]) <= 4.2 * bar_dur and fits(ln, lines[i + 1]):
                lines[i] = ln + lines[i + 1]; del lines[i + 1]; changed = True; break
    # 2) join consecutive short phrases that together fit in ~2.5 bars and in one line
    merged = []
    for ln in lines:
        if merged and gap(merged[-1], ln) < 0.4 * bar_dur and span(merged[-1], ln) <= 2.6 * bar_dur and fits(merged[-1], ln):
            merged[-1] = merged[-1] + ln
        else:
            merged.append(ln)
    lines = merged

    for word, was, now in sung_from(a.work, lines):
        print(f"line start moved to where the singing starts: {word!r} {mmss(was)} -> {mmss(now)} ({now - was:.1f} s later)")

    # sections: break on vocal gaps of ~1 bar or more
    sections, cur = [], []
    for ln in lines:
        if cur and ln[0]["s"] - cur[-1][-1]["e"] >= 0.95 * bar_dur:
            sections.append(cur); cur = []
        cur.append(ln)
    if cur:
        sections.append(cur)

    # section bar ranges: from bar containing first word (pickups count to that
    # bar if the word is within the last beat) up to the next section start
    def start_bar(sec):
        t = sec[0][0]["s"]
        b = bar_of(t)
        if b + 1 < len(bar_t) and bar_t[b + 1] - t < 1.1 * beat_dur:
            b += 1  # pickup: section really starts on the next downbeat
        return b
    sbars = [start_bar(s) for s in sections]
    ends = sbars[1:] + [len(bars)]
    # cut trailing instrumental off a section when it is long (>= 2 bars after last word)
    def block(kind, first, last, sec=None):  # bars [first, last)
        return {"kind": kind, "label": None, "first": first, "last": last, "sec": sec}
    blocks = []
    pos = 0
    for sec, sb, eb in zip(sections, sbars, ends):
        if sb > pos:                   # bars nobody sings in: the Intro before the first section, even if it
            blocks.append(block("inst", pos, sb))   # is only a short first bar; an Instrumental further on
        last = bar_of(sec[-1][-1]["e"]) + 1
        if eb - last >= 2:
            blocks.append(block("vocal", sb, last, sec))
            blocks.append(block("inst", last, eb))
        else:
            blocks.append(block("vocal", sb, eb, sec))
        pos = eb
    # merge adjacent instrumental blocks
    mb = []
    for b in blocks:
        if mb and b["kind"] == "inst" and mb[-1]["kind"] == "inst":
            mb[-1]["last"] = b["last"]
        else:
            mb.append(b)
    blocks = mb

    # labels: sections whose lyrics largely re-occur elsewhere => Chorus
    def toks(sec):
        return [re.sub(r"[^a-z']", "", w["w"].lower()) for ln in sec for w in ln]

    def coverage(x, y):  # fraction of x's words found (in order) inside y
        sm = difflib.SequenceMatcher(None, x, y, autojunk=False)
        return sum(m.size for m in sm.get_matching_blocks()) / max(1, len(x))
    vocal = [b for b in blocks if b["kind"] == "vocal"]
    tk = [toks(b["sec"]) for b in vocal]
    for i, b in enumerate(vocal):
        cov = max([coverage(tk[i], tk[j]) for j in range(len(vocal)) if j != i] or [0])
        b["label"] = "Chorus" if cov >= 0.5 else "Verse"
    # merge directly adjacent chorus blocks (a chorus split by a breath/pause)
    mb = []
    for b in blocks:
        if mb and b["label"] == mb[-1]["label"] == "Chorus":
            mb[-1]["last"] = b["last"]; mb[-1]["sec"] = mb[-1]["sec"] + b["sec"]
        else:
            mb.append(b)
    blocks = mb
    vn = 0
    for i, b in enumerate(blocks):
        if b["label"] == "Verse":
            vn += 1; b["label"] = f"Verse {vn}"
        elif b["kind"] == "inst":
            b["label"] = "Intro" if i == 0 else "Outro" if i == len(blocks) - 1 else "Instrumental"

    # --- emit ----------------------------------------------------------------
    # The timing is in the text, as directives of our own, every time in whole milliseconds (src/lib/song.js):
    # {x_bars: …} before a grid row, the start of each of its bars; {x_line: start end} before a lyric line and
    # {x_words: …} after it, the start of each of its words; {x_end: …} once, the end of the last bar. A bar has
    # as many beats as cells.
    def ms(t):
        return str(int(round(float(t) * 1000)))

    def grid(first, last):
        rows, row = [], []
        prev = None
        for k in range(first, last):
            if k == first and bars[k][1] - bars[k][0] < meter and k + 1 < last:
                # pickup bar: a short row of its own, so the full bars below line up
                rows.append((k, [lab[bars[k][0]:bars[k][1]]])); prev = lab[bars[k][1] - 1]
                rows[-1][1][0] = [c if i == 0 or c != rows[-1][1][0][i - 1] else "." for i, c in enumerate(rows[-1][1][0])]
                continue
            s, e = bars[k]
            cells = []
            for bi in range(s, e):
                c = lab[bi]
                cells.append(c if (c != prev or bi == s and k == first) else ".")
                prev = c
            row.append(cells)
            if len(row) == a.bars_per_row:
                rows.append((k - len(row) + 1, row)); row = []
        if row:
            rows.append((last - len(row), row))
        out = []
        for i, (bk, r) in enumerate(rows):
            bar_txt = " | ".join(" ".join(c.ljust(3) for c in cells).rstrip() for cells in r)
            lead = "||" if i == 0 else "| "
            tail = "|." if bk + len(r) >= len(bars) else "|"
            out.append("{x_bars: " + " ".join(ms(bar_t[bk + j]) for j in range(len(r))) + "}")
            out.append(f"{lead} {bar_txt} {tail}")
        return out

    def chorded_line(ln, t1, shown):  # t1: start of the next line
        changes = []
        bi0 = int(np.searchsorted(beats, ln[0]["s"] + 0.1 * beat_dur) - 1)
        if lab[max(bi0, 0)] != shown:
            changes.append((ln[0]["s"], lab[max(bi0, 0)]))
        for bi in range(max(bi0, 0) + 1, len(beats)):
            if beats[bi] >= t1 - 0.25 * beat_dur:
                break
            if lab[bi] != lab[bi - 1]:
                changes.append((beats[bi], lab[bi]))
        slots = {i: [] for i in range(len(ln) + 1)}  # len(ln) = end of line
        for t, c in changes:
            if t > ln[-1]["e"] + 0.25 * beat_dur:
                slots[len(ln)].append(c); continue
            # word being sung at t, else the next one to start
            j = next((i for i, w in enumerate(ln) if w["s"] - 0.3 * beat_dur <= t < w["e"]), None)
            if j is None:
                j = next((i for i, w in enumerate(ln) if w["s"] >= t), len(ln))
            while slots.get(j) and j < len(ln):
                j += 1
            slots[j].append(c)
        parts = []
        for i, w in enumerate(ln):
            pre = "".join(f"[{c}]" for c in slots[i])
            parts.append(pre + w["w"])
        s = " ".join(parts)
        if slots[len(ln)]:
            s += " " + " ".join(f"[{c}]" for c in slots[len(ln)])
        last = changes[-1][1] if changes else shown
        return s, last

    out = [f"{{title: {a.title}}}"]
    if a.artist:
        out.append(f"{{artist: {a.artist}}}")
    out += [f"{{key: {key}}}"]
    if capo:
        out.append(f"{{capo: {capo}}}")
    # The usual bar's beats; six fast beats are counted in eighths (6/8), everything else in quarters.
    out += [f"{{time: {meter}/{8 if meter == 6 else 4}}}", f"{{tempo: {bpm}}}", f"{{duration: {mmss(beats[-1])}}}"]
    if a.audio:
        out.append(f"{{x_audio: {a.audio}}}")
    if a.instrumental:
        out.append(f"{{x_instrumental: {a.instrumental}}}")
    if a.rhythm:
        out.append(f"{{x_rhythm: {a.rhythm}}}")
    out += ["",
            "# Draft generated by song2cho from the recording. Check by ear!",
            "# {x_bars: ...} before a grid row: when each of its bars starts; {x_line: start end} before a",
            "# lyric line: when it is sung, and {x_words: ...} when each of its words starts. All times in ms",
            "# from the start of the recording.",
            "# Lines starting with '# ?' mark uncertain words or chords.", ""]

    sync_lines = []
    for b in blocks:
        kind, label, fb, lb = b["kind"], b["label"], b["first"], b["last"]
        if lb <= fb:
            continue
        env = "verse" if label.startswith("Verse") else "chorus" if label == "Chorus" else None
        out.append(f'{{start_of_grid label="{label}" shape="1+{a.bars_per_row}x{meter}"}}')
        out += grid(fb, lb)
        out.append("{end_of_grid}")
        # uncertain chords in this block
        weak = [(beats[i], lab[i]) for s, e in bars[fb:lb] for i in range(s, e)
                if conf[i] < 0.6 and (i == s or lab[i] != lab[i - 1])]
        if weak:
            out.append("# ? chords: " + ", ".join(f"{c} @{mmss(t)}" for t, c in weak[:8]))
        if kind == "vocal":
            sec = b["sec"]
            out.append(f'{{start_of_{env} label="{label}"}}')
            shown = None
            block_end = bar_t[lb] if lb < len(bar_t) else beats[-1] + beat_dur
            for li, ln in enumerate(sec):
                nxt = sec[li + 1][0]["s"] if li + 1 < len(sec) else block_end
                txt, shown = chorded_line(ln, nxt, shown)
                out.append("{x_line: " + ms(ln[0]["s"]) + " " + ms(ln[-1]["e"]) + "}")
                out.append("{x_words: " + " ".join(ms(w["s"]) for w in ln) + "}")
                out.append(txt)
                sync_lines.append([round(ln[0]['s'], 3), round(ln[-1]['e'], 3),
                                   [[round(w['s'], 3), w['w']] for w in ln]])
                low = [w for w in ln if (w.get("p") or 1) < 0.5]
                if low:
                    out.append("# ? words: " + ", ".join(f'"{w["w"]}" @{mmss(w["s"])}' for w in low))
            out.append(f"{{end_of_{env}}}")
        out.append("")

    out.append("{x_end: " + ms(beats[-1] + beat_dur) + "}")
    open(a.out, "w").write("\n".join(out))
    sync = {"beats": [round(float(x), 3) for x in beats],
            "bars": [[int(s_), int(e_)] for s_, e_ in bars],
            "lines": sync_lines, "capo": capo}
    json.dump(sync, open(re.sub(r"\.cho$", "", a.out) + ".sync.json", "w"))
    print(f"wrote {a.out}: key {key}, capo {capo}, {bpm} bpm, {len(bars)} bars, "
          f"{len(blocks)} blocks: " + ", ".join(b["label"] for b in blocks))


if __name__ == "__main__":
    main()
