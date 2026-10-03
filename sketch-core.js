// sketch-core.js — shared engine for Sketch Lab and the Pet List app.
// Source of truth is the CORE section of sketch-lab.html until the lab switches to loading this file.
// CORE START — pure functions, no DOM. Tested in Node.

// ---------- Sketchify ----------
// chroma: saturated pixels count as darker, so a grey/white/blue object on an orange wooden
// floor separates from it even when the brightness is similar. L.cr / L.cb carry the
// brightness-free colour for sketch()'s colour-edge boost.
function lum(data, n, range, chroma = 0.8) {
  const L = new Float32Array(n), cr = new Float32Array(n), cb = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = data[j], g = data[j + 1], b = data[j + 2], s = r + g + b + 60;
    const mx = r > g ? (r > b ? r : b) : (g > b ? g : b), mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    L[i] = Math.max(0, 0.299 * r + 0.587 * g + 0.114 * b - chroma * (mx - mn));
    cr[i] = (r - g) / s; cb[i] = (r + g - 2 * b) / s;
  }
  L.cr = cr; L.cb = cb;
  if (!range) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) hist[L[i] | 0]++;
    let lo = 0, hi = 255, acc = 0;
    for (; lo < 255; lo++) { acc += hist[lo]; if (acc > n * 0.02) break; }
    acc = 0;
    for (; hi > 0; hi--) { acc += hist[hi]; if (acc > n * 0.02) break; }
    if (hi - lo < 32) { const mid = (lo + hi) / 2; lo = Math.max(0, mid - 64); hi = Math.min(255, mid + 64); } // flat image: don't stretch noise
    range = [lo, hi];
  }
  const lo = range[0], span = range[1] - range[0];
  for (let i = 0; i < n; i++) { const v = (L[i] - lo) / span; L[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
  return { L, range };
}

function blur(src, w, h, sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3)), k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k[i + r] = v; sum += v; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) { let xx = x + i; if (xx < 0) xx = 0; else if (xx >= w) xx = w - 1; a += src[row + xx] * k[i + r]; }
      tmp[row + x] = a;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) { let yy = y + i; if (yy < 0) yy = 0; else if (yy >= h) yy = h - 1; a += tmp[yy * w + x] * k[i + r]; }
      out[y * w + x] = a;
    }
  }
  return out;
}

// Drop connected blobs of ink smaller than `min` pixels (8-connected).
function despeckle(b, w, h, min) {
  if (min <= 1) return;
  const seen = new Uint8Array(w * h), stack = new Int32Array(w * h), list = new Int32Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (!b[s] || seen[s]) continue;
    let sp = 0, n = 0;
    stack[sp++] = s; seen[s] = 1;
    while (sp) {
      const j = stack[--sp]; list[n++] = j;
      const x = j % w, y = (j / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx;
        if (b[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q; }
      }
    }
    if (n < min) for (let k = 0; k < n; k++) b[list[k]] = 0;
  }
}

// Edge-preserving smoothing: flattens fur/petal texture and sensor noise, keeps outlines.
function bilateral(src, w, h, rs, iters) {
  const r = 2, ws = [], LUT = 1024, rw = new Float32Array(LUT + 1);
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) ws.push(dx, dy, Math.exp(-(dx * dx + dy * dy) / 4.5));
  for (let i = 0; i <= LUT; i++) rw[i] = Math.exp(-(i / LUT) / (2 * rs * rs)); // indexed by dv² (L is 0..1)
  let a = src;
  for (let it = 0; it < iters; it++) {
    const o = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const c = a[y * w + x];
      let s = 0, sw = 0;
      for (let q = 0; q < ws.length; q += 3) {
        let xx = x + ws[q], yy = y + ws[q + 1];
        xx = xx < 0 ? 0 : xx >= w ? w - 1 : xx; yy = yy < 0 ? 0 : yy >= h ? h - 1 : yy;
        const v = a[yy * w + xx], dv = v - c, wt = ws[q + 2] * rw[(dv * dv * LUT) | 0];
        s += v * wt; sw += wt;
      }
      o[y * w + x] = s / sw;
    }
    a = o;
  }
  return a;
}

