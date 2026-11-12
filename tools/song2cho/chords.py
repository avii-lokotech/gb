"""Beat-synchronous chord estimation: chroma (CQT) on the accompaniment stem,
template matching against major/minor triads + 'N', Viterbi smoothing,
and a key-aware prior favouring diatonic chords."""
import json, sys
from collections import Counter
import numpy as np, librosa
from notes import SHARP, FLAT, FLAT_KEYS

def templates():
    T, names = [], []
    for q, iv in (("", (0,4,7)), ("m", (0,3,7))):
        for r in range(12):
            v = np.zeros(12); v[[(r+i)%12 for i in iv]] = 1; v[r] += 0.5  # stress root
            T.append(v/np.linalg.norm(v)); names.append((r, q))
    return np.array(T), names

def estimate_key(chroma_mean):
    maj = np.array([6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88])
    mnr = np.array([6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17])
    best = max(((np.corrcoef(np.roll(p, k), chroma_mean)[0,1], k, q)
                for p, q in ((maj,""),(mnr,"m")) for k in range(12)))
    return best[1], best[2]

def diatonic(key_root, key_q):
    # (root offset, quality) of diatonic triads for major key; minor uses relative major
    if key_q == "m": key_root = (key_root + 3) % 12
    deg = [(0,""),(2,"m"),(4,"m"),(5,""),(7,""),(9,"m")]
    return {((key_root+o)%12, q) for o, q in deg}

def main(audio, beats_json, out_json):
    y, sr = librosa.load(audio, sr=22050, mono=True)
    y = librosa.effects.harmonic(y, margin=3)
    hop = 512
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop, bins_per_octave=36, n_octaves=6)
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]
    beats = np.array(json.load(open(beats_json))["beats"])
    bf = librosa.time_to_frames(beats, sr=sr, hop_length=hop)
    # per-beat median chroma / mean energy (column 0 is the stretch before the first beat)
    C = librosa.util.sync(chroma, bf, aggregate=np.median)[:, 1:].T
    E = librosa.util.sync(rms[None, :], bf, aggregate=np.mean)[0, 1:]
    kr, kq = estimate_key(C[E > np.percentile(E, 30)].mean(axis=0))
    dia = diatonic(kr, kq)
    T, names = templates()
    Cn = C / (np.linalg.norm(C, axis=1, keepdims=True) + 1e-9)
    S = Cn @ T.T                                          # (beats, 24) cosine
    S += np.array([0.04 if n in dia else 0.0 for n in names])  # key prior
    quiet = E < 0.15*np.median(E)
    S = np.hstack([S, np.where(quiet, 1.0, 0.0)[:, None]])     # 'N' state
    # Viterbi smoothing: emission score 12*S (as a softmax), sticky transitions
    # (staying costs 0, changing chord costs 2.5 in log terms)
    K = S.shape[1]
    prob = np.exp(12 * (S - S.max(axis=1, keepdims=True)))
    prob /= prob.sum(axis=1, keepdims=True)
    trans = np.where(np.eye(K, dtype=bool), 1.0, np.exp(-2.5))
    trans /= trans.sum(axis=1, keepdims=True)
    path = librosa.sequence.viterbi(prob.T, trans)
    spell = FLAT if SHARP[kr] + kq in FLAT_KEYS else SHARP
    key = spell[kr] + kq
    labels = ["N" if p == 24 else spell[names[p][0]] + names[p][1] for p in path]
    conf = [float(S[t, p]) for t, p in enumerate(path)]
    json.dump({"key": key, "beat_chords": labels, "conf": conf}, open(out_json, "w"))
    print("key:", key)
    print("chord usage (beats):", Counter(labels).most_common(12))
    print("mean confidence %.2f" % np.mean(conf))

if __name__ == "__main__":
    main(*sys.argv[1:4])
