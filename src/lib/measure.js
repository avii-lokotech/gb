// Measuring what the player really outputs: a few seconds of the sound are recorded from the audio graph and
// matched against the file's own waveform, which tells how far the sound is from what audio.currentTime says.
import { median } from './song.js';

const WAVE_RATE = 2000; // waveform used for matching, samples per second

// low-rate waveform (box filter + decimate) of a mono mix
function toWave(chs, sr) {
  const a = chs[0], b = chs[1] || chs[0];
  const step = sr / WAVE_RATE, n = Math.floor(a.length / step), w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0; const j0 = Math.floor(i * step), j1 = Math.floor((i + 1) * step);
    for (let j = j0; j < j1; j++) s += a[j] + b[j];
    w[i] = s / (j1 - j0);
  }
  return w;
}

// The waveform of an audio file (a Blob), to match recordings against.
export async function waveOf(ctx, blob) {
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  const chs = []; for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) chs.push(buf.getChannelData(c));
  return toWave(chs, buf.sampleRate);
}

// Record `secs` seconds of what `node` outputs, stamping each block with clock(), and match it against the
// waveform getRefWave() resolves to. Resolves {skew, score}: skew = true position of the recorded sound − clock();
// null when nothing usable was recorded.
export function measureNode(ctx, node, clock, getRefWave, secs = 3) {
  return new Promise((resolve) => {
    const sr = ctx.sampleRate, proc = ctx.createScriptProcessor(4096, 2, 1);
    const mute = ctx.createGain(); mute.gain.value = 0;
    node.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
    const parts = [[], []], stamps = []; let total = 0, done = false;
    const finish = async (bad) => {
      if (done) return; done = true;
      proc.onaudioprocess = null;
      try { node.disconnect(proc); } catch (e) { /* already gone */ }
      proc.disconnect(); mute.disconnect();
      if (bad) return resolve(null);
      // predicted position (by the clock) of the first recorded sample; median over blocks
      const c0s = stamps.map(([endIdx, c]) => c - endIdx / sr);
      const c0 = median(c0s);
      const spread = Math.max(...c0s) - Math.min(...c0s);
      if (spread > 0.25) return resolve(null);                 // a seek/stall happened while recording
      const join = (arr) => { const o = new Float32Array(total); let p = 0; for (const x of arr) { o.set(x, p); p += x.length; } return o; };
      const cap = toWave([join(parts[0]), join(parts[1])], sr);
      try { resolve(matchWave(cap, await getRefWave(), c0)); } catch (e) { resolve(null); }
    };
    proc.onaudioprocess = (e) => {
      if (done) return;
      const ib = e.inputBuffer;
      parts[0].push(new Float32Array(ib.getChannelData(0)));
      parts[1].push(new Float32Array(ib.getChannelData(ib.numberOfChannels > 1 ? 1 : 0)));
      total += ib.length;
      stamps.push([total, clock()]);
      if (total >= secs * sr) finish(false);
    };
    setTimeout(() => finish(true), (secs + 3) * 1000);         // nothing came through
  });
}

// normalised cross-correlation of the captured waveform against the reference, ±1.5 s around c0
function matchWave(cap, ref, c0) {
  if (!ref) return null;
  const n = cap.length, R = WAVE_RATE, maxLag = Math.round(1.5 * R);
  let cm = 0; for (let i = 0; i < n; i++) cm += cap[i]; cm /= n;
  const x = cap.map((v) => v - cm);
  let ex = 0; for (let i = 0; i < n; i++) ex += x[i] * x[i];
  if (ex < 1e-6) return null;                                    // silence: nothing to match
  const base = Math.round(c0 * R);
  // prefix sums of ref and ref² over the search window: each lag then only needs Σx·y
  const w0 = Math.max(0, base - maxLag), w1 = Math.min(ref.length, base + maxLag + n);
  const P = new Float64Array(w1 - w0 + 1), Q = new Float64Array(w1 - w0 + 1);
  for (let i = w0; i < w1; i++) { P[i - w0 + 1] = P[i - w0] + ref[i]; Q[i - w0 + 1] = Q[i - w0] + ref[i] * ref[i]; }
  let best = -2, bestLag = 0;
  for (let L = -maxLag; L <= maxLag; L++) {
    const s0 = base + L; if (s0 < w0 || s0 + n > w1) continue;
    const sy = P[s0 + n - w0] - P[s0 - w0], syy = Q[s0 + n - w0] - Q[s0 - w0];
    let sxy = 0;
    for (let i = 0; i < n; i++) sxy += x[i] * ref[s0 + i];
    const vy = syy - sy * sy / n; if (vy <= 1e-9) continue;
    const r = sxy / Math.sqrt(ex * vy);
    if (r > best) { best = r; bestLag = L; }
  }
  return { skew: bestLag / R, score: best };
}
