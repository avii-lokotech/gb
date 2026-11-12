"""Assemble a draft ChordPro file from beats.json, chords.json and lyrics.json.

usage: build.py WORKDIR OUT.cho --title T --artist A --audio PATH [--instrumental PATH] [--rhythm PATH] [--capo auto|N]
"""
import argparse, difflib, json, re
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

    # 1) glue short fragments (<=3 words) to the closer neighbour (prefer previous)
    changed = True
    while changed:
        changed = False
        for i, ln in enumerate(lines):
            if len(ln) > 3 or len(lines) < 2:
                continue
            gp = gap(lines[i - 1], ln) if i > 0 else 99
            gn = gap(ln, lines[i + 1]) if i + 1 < len(lines) else 99
            if i > 0 and gp <= gn + 0.05 and gp < 0.8 * bar_dur and span(lines[i - 1], ln) <= 4.2 * bar_dur:
                lines[i - 1] = lines[i - 1] + ln; del lines[i]; changed = True; break
            if i + 1 < len(lines) and gn < 0.8 * bar_dur and span(ln, lines[i + 1]) <= 4.2 * bar_dur:
                lines[i] = ln + lines[i + 1]; del lines[i + 1]; changed = True; break
    # 2) join consecutive short phrases that together fit in ~2.5 bars
    merged = []
    for ln in lines:
        if merged and gap(merged[-1], ln) < 0.4 * bar_dur and span(merged[-1], ln) <= 2.6 * bar_dur:
            merged[-1] = merged[-1] + ln
        else:
            merged.append(ln)
    lines = merged

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
        if sb > pos and pos == 0 and bars[sb][0] < meter:
            sb = 0                     # only a pickup before the first section: it belongs to it
        if sb > pos:
            blocks.append(block("inst", pos, sb))
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
            out.append(f"{mmss(bar_t[bk]):>5} {lead} {bar_txt} {tail}")
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
    out += [f"{{time: 4/4}}", f"{{tempo: {bpm}}}", f"{{duration: {mmss(beats[-1])}}}"]
    if a.audio:
        out.append(f"{{x_audio: {a.audio}}}")
    if a.instrumental:
        out.append(f"{{x_instrumental: {a.instrumental}}}")
    if a.rhythm:
        out.append(f"{{x_rhythm: {a.rhythm}}}")
    out += ["",
            "# Draft generated by song2cho from the recording. Check by ear!",
            "# Grid rows start with the time (m:ss) in the recording.",
            "# Lines starting with '# ?' mark uncertain words or chords.", ""]

    sync_lines = []
    for b in blocks:
        kind, label, fb, lb = b["kind"], b["label"], b["first"], b["last"]
        if lb <= fb:
            continue
        env = "verse" if label.startswith("Verse") else "chorus" if label == "Chorus" else None
        out.append(f'{{start_of_grid label="{label}" shape="1+{a.bars_per_row}x4"}}')
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
                out.append(txt)
                sync_lines.append([round(ln[0]['s'], 3), round(ln[-1]['e'], 3),
                                   [[round(w['s'], 3), w['w']] for w in ln]])
                low = [w for w in ln if (w.get("p") or 1) < 0.5]
                if low:
                    out.append("# ? words: " + ", ".join(f'"{w["w"]}" @{mmss(w["s"])}' for w in low))
            out.append(f"{{end_of_{env}}}")
        out.append("")

    open(a.out, "w").write("\n".join(out))
    sync = {"beats": [round(float(x), 3) for x in beats],
            "bars": [[int(s_), int(e_)] for s_, e_ in bars],
            "lines": sync_lines, "capo": capo}
    json.dump(sync, open(re.sub(r"\.cho$", "", a.out) + ".sync.json", "w"))
    print(f"wrote {a.out}: key {key}, capo {capo}, {bpm} bpm, {len(bars)} bars, "
          f"{len(blocks)} blocks: " + ", ".join(b["label"] for b in blocks))


if __name__ == "__main__":
    main()