// Difference-of-Gaussians line drawing. 1 = ink, 0 = paper.
// prevLines (video) adds hysteresis so lines don't flicker frame to frame.
function sketch(L, w, h, S, prevLines) {
  const CR = L.cr, CB = L.cb;
  if (S.smooth) L = bilateral(L, w, h, S.smooth, S.iters || 2);
  const g1 = blur(L, w, h, S.sigma), g2 = blur(L, w, h, S.sigma * 1.6);
  const n = w * h, lines = new Uint8Array(n), hy = S.steady || 0, d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = g1[i] - g2[i];
  if (S.color && CR) { // boost edges where the colour changes too (object vs floor), not just brightness (plank vs plank)
    const a = blur(CR, w, h, 1.5), b = blur(CB, w, h, 1.5), m = new Float32Array(n), c0 = S.c0 || 0.04;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, ax = a[i + 1] - a[i - 1], ay = a[i + w] - a[i - w], bx = b[i + 1] - b[i - 1], by = b[i + w] - b[i - w];
      m[i] = Math.sqrt(ax * ax + ay * ay + bx * bx + by * by);
    }
    const mb = blur(m, w, h, 1);
    for (let i = 0; i < n; i++) { const k = mb[i] / c0 - 1; if (k > 0) d[i] *= 1 + S.color * (k < 1 ? k : 1); }
  }
  let t = S.t;
  if (S.auto) { // raise the threshold above the image's own noise/texture floor
    const hist = new Uint32Array(1024);
    for (let i = 0; i < n; i++) hist[Math.min(1023, (Math.abs(d[i]) * 4096) | 0)]++;
    let acc = 0, m = 0;
    for (; m < 1023; m++) { acc += hist[m]; if (acc >= n / 2) break; }
    t = Math.max(t, S.auto * m / 4096);
  }
  for (let i = 0; i < n; i++) {
    lines[i] = prevLines
      ? (d[i] < -t * (1 + hy) ? 1 : d[i] > -t * (1 - hy) ? 0 : prevLines[i])
      : (d[i] < -t ? 1 : 0);
  }
  if (S.weak != null && S.weak < 1) { // faint edge pixels join only when touching a strong line
    const stack = new Int32Array(n);
    let sp = 0;
    for (let i = 0; i < n; i++) if (lines[i]) stack[sp++] = i;
    while (sp) {
      const j = stack[--sp], x = j % w, y = (j / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx;
        if (!lines[q] && d[q] < -t * S.weak) { lines[q] = 1; stack[sp++] = q; }
      }
    }
  }
  despeckle(lines, w, h, S.clean);
  let out = lines;
  if (S.bold || S.shade > 0) {
    out = new Uint8Array(lines);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (out[i]) continue;
      if (S.bold && ((x > 0 && lines[i - 1]) || (y > 0 && lines[i - w]) || (x > 0 && y > 0 && lines[i - w - 1]))) { out[i] = 1; continue; }
      if (S.shade > 0) {
        const l = g1[i];
        if ((l < S.shade && ((x + y) & 3) === 0) || (l < S.shade * 0.5 && ((x - y) & 3) === 0)) out[i] = 1;
      }
    }
  }
  return { lines, out };
}

// ---------- Camera motion ----------
// out(x, y) = f(x - dx, y - dy); pixels shifted in from outside are paper.
function shiftFrame(f, w, h, dx, dy) {
  if (!dx && !dy) return f;
  const o = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= h) continue;
    for (let x = 0; x < w; x++) { const sx = x - dx; if (sx >= 0 && sx < w) o[y * w + x] = f[sy * w + sx]; }
  }
  return o;
}

// Global camera shift between two brightness maps: B(x, y) ≈ A(x - dx, y - dy).
// Coarse search on a sparse grid, then a ±1 refine. cost = mean abs difference after aligning.
function estimateShift(A, B, w, h, R) {
  if (w <= 2 * R + 4 || h <= 2 * R + 4) return { dx: 0, dy: 0, cost: 0 };
  const a = blur(A, w, h, 1.5), b = blur(B, w, h, 1.5);
  const cost = (dx, dy) => {
    let s = 0, n = 0;
    for (let y = R; y < h - R; y += 2) {
      const yb = y * w, ya = (y - dy) * w - dx;
      for (let x = R; x < w - R; x += 2) { s += Math.abs(b[yb + x] - a[ya + x]); n++; }
    }
    return s / n;
  };
  let bx = 0, by = 0, bc = cost(0, 0) * 0.97; // slight bias towards "camera didn't move"
  for (let dy = -R; dy <= R; dy += 2) for (let dx = -R; dx <= R; dx += 2) {
    const c = cost(dx, dy);
    if (c < bc) { bc = c; bx = dx; by = dy; }
  }
  const cx = bx, cy = by;
  for (let dy = cy - 1; dy <= cy + 1; dy++) for (let dx = cx - 1; dx <= cx + 1; dx++) {
    if (Math.abs(dx) > R || Math.abs(dy) > R || (dx === cx && dy === cy)) continue;
    const c = cost(dx, dy);
    if (c < bc) { bc = c; bx = dx; by = dy; }
  }
  return { dx: bx, dy: by, cost: bc };
}

