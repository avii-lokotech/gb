import json, sys, numpy as np
from beat_this.inference import File2Beats
f2b = File2Beats(checkpoint_path="final0", device="mps", dbn=False)
beats, downbeats = f2b(sys.argv[1])
beats, downbeats = np.asarray(beats), np.asarray(downbeats)

def drop_extra_beats(beats, downbeats):
    """The tracker sometimes hears an off-beat note as a beat: one beat too many, halfway between two real ones.
    That is a bar with a beat too many, and two beats at double speed. Such a beat sits between two gaps that are
    each well under the tempo around it and together one normal beat; it is removed unless it is a downbeat."""
    beats = list(beats); down = {round(float(d), 3) for d in downbeats}
    dropped = []
    i = 1
    while i < len(beats) - 1:
        around = np.diff(beats[max(0, i - 8):i + 9])
        tempo = float(np.median(around))
        before, after = beats[i] - beats[i - 1], beats[i + 1] - beats[i]
        if (before < 0.7 * tempo and after < 0.7 * tempo and 0.8 * tempo <= before + after <= 1.25 * tempo
                and round(float(beats[i]), 3) not in down):
            dropped.append(beats.pop(i))
            continue
        i += 1
    return np.asarray(beats), dropped

beats, dropped = drop_extra_beats(beats, downbeats)
if dropped:
    print("dropped extra beats at", ", ".join("%.2f" % t for t in dropped))
ibi = np.diff(beats)
print("beats", len(beats), "downbeats", len(downbeats), "first beat %.2f" % beats[0])
print("median BPM %.1f" % (60/np.median(ibi)))
# beats per bar
idx = np.searchsorted(beats, downbeats)
bpb = np.diff(idx)
vals, cnts = np.unique(bpb, return_counts=True)
print("beats per bar histogram", dict(zip(vals.tolist(), cnts.tolist())))
json.dump({"beats": beats.tolist(), "downbeats": downbeats.tolist()}, open(sys.argv[2], "w"))
