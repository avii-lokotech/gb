import json, sys, numpy as np
from beat_this.inference import File2Beats
f2b = File2Beats(checkpoint_path="final0", device="mps", dbn=False)
beats, downbeats = f2b(sys.argv[1])
beats, downbeats = np.asarray(beats), np.asarray(downbeats)
ibi = np.diff(beats)
print("beats", len(beats), "downbeats", len(downbeats), "first beat %.2f" % beats[0])
print("median BPM %.1f" % (60/np.median(ibi)))
# beats per bar
idx = np.searchsorted(beats, downbeats)
bpb = np.diff(idx)
vals, cnts = np.unique(bpb, return_counts=True)
print("beats per bar histogram", dict(zip(vals.tolist(), cnts.tolist())))
json.dump({"beats": beats.tolist(), "downbeats": downbeats.tolist()}, open(sys.argv[2], "w"))