// How crisp a frame is (mean |Laplacian|) — motion blur makes it drop.
function sharpness(L, w, h) {
  let s = 0, n = 0;
  for (let y = 1; y < h - 1; y += 2) for (let x = 1; x < w - 1; x += 2) {
    const i = y * w + x;
    s += Math.abs(4 * L[i] - L[i - 1] - L[i + 1] - L[i - w] - L[i + w]); n++;
  }
  return n ? s / n : 0;
}

// Idea: a guide clip is a tour of a few *places*. For every frame we measure
//  - quality: sharp (no motion blur) and steady (looks like its neighbours), and
//  - a tiny brightness-normalised thumbnail = "what place is this".
// Then we greedily choose frames that *represent* as much well-filmed footage as
// possible (facility location): a pick covers every frame whose thumbnail looks like it.
// Places the user dwells on get a step; revisits of an already covered view add
// nothing, so they never use up a step; blurry walking frames weigh little.
// Stops at K, or earlier when no remaining view is both distinct and substantial.

const STEP_P = { cell: 16, top: 0.1, mix: 0.3, T: 1.1, same: 0.55, place: 0.75, placeGain: 0.025, view: 0.5, viewGain: 0.04, stillScale: 0.2, base: 0.25, open: 0.05, openBoost: 5 };

function stepThumb(L, w, h, g) {
  const sw = Math.max(2, Math.floor(w / g)), sh = Math.max(2, Math.floor(h / g));
  const cw = Math.floor(w / sw), ch = Math.floor(h / sh), o = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    let s = 0;
    for (let yy = y * ch; yy < (y + 1) * ch; yy += 2) { const r = yy * w; for (let xx = x * cw; xx < (x + 1) * cw; xx += 2) s += L[r + xx]; }
    o[y * sw + x] = s;
  }
  let m = 0; for (let i = 0; i < o.length; i++) m += o[i]; m /= o.length;
  let v = 0; for (let i = 0; i < o.length; i++) { o[i] -= m; v += o[i] * o[i]; }
  const sd = Math.sqrt(v / o.length) + 1e-6 + 0.02 * m; // brightness-normalised; flat frames stay flat
  for (let i = 0; i < o.length; i++) o[i] /= sd;
  return o;
}
// Mean cell difference, mixed with the mean of the worst `top` cells so a local change
// (a lid opening in one corner) still counts, not just whole-view changes.
function thumbDist(a, b, top, mix, buf) {
  const m = a.length; let s = 0;
  for (let i = 0; i < m; i++) { const d = a[i] - b[i]; buf[i] = d < 0 ? -d : d; s += buf[i]; }
  const k = Math.max(1, Math.round(m * top)), v = buf.subarray(0, m).sort();
  let t = 0; for (let i = m - k; i < m; i++) t += v[i];
  thumbDist.mean = s / m;
  return (1 - mix) * s / m + mix * t / k;
}

function pickSteps(Ls, w, h, K, P = STEP_P) {
  const n = Ls.length;
  if (n <= 1) return [0];
  K = Math.max(1, K | 0);
  const D = Ls.map(L => stepThumb(L, w, h, P.cell));
  const dist = new Float32Array(n * n), dmean = new Float32Array(n * n), buf = new Float32Array(D[0].length);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    dist[i * n + j] = dist[j * n + i] = thumbDist(D[i], D[j], P.top, P.mix, buf);
    dmean[i * n + j] = dmean[j * n + i] = thumbDist.mean;
  }
  const sh = Ls.map(L => sharpness(L, w, h));
  const ref = sh.slice().sort((a, b) => a - b)[Math.floor((n - 1) * 0.9)] || 1;
  const q = new Float32Array(n), cq = new Float32Array(n), wt = new Float32Array(n);
  const open = Math.max(1, Math.round(n * P.open));
  // "steady" is judged against the clip's own frame-to-frame change, so the scan fps doesn't matter much
  const cons = []; for (let i = 1; i < n; i++) cons.push(dist[i * n + i - 1]);
  cons.sort((a, b) => a - b);
  const stillScale = Math.max(P.stillScale, cons[Math.floor((n - 2) * 0.25)] || 0);
  for (let i = 0; i < n; i++) {
    // steady = looks like a neighbour; sharp = relative to the clip and to other views of the same place
    const a = i > 0 ? dist[i * n + i - 1] : Infinity, b = i < n - 1 ? dist[i * n + i + 1] : Infinity;
    const still = 1 / (1 + (Math.min(a, b) / stillScale) ** 2);
    let loc = 0; for (let j = 0; j < n; j++) if (dist[i * n + j] < P.same) loc = Math.max(loc, sh[j]);
    const sg = Math.min(1, sh[i] / ref), sl = loc > 0 ? sh[i] / loc : 1;
    q[i] = sg * sg * still;
    // the opening shot is often a slow pan: judge it on sharpness only
    cq[i] = sl * sl * sl * (i < open ? sg * sg : Math.sqrt(still * sg));
    wt[i] = i < open ? P.openBoost : P.base + (1 - P.base) * q[i]; // the opening shot is usually framed on purpose
  }
  const totalW = wt.reduce((a, b) => a + b, 0);
  const cov = new Float32Array(n), picks = [];
  for (const [sep, minGain, M] of [[P.place, P.placeGain, dmean], [P.view, P.viewGain, dist]]) {
    while (picks.length < K) {
      let best = -1, bestG = 0;
      for (let c = 0; c < n; c++) {
        let md = Infinity; for (const p of picks) md = Math.min(md, M[c * n + p]);
        if (md < sep) continue;
        let g = 0;
        for (let i = 0; i < n; i++) { const s = 1 - dist[c * n + i] / P.T; if (s > cov[i]) g += wt[i] * (s - cov[i]); }
        g *= cq[c];
        if (g > bestG) { bestG = g; best = c; }
      }
      if (best < 0 || (picks.length && bestG < minGain * totalW)) break;
      picks.push(best);
      if (best < open) for (let i = 0; i < open; i++) wt[i] = P.base + (1 - P.base) * q[i]; // one establishing shot is enough
      for (let i = 0; i < n; i++) cov[i] = Math.max(cov[i], 1 - dist[best * n + i] / P.T);
    }
  }
  if (!picks.length) picks.push(Math.floor(n / 2)); // featureless clip
  return picks.sort((a, b) => a - b);
}

// ---------- Codec: context-modelled binary arithmetic coding (JBIG-style) ----------
const SHIFTS = [1, 2, 2, 3, 3, 3, 4, 4, 4, 4, 4, 4, 5];
function model(n) { return { p: new Uint16Array(n).fill(16384), n: new Uint8Array(n) }; }
function adapt(m, i, b) {
  const c = m.n[i], s = SHIFTS[c];
  if (c < 12) m.n[i] = c + 1;
  let p = m.p[i];
  p = b ? p - (p >> s) : p + ((32768 - p) >> s);
  m.p[i] = p < 32 ? 32 : p > 32736 ? 32736 : p;
}

class Enc {
  constructor() { this.low = 0; this.range = 0xFFFFFFFF; this.cache = 0; this.cacheSize = 1; this.out = []; }
  bit(m, i, b) {
    const bound = (this.range >>> 15) * m.p[i];
    if (!b) this.range = bound; else { this.low += bound; this.range -= bound; }
    adapt(m, i, b);
    while (this.range < 16777216) { this.range *= 256; this.shift(); }
    return b;
  }
  shift() {
    if (this.low < 0xFF000000 || this.low >= 4294967296) {
      const carry = this.low >= 4294967296 ? 1 : 0;
      let t = this.cache;
      do { this.out.push((t + carry) & 255); t = 255; } while (--this.cacheSize !== 0);
      this.cache = (this.low >>> 24) & 255;
    }
    this.cacheSize++;
    this.low = (this.low & 0xFFFFFF) * 256;
  }
  finish() { for (let i = 0; i < 5; i++) this.shift(); return Uint8Array.from(this.out); }
}

class Dec {
  constructor(buf, pos) {
    this.buf = buf; this.pos = pos + 1; this.range = 0xFFFFFFFF; this.code = 0;
    for (let i = 0; i < 4; i++) this.code = this.code * 256 + this.byte();
  }
  byte() { return this.pos < this.buf.length ? this.buf[this.pos++] : 0; }
  bit(m, i) {
    const bound = (this.range >>> 15) * m.p[i];
    let b;
    if (this.code < bound) { this.range = bound; b = 0; } else { this.code -= bound; this.range -= bound; b = 1; }
    adapt(m, i, b);
    while (this.range < 16777216) { this.range *= 256; this.code = this.code * 256 + this.byte(); }
    return b;
  }
}

function models() { return { row: model(2), s: model(1024), t: model(1024) }; }

// Shared by encoder and decoder so contexts are identical on both sides.
function codeFrame(rc, enc, cur, prev, w, h, M) {
  const g = (f, x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : f[y * w + x];
  for (let y = 0; y < h; y++) {
    const base = y * w;
    // Row flag: identical to the previous frame's row (video) or the row above (still).
    let same = 0;
    if (enc) {
      same = 1;
      for (let x = 0; x < w; x++) {
        const r = prev ? prev[base + x] : (y > 0 ? cur[base - w + x] : 0);
        if (cur[base + x] !== r) { same = 0; break; }
      }
    }
    same = rc.bit(M.row, prev ? 1 : 0, same);
    if (same) {
      if (!enc) { if (prev) cur.set(prev.subarray(base, base + w), base); else if (y > 0) cur.copyWithin(base, base - w, base); }
      continue;
    }
    for (let x = 0; x < w; x++) {
      let c, m;
      if (!prev) {
        m = M.s;
        c = g(cur, x - 1, y - 2) | g(cur, x, y - 2) << 1 | g(cur, x + 1, y - 2) << 2 |
            g(cur, x - 2, y - 1) << 3 | g(cur, x - 1, y - 1) << 4 | g(cur, x, y - 1) << 5 | g(cur, x + 1, y - 1) << 6 | g(cur, x + 2, y - 1) << 7 |
            g(cur, x - 2, y) << 8 | g(cur, x - 1, y) << 9;
      } else {
        m = M.t;
        c = g(cur, x - 1, y) | g(cur, x - 2, y) << 1 | g(cur, x - 1, y - 1) << 2 | g(cur, x, y - 1) << 3 | g(cur, x + 1, y - 1) << 4 |
            g(prev, x, y) << 5 | g(prev, x - 1, y) << 6 | g(prev, x + 1, y) << 7 | g(prev, x, y - 1) << 8 | g(prev, x, y + 1) << 9;
      }
      const v = rc.bit(m, c, enc ? cur[base + x] : 0);
      if (!enc) cur[base + x] = v;
    }
  }
}

// Limits shared by encoder and decoder, so the app can never make a link it would refuse to open.
const LIMITS = { side: 2048, steps: 16, frames: 600, pixels: 12e6 };

// item: { type: 1 photo | 2 flipbook | 3 steps, w, h, fps, frames: [Uint8Array w*h of 0/1],
//         shifts?: [[dx,dy] per frame] — camera motion, so the previous frame is moved before use as context }
// Bytes: [type][w u16][h u16] and for 2/3: [fps×10][n u16] + 2 bytes per frame after the first:
// signed dx, dy — or 0x80 0x00 meaning "coded as a fresh picture" (scene changed too much).
function encodeItem(it) {
  const f10 = Math.round(it.fps * 10), n = it.frames.length, w = it.w, h = it.h;
  if (![1, 2, 3].includes(it.type) || !(w >= 1 && h >= 1 && w <= LIMITS.side && h <= LIMITS.side && n >= 1 && w * h * n <= LIMITS.pixels) ||
      it.frames.some(f => f.length !== w * h) || (it.type === 1 && n !== 1) || (it.type === 2 && !(n <= LIMITS.frames && f10 >= 1 && f10 <= 255)) ||
      (it.type === 3 && n > LIMITS.steps)) throw new Error('Item exceeds format limits');
  const cl = v => { v = Math.round(+v); return Number.isFinite(v) ? Math.max(-127, Math.min(127, v)) : 0; };
  const enc = new Enc(), M = models(), hdr = [it.type, w >> 8, w & 255, h >> 8, h & 255];
  if (it.type !== 1) hdr.push(it.type === 2 ? f10 : 0, n >> 8, n & 255);
  it.frames.forEach((f, k) => {
    let ref = null;
    if (k) {
      const sh = (it.shifts && it.shifts[k]) || [0, 0];
      const dx = cl(sh[0]), dy = cl(sh[1]);
      ref = shiftFrame(it.frames[k - 1], w, h, dx, dy);
      let diff = 0, ink = 0;
      for (let i = 0; i < w * h; i++) { ink += f[i]; diff += f[i] !== ref[i]; }
      if (diff > ink) { ref = null; hdr.push(0x80, 0); } else hdr.push(dx & 255, dy & 255);
    }
    codeFrame(enc, true, f, ref, w, h, M);
  });
  const body = enc.finish(), out = new Uint8Array(hdr.length + body.length);
  out.set(hdr); out.set(body, hdr.length);
  return out;
}

function decodeItem(b) {
  const type = b[0], w = b[1] << 8 | b[2], h = b[3] << 8 | b[4];
  let pos = 5, fps = 0, n = 1;
  if (type === 2 || type === 3) { fps = b[5] / 10; n = b[6] << 8 | b[7]; pos = 8; }
  else if (type !== 1) throw new Error('Unknown item type ' + type);
  if (b.length < pos || !w || !h || !n || w > LIMITS.side || h > LIMITS.side || w * h * n > LIMITS.pixels ||
      (type === 3 && n > LIMITS.steps) || (type === 2 && (n > LIMITS.frames || !b[5])) || pos + 2 * (n - 1) > b.length) throw new Error('Bad item size');
  const sb = v => v > 127 ? v - 256 : v, shifts = [[0, 0]], intra = [true];
  for (let k = 1; k < n; k++, pos += 2) { intra.push(b[pos] === 0x80); shifts.push([sb(b[pos]), sb(b[pos + 1])]); }
  const dec = new Dec(b, pos), M = models(), frames = [];
  for (let k = 0; k < n; k++) {
    const f = new Uint8Array(w * h);
    codeFrame(dec, false, f, intra[k] ? null : shiftFrame(frames[k - 1], w, h, shifts[k][0], shifts[k][1]), w, h, M);
    frames.push(f);
  }
  return { type, w, h, fps, frames, shifts };
}

// Container: [version 1] then per item [LEB128 length][item bytes], then 4-byte FNV-1a checksum
function encodeContainer(parts) {
  const out = [1];
  for (const p of parts) {
    let n = p.length;
    do { let byte = n & 127; n >>>= 7; if (n) byte |= 128; out.push(byte); } while (n);
    for (let i = 0; i < p.length; i++) out.push(p[i]);
  }
  const c = fnv(out, out.length);
  out.push(c >>> 24, (c >>> 16) & 255, (c >>> 8) & 255, c & 255);
  return Uint8Array.from(out);
}
function fnv(b, n) {
  let h = 0x811c9dc5;
  for (let i = 0; i < n; i++) h = Math.imul(h ^ b[i], 0x01000193);
  return h >>> 0;
}
function decodeContainer(b) {
  if (b[0] !== 1) throw new Error('Unknown link version');
  if (b.length < 5) throw new Error('Link is truncated');
  const end = b.length - 4;
  if (fnv(b, end) !== ((b[end] << 24 | b[end + 1] << 16 | b[end + 2] << 8 | b[end + 3]) >>> 0)) throw new Error('Link is damaged or incomplete');
  b = b.subarray(0, end);
  const parts = [];
  let pos = 1;
  while (pos < b.length) {
    let n = 0, shift = 0, byte;
    do {
      if (pos >= b.length || shift > 21) throw new Error('Corrupt link');
      byte = b[pos++]; n += (byte & 127) * 2 ** shift; shift += 7;
    } while (byte & 128);
    if (pos + n > b.length) throw new Error('Link is truncated');
    parts.push(b.subarray(pos, pos + n)); pos += n;
  }
  // Refuse decompression bombs: a tiny link claiming huge frames.
  let px = 0;
  for (const p of parts) if (p[0] >= 1 && p[0] <= 3) px += (p[1] << 8 | p[2]) * (p[3] << 8 | p[4]) * (p[0] !== 1 ? (p[6] << 8 | p[7]) : 1);
  if (px > 12e6) throw new Error('Link too large');
  // Item types this version doesn't know (added later, or app-specific) come back raw instead of failing the link.
  return parts.map(p => p[0] >= 1 && p[0] <= 3 ? Object.assign(decodeItem(p), { bytes: p }) : { type: p[0], unknown: true, bytes: p });
}

function toB64u(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64u(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

// Pack 1-bit rows (used for the zip-style size comparison).
function packBits(f, w, h) {
  const rb = (w + 7) >> 3, o = new Uint8Array(rb * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (f[y * w + x]) o[y * rb + (x >> 3)] |= 0x80 >> (x & 7);
  return o;
}

if (typeof module !== 'undefined') module.exports = { LIMITS, fnv, lum, blur, despeckle, sketch, shiftFrame, estimateShift, sharpness, pickSteps, encodeItem, decodeItem, encodeContainer, decodeContainer, toB64u, fromB64u, packBits };
// CORE END
