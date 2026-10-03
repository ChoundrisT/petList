// petlist.js — the Pet List app. Needs sketch-core.js loaded first (classic script; its functions
// are globals). Every call into the core goes through the `Core` object below, so moving the
// core into a namespace later is a one-line change.
//
// ============================== LINK FORMAT ==============================
// URL:  <page>#<base64url(container)>          (no padding, alphabet A–Z a–z 0–9 - _)
// container = sketch-core encodeContainer(parts), unchanged:
//   [0x01 container version] { [LEB128 length][part bytes] }* [FNV-1a 32-bit checksum, big-endian]
// Each part starts with a type byte:
//   1 photo / drawing, 2 flipbook, 3 steps — sketch-core media items (encodeItem / decodeItem)
//   4 guide structure, deflate-raw:  [0x04][structure version = 1] deflate-raw(UTF-8 JSON)
//   5 guide structure, plain:        [0x05][structure version = 1] UTF-8 JSON   (browser without CompressionStream)
//   anything else: ignored, so later versions can add part types without breaking this page.
// The structure part comes first; media parts follow in card order. A link without a structure
// part (a Sketch Lab link) opens as a guide with one card per media item.
// JSON (short keys; everything is validated on decode and unknown keys are ignored):
//   { v: 1, id: "guide id (stays the same across re-shares)", t: title, i: intro,
//     u: last change (unix seconds),
//     c: [ { k: card id, t: title, x: text, l: [checklist item, …],
//            m: media index (1 = first media part after the structure), d: 1 if the photo item is a hand drawing,
//            s: [caption per step, …] } ],
//     cm: [ { n: name, x: text, d: unix seconds } ] }
// Drafts in localStorage use the same JSON, with "mb": base64url(media item) instead of "m".
// ========================================================================
'use strict';

const Core = window.SketchCore || { // sketch-core.js API used by this app
  lum, sketch, estimateShift, shiftFrame, pickSteps, encodeItem, decodeItem, encodeContainer, fnv, toB64u, fromB64u,
};

const BUDGET = 60000;               // ≈ one WhatsApp message
const S0 = { sigma: 1.1, t: 0.01425, clean: 20, shade: 0, bold: true, smooth: 0.1, weak: 0.45, auto: 2, color: 3, steady: 0.5 };
const IMG_W = 480;                  // pixel budget of a 4:3 frame (photos, steps)
const SCAN = { w: 160, fps: 6, secs: 60 };
const FLIP = { w: 240, fps: 3, secs: 8 };
const DRAW_W = 480, DRAW_H = 360;
const INK = [27, 27, 27], PAPER = [255, 253, 247];
const LIM = { title: 120, intro: 2000, ctitle: 120, text: 4000, item: 300, items: 60, cards: 80, cap: 160, name: 60, comment: 1000, comments: 200 };
const PREFIX = 'petlist.v1.';

const $ = (s, r = document) => r.querySelector(s);
const tick = () => new Promise(r => setTimeout(r));
const now = () => Math.floor(Date.now() / 1000);
const fmtK = n => n < 1000 ? `${n}` : `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}K`;
const b64len = n => Math.ceil(n * 4 / 3);
const rid = (n = 8) => Core.toB64u(crypto.getRandomValues(new Uint8Array(n))).slice(0, n);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---------- tiny DOM helper (text only via textContent; never innerHTML with user data) ----------
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const k in props) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(9)) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(9).filter(k => k != null && k !== false));
const ICONS = {
  photo: 'M4 8h3l2-3h6l2 3h3v11H4z|C12 13.5 3.5',
  video: 'M3 6h12v12H3z|M15 10l6-3v10l-6-3',
  draw: 'M4 20l4-1 11-11-3-3L5 16z|M14 7l3 3',
  up: 'M12 19V5|M5 12l7-7 7 7', down: 'M12 5v14|M5 12l7 7 7-7',
  trash: 'M4 7h16|M9 7V4h6v3|M6 7l1 13h10l1-13', x: 'M6 6l12 12|M18 6L6 18', plus: 'M12 5v14|M5 12h14',
  share: 'M12 3v12|M7 8l5-5 5 5|M5 12v8h14v-8', edit: 'M4 20l4-1 11-11-3-3L5 16z', eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z|C12 12 3',
  list: 'M9 6h11|M9 12h11|M9 18h11|M4 6h1|M4 12h1|M4 18h1', note: 'M5 3h14v18H5z|M9 8h6|M9 12h6|M9 16h4',
  undo: 'M9 14L4 9l5-5|M4 9h11a5 5 0 010 10h-3', copy: 'M8 8h12v12H8z|M4 16V4h12', broken: 'M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1|M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1|M3 3l18 18',
};
function icon(name) {
  const NS = 'http://www.w3.org/2000/svg', s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name].split('|')) {
    let e;
    if (d[0] === 'C') { const [x, y, r] = d.slice(1).trim().split(' '); e = document.createElementNS(NS, 'circle'); e.setAttribute('cx', x); e.setAttribute('cy', y); e.setAttribute('r', r); }
    else { e = document.createElementNS(NS, 'path'); e.setAttribute('d', d); }
    s.append(e);
  }
  return s;
}

function toast(msg, action) {
  const t = $('#toast');
  fill(t, h('span', { text: msg }));
  if (action) t.append(h('button', { text: action.label, onclick: () => { t.classList.remove('show'); action.fn(); } }));
  t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), action ? 6000 : 2800);
}

// ---------- storage (always optional) ----------
const store = {
  get(k) { try { return localStorage.getItem(PREFIX + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(PREFIX + k, v); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(PREFIX + k); } catch {} },
  keys() { try { return Object.keys(localStorage).filter(k => k.startsWith(PREFIX)).map(k => k.slice(PREFIX.length)); } catch { return []; } },
};
const sess = {
  get(k) { try { return sessionStorage.getItem(PREFIX + k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(PREFIX + k, v); } catch {} },
};

// ---------- model ----------
// guide: { id, title, intro, updated, cards: [card], comments: [{name, text, at}] }
// card: { id, title, text, items: null | [string], media: null | Media, hint?, src?, opts, busy, err }
// Media: { type, w, h, fps, frames, bytes, drawing, captions: [] }
function newCard(extra) { return { id: rid(5), title: '', text: '', items: null, media: null, opts: { mode: 'steps', steps: 4 }, ...extra }; }
function newGuide() {
  return {
    id: rid(), title: '', intro: '', updated: now(), comments: [],
    cards: [
      newCard({ hint: ['Food', 'How much, when, and where the food is kept…'] }),
      newCard({ items: [''], hint: ['Daily routine', '8:00 — breakfast, ½ cup'] }),
      newCard({ hint: ['Vet & emergencies', 'Vet name, phone number, address…'] }),
    ],
  };
}
const cardEmpty = c => !c.title.trim() && !c.text.trim() && !c.media && !(c.items && c.items.some(s => s.trim()));
const liveCards = g => g.cards.filter(c => !cardEmpty(c));
function mediaFromBytes(bytes, drawing, captions) {
  const m = Core.decodeItem(bytes);
  return { type: m.type, w: m.w, h: m.h, fps: m.fps, frames: m.frames, bytes, drawing: !!drawing && m.type === 1, captions: m.type === 3 ? fitCaps(captions, m.frames.length) : [] };
}
const fitCaps = (caps, n) => Array.from({ length: n }, (_, i) => (caps && typeof caps[i] === 'string' ? caps[i] : '').slice(0, LIM.cap));

// ---------- serialisation ----------
function guideJSON(g, mode) { // mode 'link' → media by part index (fills parts), 'draft' → inline base64
  const parts = [null], c = [];
  for (const card of (mode === 'link' ? liveCards(g) : g.cards)) {
    const o = { k: card.id };
    if (card.title.trim()) o.t = card.title;
    if (card.text.trim()) o.x = card.text;
    if (card.items) o.l = mode === 'link' ? card.items.filter(s => s.trim()) : card.items.slice();
    if (card.media) {
      if (mode === 'link') { o.m = parts.length; parts.push(card.media.bytes); } else o.mb = Core.toB64u(card.media.bytes);
      if (card.media.drawing) o.d = 1;
      if (card.media.captions.some(s => s.trim())) o.s = card.media.captions;
    }
    c.push(o);
  }
  const json = { v: 1, id: g.id, t: g.title, i: g.intro, u: g.updated, c, cm: g.comments.map(x => ({ n: x.name, x: x.text, d: x.at })) };
  return { json, parts };
}
const draftString = g => JSON.stringify(guideJSON(g, 'draft').json);

let deflateOK = null;
function canDeflate() {
  if (deflateOK === null) { try { new CompressionStream('deflate-raw'); new DecompressionStream('deflate-raw'); deflateOK = true; } catch { deflateOK = false; } }
  return deflateOK;
}
async function streamBytes(bytes, ts, max) {
  const reader = new Blob([bytes]).stream().pipeThrough(ts).getReader(), chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { reader.cancel().catch(() => {}); throw new LinkError('too-big'); }
    chunks.push(value);
  }
  const out = new Uint8Array(n); let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new LinkError('damaged')), ms))]);

async function encodeGuide(g) {
  const { json, parts } = guideJSON(g, 'link');
  const txt = new TextEncoder().encode(JSON.stringify(json));
  let type = 5, payload = txt;
  if (canDeflate()) { try { payload = await streamBytes(txt, new CompressionStream('deflate-raw'), 1e7); type = 4; } catch { payload = txt; type = 5; } }
  const head = new Uint8Array(2 + payload.length);
  head.set([type, 1]); head.set(payload, 2);
  parts[0] = head;
  return Core.toB64u(Core.encodeContainer(parts));
}

class LinkError extends Error { constructor(code) { super(code); this.code = code; } }
const LINK_MSG = {
  damaged: ["This link is incomplete", "Part of it was probably cut off when it was copied or forwarded. Ask for the link again and make sure the whole message gets copied."],
  newer: ["This guide needs a newer Pet List", "It was made with a newer version of this page. Ask the sender to share it again, or open it on an up-to-date page."],
  'too-big': ["This link is too large to open", "It claims to contain far more pictures than a guide ever needs, so it was not opened."],
  'no-inflate': ["This browser can't open the guide", "It needs a slightly newer browser. Try the latest Safari, Chrome or Firefox."],
};

// Same layout as sketch-core decodeContainer, but returns the raw parts: media bytes are kept
// as they are so re-sharing never re-encodes (or changes) a picture.
function splitContainer(b) {
  if (b.length < 5) throw new LinkError('damaged');
  if (b[0] !== 1) throw new LinkError('newer');
  const end = b.length - 4;
  if (Core.fnv(b, end) !== ((b[end] << 24 | b[end + 1] << 16 | b[end + 2] << 8 | b[end + 3]) >>> 0)) throw new LinkError('damaged');
  const parts = [];
  let pos = 1;
  while (pos < end) {
    let n = 0, shift = 0, byte;
    do {
      if (pos >= end || shift > 21) throw new LinkError('damaged');
      byte = b[pos++]; n += (byte & 127) * 2 ** shift; shift += 7;
    } while (byte & 128);
    if (pos + n > end || parts.length > 300) throw new LinkError('damaged');
    if (n) parts.push(b.subarray(pos, pos + n));
    pos += n;
  }
  return parts;
}
function mediaPixels(p) {
  if (p.length < 5) throw new LinkError('damaged');
  const n = p[0] === 1 ? 1 : (p.length >= 8 ? p[6] << 8 | p[7] : 0);
  return (p[1] << 8 | p[2]) * (p[3] << 8 | p[4]) * n;
}

const str = (v, max) => typeof v === 'string' ? v.slice(0, max) : '';
async function decodeGuide(hash) {
  let data = hash.replace(/^#/, '');
  try { data = decodeURIComponent(data); } catch {}
  data = data.replace(/\s+/g, '');
  if (!data || !/^[A-Za-z0-9_-]+$/.test(data)) throw new LinkError('damaged');
  let bytes;
  try { bytes = Core.fromB64u(data); } catch { throw new LinkError('damaged'); }
  const parts = splitContainer(bytes);
  const media = parts.filter(p => p[0] >= 1 && p[0] <= 3), struct = parts.find(p => p[0] === 4 || p[0] === 5);
  if (!media.length && !struct) throw new LinkError(parts.length ? 'newer' : 'damaged');
  let px = 0; for (const p of media) px += mediaPixels(p);
  if (px > 30e6 || media.length > 100) throw new LinkError('too-big'); // a tiny link claiming huge frames
  const decoded = media.map(p => {
    try { return mediaFromBytes(p.slice(), false, null); } catch { throw new LinkError('damaged'); }
  });
  if (!struct) { // a plain Sketch Lab link
    return { id: rid(), title: 'Shared sketches', intro: '', updated: now(), comments: [], cards: decoded.map(m => newCard({ media: m })) };
  }
  if (struct.length < 3) throw new LinkError('damaged');
  if (struct[1] !== 1) throw new LinkError('newer');
  let txt = struct.subarray(2);
  if (struct[0] === 4) {
    if (!canDeflate()) throw new LinkError('no-inflate');
    try { txt = await withTimeout(streamBytes(txt.slice(), new DecompressionStream('deflate-raw'), 2e6), 10000); }
    catch (e) { throw e instanceof LinkError ? e : new LinkError('damaged'); }
  }
  let o;
  try { o = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(txt)); } catch { throw new LinkError('damaged'); }
  return guideFromJSON(o, c => (Number.isInteger(c.m) && c.m >= 1 && c.m <= decoded.length) ? decoded[c.m - 1] : null);
}

// Untrusted input → clean model. Unknown fields are ignored; wrong types become empty.
function guideFromJSON(o, mediaFor) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new LinkError('damaged');
  if (o.v !== 1) throw new LinkError(typeof o.v === 'number' && o.v > 1 ? 'newer' : 'damaged');
  const used = new Set();
  const cards = (Array.isArray(o.c) ? o.c : []).slice(0, LIM.cards).filter(c => c && typeof c === 'object').map(c => {
    let media = null;
    try { media = mediaFor(c); } catch { media = null; }
    if (media && used.has(media)) media = null; // one media item belongs to one card
    if (media) {
      used.add(media);
      media = { ...media, drawing: c.d === 1 && media.type === 1, captions: media.type === 3 ? fitCaps(c.s, media.frames.length) : [] };
    }
    return newCard({
      id: str(c.k, 12).replace(/[^A-Za-z0-9_-]/g, '') || rid(5),
      title: str(c.t, LIM.ctitle), text: str(c.x, LIM.text),
      items: Array.isArray(c.l) ? c.l.slice(0, LIM.items).map(s => str(s, LIM.item)) : null,
      media,
    });
  });
  const comments = (Array.isArray(o.cm) ? o.cm : []).slice(-LIM.comments).filter(x => x && typeof x === 'object')
    .map(x => ({ name: str(x.n, LIM.name), text: str(x.x, LIM.comment), at: Number.isFinite(x.d) ? x.d : 0 }))
    .filter(x => x.text.trim());
  const id = str(o.id, 16).replace(/[^A-Za-z0-9_-]/g, '') || rid();
  return { id, title: str(o.t, LIM.title), intro: str(o.i, LIM.intro), updated: Number.isFinite(o.u) ? o.u : now(), cards, comments };
}
function guideFromDraft(s) {
  const o = JSON.parse(s);
  return guideFromJSON(o, c => typeof c.mb === 'string' ? mediaFromBytes(Core.fromB64u(c.mb), c.d === 1, c.s) : null);
}

// ---------- drafts: one record per guide id, so nothing is ever silently overwritten ----------
// record: { data: draftString, base: fnv of the last shared/received version, saved: ms, view }
const sig = s => { const b = new TextEncoder().encode(s); return Core.fnv(b, b.length); };
function loadRecord(id) { try { const r = JSON.parse(store.get('g.' + id)); return r && typeof r.data === 'string' ? r : null; } catch { return null; } }
function saveRecord(g, extra) {
  const data = draftString(g), old = loadRecord(g.id) || {};
  const rec = { base: old.base ?? null, view: old.view || 'read', ...extra, data, saved: Date.now() };
  return store.set('g.' + g.id, JSON.stringify(rec));
}
function listRecords() {
  return store.keys().filter(k => k.startsWith('g.')).map(k => {
    const r = loadRecord(k.slice(2));
    if (!r) return null;
    try { const o = JSON.parse(r.data); return { id: k.slice(2), title: str(o.t, LIM.title), cards: Array.isArray(o.c) ? o.c.length : 0, comments: Array.isArray(o.cm) ? o.cm.length : 0, saved: r.saved || 0 }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.saved - a.saved);
}

// ---------- app state ----------
let guide = null, view = 'home', linkErr = null;
let saveTimer = 0, linkTimer = 0, saveWarned = false;
const link = { data: '', ver: -1, building: null };
let version = 0; // bumps on every change; link cache is valid when link.ver === version
let timers = [];

function changed(opts = {}) { // call after any edit to the guide
  version++;
  guide.updated = now();
  if (location.hash) history.replaceState(null, '', location.pathname + location.search); // the draft is now the source
  sess.set('current', guide.id);
  clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400);
  clearTimeout(linkTimer); linkTimer = setTimeout(buildLink, opts.fast ? 0 : 500);
}
function saveNow() {
  clearTimeout(saveTimer);
  if (!guide) return;
  if (!saveRecord(guide, { view }) && !saveWarned) { saveWarned = true; toast("Couldn't save a draft on this device — share the link to keep your work"); }
}
async function buildLink() {
  if (!guide || link.ver === version) return link.data;
  const v = version, g = guide;
  const p = link.building = (async () => {
    const data = await encodeGuide(g);
    if (v === version && g === guide) { link.data = data; link.ver = v; renderMeter(); }
    return data;
  })();
  try { return await p; } catch (e) { console.error(e); return ''; }
}
const linkURL = data => location.href.split('#')[0] + '#' + data;

// ---------- media pipeline (mirrors sketch-lab.html) ----------
// maxW is the width of a 4:3 landscape frame; other shapes get the same pixel budget.
const scratch = document.createElement('canvas'); // one canvas reused: iOS frees canvases late and caps their total memory
function drawToImageData(src, sw, sh, maxW) {
  const w = Math.max(1, Math.min(maxW, sw, Math.round(Math.sqrt(maxW * maxW * 0.75 * sw / sh)))), hh = Math.max(1, Math.round(sh * w / sw));
  const c = scratch; c.width = w; c.height = hh;
  const ctx = c.getContext('2d'); // no willReadFrequently: Safari would scale every video frame in software (~4× slower)
  ctx.drawImage(src, 0, 0, w, hh);
  return ctx.getImageData(0, 0, w, hh);
}
function seek(v, t) {
  return new Promise(res => {
    const done = () => { clearTimeout(to); res(); };
    const to = setTimeout(done, 3000);
    v.addEventListener('seeked', done, { once: true });
    v.currentTime = t;
  });
}
async function extractFrames(url, maxW, opt, onProgress) {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
  await new Promise((res, rej) => {
    v.addEventListener('loadeddata', res, { once: true });
    v.addEventListener('loadedmetadata', () => setTimeout(res, 1500), { once: true }); // iOS may never fire loadeddata
    v.addEventListener('error', () => rej(new Error("This browser can't read that video")), { once: true });
    setTimeout(() => rej(new Error('The video took too long to load')), 15000);
    v.load();
  });
  if (!v.videoWidth) throw new Error("This browser can't read that video");
  if (!isFinite(v.duration)) await seek(v, 1e7); // e.g. recorded webm: forces the real duration
  const dur = isFinite(v.duration) ? v.duration : opt.secs || 10;
  let times = opt.times;
  if (!times) {
    const n = Math.max(1, Math.floor(Math.min(dur, opt.secs) * opt.fps));
    times = Array.from({ length: n }, (_, i) => i / opt.fps);
  }
  const list = [];
  for (let i = 0; i < times.length; i++) {
    await seek(v, Math.min(times[i] + 0.001, Math.max(0, dur - 0.05)));
    list.push(drawToImageData(v, v.videoWidth, v.videoHeight, maxW));
    onProgress(i + 1, times.length);
  }
  v.removeAttribute('src'); v.load();
  return { w: list[0].width, h: list[0].height, list, times };
}
// Frame extraction is the slow part; keep the last 2 results per video (raw frames are 16–40 MB).
function cached(src, key, fn) {
  src.cache = src.cache || new Map();
  if (!src.cache.has(key)) {
    src.cache.set(key, fn().catch(e => { src.cache.delete(key); throw e; }));
    while (src.cache.size > 2) src.cache.delete(src.cache.keys().next().value);
  }
  return src.cache.get(key);
}
async function loadBitmap(file) {
  try { // keep a 1024-px copy, not the full 12 MP photo (~48 MB decoded)
    const full = await createImageBitmap(file);
    const small = await createImageBitmap(drawToImageData(full, full.width, full.height, 1024)); full.close?.();
    return small;
  } catch {}
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url; await img.decode();
    return img;
  } catch { throw new Error("This browser can't open that photo — try a JPEG or PNG"); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
function sketchPhoto(src) {
  const id = drawToImageData(src, src.width, src.height, IMG_W);
  const { L } = Core.lum(id.data, id.width * id.height);
  // Bold clogs small sketches, so only apply it from 400px up.
  return { type: 1, w: id.width, h: id.height, fps: 0, frames: [Core.sketch(L, id.width, id.height, { ...S0, bold: id.width >= 400 }, null).out] };
}
async function sketchSteps(src, K, alive, progress) {
  const ana = await cached(src, 'scan', () => extractFrames(src.url, SCAN.w, { fps: SCAN.fps, secs: SCAN.secs }, (i, n) => progress(`Watching the video… ${Math.round(i / n * 100)}%`)));
  if (!alive()) return null;
  progress('Finding the key moments…'); await tick();
  let range = null;
  const Ls = ana.list.map(f => { const r = Core.lum(f.data, ana.w * ana.h, range); range = r.range; return r.L; });
  const times = Core.pickSteps(Ls, ana.w, ana.h, K).map(i => ana.times[i]);
  if (!alive()) return null;
  const full = await cached(src, `steps|${times.join(',')}`, () => extractFrames(src.url, IMG_W, { times }, (i, n) => progress(`Drawing step ${i} of ${n}…`)));
  if (!alive()) return null;
  const { w, h, list } = full, frames = [], shifts = [], SS = { ...S0, bold: w >= 400 };
  let prevL = null;
  for (const f of list) {
    const { L } = Core.lum(f.data, w * h);
    frames.push(Core.sketch(L, w, h, SS, null).out);
    if (prevL) { const e = Core.estimateShift(prevL, L, w, h, Math.round(w / 16)); shifts.push([e.dx, e.dy]); } else shifts.push([0, 0]);
    prevL = L;
    await tick(); if (!alive()) return null;
  }
  return { type: 3, w, h, fps: 0, frames, shifts };
}
async function sketchFlipbook(src, alive, progress) {
  const raw = await cached(src, 'flip', () => extractFrames(src.url, FLIP.w, { fps: FLIP.fps, secs: FLIP.secs }, (i, n) => progress(`Reading the video… ${Math.round(i / n * 100)}%`)));
  if (!alive()) return null;
  const { w, h, list } = raw, frames = [], shifts = [], VS = { ...S0, bold: w >= 400 };
  const R = Math.max(4, Math.round(w / 16));
  let range = null, prevL = null, prevLines = null;
  for (let k = 0; k < list.length; k++) {
    const r = Core.lum(list[k].data, w * h, range); range = r.range;
    let sh = [0, 0], pl = null;
    if (prevL) { const e = Core.estimateShift(prevL, r.L, w, h, R); sh = [e.dx, e.dy]; pl = Core.shiftFrame(prevLines, w, h, sh[0], sh[1]); }
    const sk = Core.sketch(r.L, w, h, VS, pl);
    frames.push(sk.out); shifts.push(sh); prevLines = sk.lines; prevL = r.L;
    if (k % 4 === 3) { progress(`Drawing frames… ${k + 1}/${list.length}`); await tick(); if (!alive()) return null; }
  }
  return { type: 2, w, h, fps: FLIP.fps, frames, shifts };
}
function finishMedia(model, drawing, captions) {
  const bytes = Core.encodeItem(model);
  return mediaFromBytes(bytes, drawing, captions); // show exactly what the link carries
}

// Run a media job for a card. Only the newest job per card may write its result.
async function runJob(card, label, work) {
  const job = card.job = (card.job || 0) + 1;
  const alive = () => card.job === job && guide && guide.cards.includes(card);
  card.busy = label; card.err = null; refreshCard(card);
  const progress = msg => { if (alive()) { card.busy = msg; const b = card.el && $('.busy-msg', card.el); if (b) b.textContent = msg; } };
  await tick(); await tick();
  try {
    const media = await work(alive, progress);
    if (!alive()) return;
    card.busy = null;
    if (media) { card.media = media; changed({ fast: true }); }
  } catch (e) {
    if (!alive()) return;
    card.busy = null; card.err = e.message || 'Something went wrong';
  }
  refreshCard(card);
}
function addPhoto(card, file) {
  card.src = null;
  runJob(card, 'Sketching the photo…', async () => {
    const bmp = await loadBitmap(file);
    await tick();
    return finishMedia(sketchPhoto(bmp), false);
  });
}
function addVideo(card, file) {
  if (card.src) URL.revokeObjectURL(card.src.url);
  card.src = { url: URL.createObjectURL(file), name: file.name };
  processVideo(card);
}
function processVideo(card) {
  const src = card.src, opts = card.opts, caps = card.media?.type === 3 ? card.media.captions : [];
  runJob(card, 'Opening the video…', async (alive, progress) => {
    const model = opts.mode === 'flip' ? await sketchFlipbook(src, alive, progress) : await sketchSteps(src, opts.steps, alive, progress);
    if (!model) return null;
    progress('Compressing…'); await tick();
    return finishMedia(model, false, caps);
  });
}
function removeStep(card, k) {
  const m = card.media;
  if (!m || m.type !== 3 || m.frames.length < 2) return;
  const frames = m.frames.filter((_, i) => i !== k), caps = m.captions.filter((_, i) => i !== k);
  card.media = finishMedia({ type: 3, w: m.w, h: m.h, fps: 0, frames, shifts: frames.map(() => [0, 0]) }, false, caps);
  changed({ fast: true }); refreshCard(card);
}

// ---------- rendering helpers ----------
function drawBits(canvas, bits, w, h) {
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; canvas._img = null; }
  const ctx = canvas.getContext('2d');
  const img = canvas._img || (canvas._img = ctx.createImageData(w, h));
  const d = img.data;
  for (let i = 0, j = 0; i < bits.length; i++, j += 4) {
    const c = bits[i] ? INK : PAPER;
    d[j] = c[0]; d[j + 1] = c[1]; d[j + 2] = c[2]; d[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}
function skCanvas(bits, w, ht, label) {
  const c = h('canvas', { class: 'sk', role: 'img', 'aria-label': label || 'Sketch' });
  drawBits(c, bits, w, ht);
  return c;
}
function zoomable(canvas, bits, m, caption) {
  return h('button', { class: 'zoom', type: 'button', 'aria-label': 'Enlarge sketch', onclick: () => lightbox(bits, m.w, m.h, caption) }, canvas);
}
function lightbox(bits, w, hh, caption) {
  const c = h('canvas', { role: 'img', 'aria-label': caption || 'Sketch' }); drawBits(c, bits, w, hh);
  const box = h('div', { class: 'lightbox', role: 'dialog', 'aria-label': 'Sketch', onclick: () => box.remove() }, c, caption ? h('p', { text: caption }) : null, h('p', { class: 'hint', style: 'color:#bbb', text: 'Tap to close' }));
  document.body.append(box);
}
function mediaView(m, title) {
  if (m.type === 3) {
    const grid = h('div', { class: 'steps' + (m.frames.length === 1 ? ' one' : '') });
    m.frames.forEach((f, k) => {
      const cap = m.captions[k] || '';
      grid.append(h('figure', { class: 'step' }, h('span', { class: 'badge', text: k + 1 }),
        zoomable(skCanvas(f, m.w, m.h, `Step ${k + 1}${cap ? ': ' + cap : ''}`), f, m, `${k + 1}. ${cap}`.trim()),
        cap ? h('figcaption', { text: cap }) : null));
    });
    return h('div', { class: 'media' }, grid);
  }
  const canvas = skCanvas(m.frames[0], m.w, m.h, m.drawing ? `Drawing: ${title}` : `Sketch: ${title}`);
  if (m.type === 2 && m.frames.length > 1) {
    let k = 0, playing = true;
    const state = h('span', { class: 'flip-state', text: 'Tap to pause' });
    const step = () => { k = (k + 1) % m.frames.length; drawBits(canvas, m.frames[k], m.w, m.h); };
    let t = setInterval(step, 1000 / (m.fps || 3)); timers.push(() => clearInterval(t));
    const btn = h('button', { class: 'zoom', type: 'button', 'aria-label': 'Pause or play', onclick: () => {
      playing = !playing; clearInterval(t);
      if (playing) { t = setInterval(step, 1000 / (m.fps || 3)); timers.push(() => clearInterval(t)); }
      state.textContent = playing ? 'Tap to pause' : 'Paused — tap to play';
    } }, canvas);
    return h('div', { class: 'media' }, h('div', { style: 'position:relative' }, btn, state));
  }
  return h('div', { class: 'media' }, zoomable(canvas, m.frames[0], m, title));
}
function clearTimers() { timers.forEach(f => f()); timers = []; }

// ---------- checklist state: per viewer, per day (never in the link) ----------
const today = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
function checks() { try { return JSON.parse(store.get(`chk.${guide.id}.${today()}`)) || {}; } catch { return {}; } }
function setCheck(key, on) {
  const c = checks(); if (on) c[key] = 1; else delete c[key];
  store.set(`chk.${guide.id}.${today()}`, JSON.stringify(c));
}

// ---------- views ----------
const main = () => $('#main');
function setView(v) {
  view = v; clearTimers();
  document.querySelectorAll('.lightbox,.scrim').forEach(e => e.remove());
  if (guide && (v === 'read' || v === 'edit')) {
    sess.set('current', guide.id);
    const rec = loadRecord(guide.id);
    if (rec && rec.view !== v) store.set('g.' + guide.id, JSON.stringify({ ...rec, view: v }));
  }
  ({ home: renderHome, read: renderRead, edit: renderEdit, error: renderError })[v]();
  window.scrollTo(0, 0);
}

function renderHome() {
  guide = null;
  $('#crumb').textContent = '';
  const recs = listRecords();
  fill(main(), 
    h('section', { class: 'hero' },
      h('h1', { text: 'Everything your sitter needs, in one link.' }),
      h('p', { text: 'Write the routine, add photos and short videos of where things are, then send a single link by WhatsApp or Messages. No app, no account, nothing uploaded.' }),
      h('ol', { class: 'how' },
        h('li', null, h('b', { text: '1' }), h('span', { text: 'Add cards: food, litter, walks, the vet. Photos and videos turn into light line sketches.' })),
        h('li', null, h('b', { text: '2' }), h('span', { text: 'Share the link. The whole guide lives inside it.' })),
        h('li', null, h('b', { text: '3' }), h('span', { text: 'Your sitter can leave notes ("fed her at 8pm") and send the updated link back.' }))),
      h('button', { class: 'btn primary', style: 'width:100%;min-height:54px;font-size:17px', id: 'newGuide', onclick: () => { guide = newGuide(); version++; saveNow(); setView('edit'); } }, icon('plus'), 'Start a new guide')),
    recs.length ? h('h2', { class: 'section-title', text: 'On this phone' }) : null,
    recs.length ? h('div', { class: 'guide-list' }, recs.map(r => h('div', { class: 'guide-row' },
      h('button', { class: 'open', onclick: () => openRecord(r.id) },
        h('span', { class: 't', text: r.title || 'Untitled guide' }),
        h('span', { class: 's', text: `${plural(r.cards, 'card')}${r.comments ? ' · ' + plural(r.comments, 'note') : ''} · ${new Date(r.saved).toLocaleDateString([], { day: 'numeric', month: 'short' })}` })),
      h('button', { class: 'icon-btn', 'aria-label': `Delete ${r.title || 'guide'}`, onclick: () => deleteRecord(r.id) }, icon('trash'))))) : null,
  );
  $('#dock').hidden = true;
}
function openRecord(id) {
  const rec = loadRecord(id);
  try { guide = guideFromDraft(rec.data); } catch { toast("That guide couldn't be opened"); return; }
  version++; link.ver = -1;
  setView(rec.view === 'edit' ? 'edit' : 'read');
  buildLink();
}
function deleteRecord(id) {
  const raw = store.get('g.' + id);
  store.del('g.' + id); renderHome();
  toast('Guide deleted', { label: 'Undo', fn: () => { if (raw) store.set('g.' + id, raw); renderHome(); } });
}

function renderError() {
  const [t, p] = LINK_MSG[linkErr] || LINK_MSG.damaged;
  $('#crumb').textContent = '';
  fill(main(), h('div', { class: 'err-card', id: 'linkError' }, icon('broken'), h('h1', { text: t }), h('p', { text: p }),
    h('button', { class: 'btn dark', style: 'width:100%', onclick: () => { history.replaceState(null, '', location.pathname + location.search); setView('home'); } }, 'Go to Pet List')));
  $('#dock').hidden = true;
}

function renderRead() {
  const g = guide, cards = liveCards(g), ch = checks();
  $('#crumb').textContent = '';
  const kicker = `Pet-sitting guide · updated ${new Date(g.updated * 1000).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}`;
  const titled = cards.filter(c => c.title.trim());
  fill(main(), 
    h('header', { class: 'g-head' },
      h('div', { class: 'kicker', text: kicker }),
      h('h1', { text: g.title.trim() || 'Pet-sitting guide' }),
      g.intro.trim() ? h('p', { class: 'intro', text: g.intro }) : null,
      titled.length > 2 ? h('nav', { class: 'toc', 'aria-label': 'Cards' }, titled.map(c => h('a', { href: '#', text: c.title, onclick: e => { e.preventDefault(); $('#c-' + c.id)?.scrollIntoView({ behavior: 'smooth' }); } }))) : null),
    cards.length ? h('div', { class: 'cards' }, cards.map(c => {
      const items = (c.items || []).filter(s => s.trim());
      return h('article', { class: 'card', id: 'c-' + c.id },
        c.title.trim() ? h('h2', { text: c.title }) : null,
        c.media ? mediaView(c.media, c.title) : null,
        c.text.trim() ? h('p', { class: 'text', text: c.text }) : null,
        items.length ? [h('ul', { class: 'checks' }, items.map(s => {
          const key = c.id + '|' + s;
          return h('li', null, h('label', null, h('input', { type: 'checkbox', checked: !!ch[key], onchange: e => setCheck(key, e.target.checked) }), h('span', { text: s })));
        })), h('div', { class: 'checks-foot', text: 'Ticks are just for you and reset each day.' })] : null);
    })) : h('p', { class: 'empty-note', text: 'This guide is empty so far. Tap Edit to add cards.' }),
    notesSection(),
  );
  dock([
    h('button', { class: 'btn', id: 'editBtn', onclick: () => setView('edit') }, icon('edit'), 'Edit'),
    h('button', { class: 'btn primary', id: 'shareBtn', onclick: share }, icon('share'), 'Share'),
  ], false);
}

function notesSection() {
  const g = guide, list = g.comments.slice().sort((a, b) => a.at - b.at);
  const name = h('input', { class: 'in', id: 'cName', maxlength: LIM.name, placeholder: 'Your name', autocomplete: 'name', value: store.get('name') || '' });
  const text = h('textarea', { class: 'in', id: 'cText', maxlength: LIM.comment, rows: 3, placeholder: 'e.g. Fed her at 8pm, she ate half. Litter done.', oninput: autoGrow });
  const add = () => {
    const t = text.value.trim();
    if (!t) { text.focus(); return; }
    const n = name.value.trim().slice(0, LIM.name);
    store.set('name', n);
    g.comments.push({ name: n, text: t.slice(0, LIM.comment), at: now() });
    changed({ fast: true }); saveNow();
    renderRead();
    $('#notes')?.scrollIntoView({ block: 'start' });
    toast('Note added — share the link so others see it', { label: 'Share', fn: share });
  };
  return h('section', { class: 'notes', id: 'notes' },
    h('h2', { text: 'Notes' }),
    h('p', { class: 'sub', text: list.length ? 'Updates from whoever is looking after things.' : 'Looking after them? Leave a note, then share the updated link back.' }),
    list.map(commentView),
    h('form', { class: 'form', onsubmit: e => { e.preventDefault(); add(); } },
      name, text, h('button', { class: 'btn dark', type: 'submit', id: 'cAdd' }, 'Add note')));
}
function commentView(c, onDelete) {
  const when = c.at ? new Date(c.at * 1000).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  return h('div', { class: 'comment' },
    h('div', { class: 'body' }, h('div', { class: 'who' }, c.name || 'Someone', h('span', { class: 'when', text: when })), h('p', { text: c.text })),
    typeof onDelete === 'function' ? h('button', { class: 'icon-btn', 'aria-label': 'Delete note', onclick: onDelete }, icon('trash')) : null);
}

function autoGrow(e) { const t = e.target || e; t.style.height = 'auto'; t.style.height = t.scrollHeight + 2 + 'px'; }

function renderEdit() {
  const g = guide;
  $('#crumb').textContent = 'Editing';
  const title = h('input', { class: 'in title-in', id: 'gTitle', maxlength: LIM.title, placeholder: "Pet's name, e.g. Miso & Pepper", value: g.title, oninput: e => { g.title = e.target.value; changed(); } });
  const intro = h('textarea', { class: 'in', id: 'gIntro', maxlength: LIM.intro, rows: 3, placeholder: 'A few words for the sitter: personalities, keys, how to reach you…', value: g.intro, oninput: e => { g.intro = e.target.value; autoGrow(e); changed(); } });
  const list = h('div', { class: 'cards', id: 'editCards' });
  g.cards.forEach((c, i) => list.append(editCard(c, i)));
  fill(main(), 
    h('div', { class: 'field' }, h('label', { class: 'sr', for: 'gTitle', text: 'Title' }), title),
    h('div', { class: 'field', style: 'margin-top:12px' }, h('label', { class: 'sr', for: 'gIntro', text: 'Intro' }), intro),
    list,
    h('div', { class: 'add-row' },
      h('button', { class: 'btn', id: 'addCard', onclick: () => addCard(newCard()) }, icon('note'), 'Add card'),
      h('button', { class: 'btn', id: 'addList', onclick: () => addCard(newCard({ items: [''] })) }, icon('list'), 'Add checklist')),
    g.comments.length ? h('section', { class: 'notes' }, h('h2', { text: 'Notes' }), h('p', { class: 'sub', text: 'Notes left on this guide. Remove any you no longer need.' }),
      g.comments.map(c => commentView(c, () => { g.comments.splice(g.comments.indexOf(c), 1); changed({ fast: true }); renderEdit(); }))) : null,
  );
  requestAnimationFrame(() => document.querySelectorAll('#main textarea').forEach(autoGrow));
  dock([
    h('button', { class: 'btn', id: 'previewBtn', onclick: () => { saveNow(); setView('read'); } }, icon('eye'), 'Preview'),
    h('button', { class: 'btn primary', id: 'shareBtn', onclick: share }, icon('share'), 'Share'),
  ], true);
}
function addCard(c) {
  guide.cards.push(c); changed();
  const el = editCard(c, guide.cards.length - 1);
  $('#editCards').append(el);
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('.card-title', el).focus({ preventScroll: true });
}
function renumber() {
  document.querySelectorAll('#editCards > .card').forEach((el, i, all) => {
    $('.num', el).textContent = i + 1;
    $('[data-act=up]', el).disabled = i === 0; $('[data-act=down]', el).disabled = i === all.length - 1;
  });
}
function moveCard(c, d) {
  const a = guide.cards, i = a.indexOf(c), j = i + d;
  if (j < 0 || j >= a.length) return;
  a.splice(i, 1); a.splice(j, 0, c); changed();
  const list = $('#editCards');
  if (d < 0) list.insertBefore(c.el, list.children[j]); else list.insertBefore(c.el, list.children[j + 1] || null);
  renumber();
  c.el.scrollIntoView({ block: 'nearest' });
}
function deleteCard(c) {
  const i = guide.cards.indexOf(c);
  guide.cards.splice(i, 1); c.job = (c.job || 0) + 1; changed();
  c.el.remove(); renumber();
  toast(`Card ${c.title ? '“' + c.title.slice(0, 30) + '”' : ''} removed`, { label: 'Undo', fn: () => { guide.cards.splice(i, 0, c); changed(); renderEdit(); } });
}

function editCard(c, i) {
  const hint = c.hint || (c.items ? ['Checklist title', ''] : ['Card title', '']);
  const el = h('article', { class: 'card edit', 'data-card': c.id },
    h('div', { class: 'ehead' },
      h('span', { class: 'num', text: i + 1 }),
      h('input', { class: 'in card-title', maxlength: LIM.ctitle, placeholder: hint[0], value: c.title, 'aria-label': 'Card title', oninput: e => { c.title = e.target.value; changed(); } }),
      h('button', { class: 'icon-btn', 'data-act': 'up', 'aria-label': 'Move up', disabled: i === 0, onclick: () => moveCard(c, -1) }, icon('up')),
      h('button', { class: 'icon-btn', 'data-act': 'down', 'aria-label': 'Move down', disabled: i === guide.cards.length - 1, onclick: () => moveCard(c, 1) }, icon('down')),
      h('button', { class: 'icon-btn', 'data-act': 'del', 'aria-label': 'Delete card', onclick: () => deleteCard(c) }, icon('trash'))),
    h('textarea', { class: 'in card-text' + (c.items ? ' short' : ''), rows: c.items ? 1 : 3, maxlength: LIM.text, 'aria-label': 'Card text',
      placeholder: c.items ? 'Notes (optional)' : (hint[1] || 'What should the sitter know?'), value: c.text, oninput: e => { c.text = e.target.value; autoGrow(e); changed(); } }),
    c.items ? listEditor(c, hint) : null,
    h('div', { class: 'mslot' }));
  c.el = el;
  fillMedia(c);
  return el;
}
function refreshCard(c) { if (c.el && view === 'edit') fillMedia(c); }

function listEditor(c, hint) {
  const box = h('div', { class: 'list-edit' });
  const row = (k) => {
    const inp = h('input', { class: 'in', maxlength: LIM.item, value: c.items[k], placeholder: k === 0 && hint[1] ? hint[1] : 'Another task…', 'aria-label': `Checklist item ${k + 1}`,
      oninput: e => { c.items[rowIndex(r)] = e.target.value; changed(); },
      onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); insertItem(rowIndex(r) + 1); } } });
    const r = h('div', { class: 'row' }, h('span', { class: 'box' }), inp,
      h('button', { class: 'icon-btn', 'aria-label': 'Remove item', onclick: () => { const j = rowIndex(r); c.items.splice(j, 1); r.remove(); changed(); } }, icon('x')));
    return r;
  };
  const rowIndex = r => [...box.querySelectorAll('.row')].indexOf(r);
  const insertItem = (k) => {
    if (c.items.length >= LIM.items) return;
    c.items.splice(k, 0, ''); changed();
    const r = row(k), rows = box.querySelectorAll('.row');
    box.insertBefore(r, rows[k] || addBtn);
    $('input', r).focus();
  };
  c.items.forEach((_, k) => box.append(row(k)));
  const addBtn = h('button', { class: 'btn small ghost', style: 'justify-self:start', onclick: () => insertItem(c.items.length) }, icon('plus'), 'Add item');
  box.append(addBtn);
  return box;
}

function fillMedia(c) {
  const slot = $('.mslot', c.el); if (!slot) return;
  const m = c.media;
  if (c.busy) {
    fill(slot, h('div', { class: 'mblock' }, h('div', { class: 'busy' }, h('div', { class: 'spinner' }), h('span', { class: 'busy-msg', text: c.busy }))));
    return;
  }
  const err = c.err ? h('p', { class: 'merr', role: 'alert', text: c.err }) : null;
  if (!m) {
    fill(slot, h('div', { class: 'addmedia' },
      h('button', { class: 'btn', 'data-act': 'photo', onclick: () => pick('#filePhoto', f => addPhoto(c, f)) }, icon('photo'), 'Photo'),
      h('button', { class: 'btn', 'data-act': 'video', onclick: () => pick('#fileVideo', f => addVideo(c, f)) }, icon('video'), 'Video'),
      h('button', { class: 'btn', 'data-act': 'draw', onclick: () => openDrawing(c) }, icon('draw'), 'Draw')), err);
    return;
  }
  const size = `${fmtK(b64len(m.bytes.length))} characters`;
  let body, tools = [];
  if (m.type === 3) {
    body = h('div', { class: 'steps' + (m.frames.length === 1 ? ' one' : '') }, m.frames.map((f, k) => h('figure', { class: 'step step-edit' },
      h('span', { class: 'badge', text: k + 1 }),
      m.frames.length > 1 ? h('button', { class: 'rm', 'aria-label': `Remove step ${k + 1}`, onclick: () => removeStep(c, k) }, icon('x')) : null,
      skCanvas(f, m.w, m.h, `Step ${k + 1}`),
      h('input', { class: 'cap', maxlength: LIM.cap, placeholder: `Step ${k + 1}: what happens here?`, value: m.captions[k], 'aria-label': `Caption for step ${k + 1}`,
        oninput: e => { m.captions[k] = e.target.value; changed(); } }))));
  } else body = mediaView(m, c.title);
  if (m.type !== 1 && c.src) {
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Video style' },
      h('button', { 'aria-pressed': String(c.opts.mode === 'steps'), onclick: () => { c.opts.mode = 'steps'; processVideo(c); } }, 'Steps'),
      h('button', { 'aria-pressed': String(c.opts.mode === 'flip'), onclick: () => { c.opts.mode = 'flip'; processVideo(c); } }, 'Flipbook'));
    tools.push(seg);
    if (c.opts.mode === 'steps') {
      const sel = h('select', { class: 'sel', 'aria-label': 'Most steps', onchange: e => { c.opts.steps = +e.target.value; processVideo(c); } },
        [2, 3, 4, 5, 6].map(n => h('option', { value: n, text: `Up to ${n} steps` })));
      sel.value = String(c.opts.steps);
      tools.push(sel);
    }
  }
  const kind = m.drawing ? 'Drawing' : m.type === 1 ? 'Photo sketch' : m.type === 2 ? `Flipbook · ${m.frames.length} frames` : plural(m.frames.length, 'step');
  fill(slot, h('div', { class: 'mblock' }, body,
    tools.length ? h('div', { class: 'mtools' }, tools) : null,
    h('div', { class: 'mtools' },
      h('span', { class: 'msize grow', text: `${kind} · ${size}` }),
      m.drawing ? h('button', { class: 'btn small', onclick: () => openDrawing(c) }, icon('draw'), 'Edit') : null,
      h('button', { class: 'btn small danger', 'data-act': 'rmmedia', onclick: () => {
        const old = c.media; c.media = null; c.job = (c.job || 0) + 1; changed({ fast: true }); refreshCard(c);
        toast('Picture removed', { label: 'Undo', fn: () => { c.media = old; changed({ fast: true }); refreshCard(c); } });
      } }, 'Remove'))), err);
}
function pick(sel, fn) {
  const inp = $(sel);
  inp.value = '';
  inp.onchange = () => { const f = inp.files && inp.files[0]; inp.onchange = null; if (f) fn(f); };
  inp.click();
}

// ---------- drawing ----------
function openDrawing(card) {
  const W = DRAW_W, H = DRAW_H;
  const base = card.media && card.media.drawing && card.media.w === W && card.media.h === H ? card.media.frames[0] : null;
  let strokes = [], tool = 'pen', keepBase = !!base, cur = null;
  const canvas = h('canvas', { class: 'draw-canvas', width: W, height: H, 'aria-label': 'Drawing area' });
  const ctx = canvas.getContext('2d');
  const baseImg = base ? (() => { const c = document.createElement('canvas'); drawBits(c, base, W, H); return c; })() : null;
  const SIZES = { pen: 3, marker: 8, eraser: 22 };
  const paint = s => {
    ctx.strokeStyle = s.tool === 'eraser' ? 'rgb(255,253,247)' : 'rgb(27,27,27)';
    ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = SIZES[s.tool]; ctx.lineCap = ctx.lineJoin = 'round';
    const p = s.pts;
    if (p.length === 1) { ctx.beginPath(); ctx.arc(p[0][0], p[0][1], SIZES[s.tool] / 2, 0, 7); ctx.fill(); return; }
    ctx.beginPath(); ctx.moveTo(p[0][0], p[0][1]);
    for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
    ctx.stroke();
  };
  const redraw = () => {
    ctx.fillStyle = 'rgb(255,253,247)'; ctx.fillRect(0, 0, W, H);
    if (keepBase && baseImg) ctx.drawImage(baseImg, 0, 0);
    strokes.forEach(paint);
  };
  const pos = e => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height]; };
  canvas.addEventListener('pointerdown', e => {
    e.preventDefault(); canvas.setPointerCapture?.(e.pointerId);
    cur = { tool, pts: [pos(e)] }; strokes.push(cur); paint(cur);
  });
  canvas.addEventListener('pointermove', e => {
    if (!cur) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of (evs.length ? evs : [e])) cur.pts.push(pos(ev));
    const p = cur.pts, n = p.length;
    ctx.strokeStyle = cur.tool === 'eraser' ? 'rgb(255,253,247)' : 'rgb(27,27,27)'; ctx.lineWidth = SIZES[cur.tool]; ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(p[Math.max(0, n - evs.length - 1)][0], p[Math.max(0, n - evs.length - 1)][1]);
    for (let i = Math.max(0, n - evs.length); i < n; i++) ctx.lineTo(p[i][0], p[i][1]);
    ctx.stroke();
  });
  const end = () => { cur = null; };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  const toolBtn = (id, label) => h('button', { 'aria-pressed': String(tool === id), 'data-tool': id, onclick: e => { tool = id; e.currentTarget.parentNode.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tool === id))); } }, label);
  const close = () => scrim.remove();
  const done = () => {
    redraw(); // one path per stroke: the live segments overlap and would threshold into dots
    const d = ctx.getImageData(0, 0, W, H).data, bits = new Uint8Array(W * H);
    let ink = 0;
    for (let i = 0, j = 0; i < bits.length; i++, j += 4) if (d[j] + d[j + 1] + d[j + 2] < 384) { bits[i] = 1; ink++; }
    close();
    if (!ink) { if (card.media?.drawing) { card.media = null; changed({ fast: true }); refreshCard(card); } return; }
    card.media = finishMedia({ type: 1, w: W, h: H, fps: 0, frames: [bits] }, true);
    card.src = null; card.err = null; changed({ fast: true }); refreshCard(card);
  };
  const scrim = h('div', { class: 'scrim' }, h('div', { class: 'sheet draw-sheet', role: 'dialog', 'aria-label': 'Draw a sketch' },
    h('div', { class: 'draw-top' }, h('button', { class: 'btn ghost', onclick: close }, 'Cancel'), h('h3', { text: 'Draw', style: 'text-align:center' }), h('button', { class: 'btn primary', id: 'drawDone', onclick: done }, 'Done')),
    canvas,
    h('div', { class: 'tools' },
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Tool' }, toolBtn('pen', 'Pen'), toolBtn('marker', 'Marker'), toolBtn('eraser', 'Eraser')),
      h('button', { class: 'icon-btn', 'aria-label': 'Undo', onclick: () => { strokes.pop(); redraw(); } }, icon('undo')),
      h('button', { class: 'btn small ghost', onclick: () => { strokes = []; keepBase = false; redraw(); } }, 'Clear')),
    h('p', { class: 'hint', text: 'Sketch a floor plan, where the food is, which key opens what…' })));
  document.body.append(scrim);
  redraw();
}

// ---------- dock, meter & share ----------
function dock(buttons, meter) {
  const inner = $('#dockInner');
  fill(inner, 
    meter ? h('div', { class: 'meter-row', id: 'meterRow' }, h('div', { class: 'meter', role: 'meter', 'aria-label': 'Link size', 'aria-valuemin': 0, 'aria-valuemax': BUDGET }, h('i', { id: 'meterFill' })), h('span', { class: 'mtext', id: 'meterText', text: 'Measuring…' })) : null,
    meter ? h('div', { class: 'over-msg', id: 'overMsg', hidden: true, text: 'Too big for one chat message — remove a video or use fewer steps.' }) : null,
    h('div', { class: 'row' }, buttons));
  $('#dock').hidden = false;
  if (meter) { renderMeter(); buildLink(); }
}
function renderMeter() {
  const row = $('#meterRow'); if (!row) return;
  const fresh = link.ver === version, n = link.data.length;
  if (!fresh && !link.data) return;
  $('#meterFill').style.width = Math.min(100, n / BUDGET * 100) + '%';
  $('.meter', row).setAttribute('aria-valuenow', n);
  row.classList.toggle('warn', n > BUDGET * 0.8 && n <= BUDGET);
  row.classList.toggle('over', n > BUDGET);
  $('#meterText').textContent = `${fmtK(n)} / ${fmtK(BUDGET)} characters`;
  $('#overMsg').hidden = n <= BUDGET;
}

async function share() {
  if (guide.cards.some(c => c.busy)) { toast('Wait for the sketches to finish'); return; }
  const data = link.ver === version ? link.data : await buildLink();
  if (!data) { toast("Couldn't build the link"); return; }
  const url = linkURL(data);
  if (data.length > BUDGET || location.protocol === 'file:') return shareSheet(url, data.length);
  if (navigator.share) {
    try { await navigator.share({ title: guide.title || 'Pet-sitting guide', url }); shared(); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); shared(); toast('Link copied — paste it into WhatsApp or Messages'); return; } catch {}
  shareSheet(url, data.length);
}
function shared() { // the link now holds this version: an incoming link may replace it without asking
  saveRecord(guide, { base: sig(draftString(guide)), view });
}
function shareSheet(url, n) {
  const over = n > BUDGET;
  const ta = h('textarea', { class: 'link', id: 'linkOut', readonly: true, 'aria-label': 'Link', value: url, onfocus: e => e.target.select(), oncopy: () => shared() });
  const close = () => scrim.remove();
  const scrim = h('div', { class: 'scrim', onclick: e => { if (e.target === scrim) close(); } }, h('div', { class: 'sheet', role: 'dialog', 'aria-label': 'Share' },
    h('h3', { text: over ? 'This link is too big' : 'Share this guide' }),
    over ? h('p', { class: 'over-msg', text: `${fmtK(n)} characters — too big for one chat message (about ${fmtK(BUDGET)}). Remove a video or use fewer steps.` })
      : h('p', { text: `${fmtK(n)} characters. Send it as one message; whoever opens it sees the whole guide.` }),
    location.protocol === 'file:' ? h('p', { class: 'hint', text: 'This page was opened from a file, so the link only works on this device. Put petlist.html and sketch-core.js on a website (e.g. GitHub Pages) to share it.' }) : null,
    ta,
    h('div', { class: 'actions' },
      navigator.share ? h('button', { class: 'btn primary', onclick: async () => { try { await navigator.share({ title: guide.title || 'Pet-sitting guide', url }); shared(); close(); } catch {} } }, icon('share'), over ? 'Share anyway' : 'Share…') : null,
      h('button', { class: 'btn' + (navigator.share ? '' : ' primary'), id: 'copyBtn', onclick: async () => {
        try { await navigator.clipboard.writeText(url); toast('Link copied'); shared(); close(); }
        catch { ta.focus(); ta.select(); toast('Select the link above and copy it'); }
      } }, icon('copy'), 'Copy link'),
      h('button', { class: 'btn ghost', onclick: close }, 'Close'))));
  document.body.append(scrim);
}

// ---------- opening links ----------
async function openFromHash() {
  const hash = location.hash;
  if (hash.length < 2) return false;
  let g;
  $('#crumb').textContent = ''; $('#dock').hidden = true; $('#toast').classList.remove('show'); clearTimers();
  fill(main(), h('div', { class: 'busy', style: 'min-height:50vh' }, h('div', { class: 'spinner' }), h('span', { text: 'Opening the guide…' })));
  try { await tick(); g = await decodeGuide(hash); }
  catch (e) { console.warn('link error', e); linkErr = e instanceof LinkError ? e.code : 'damaged'; setView('error'); return true; }
  const rec = loadRecord(g.id), gs = draftString(g);
  if (rec && rec.data !== gs && sig(rec.data) !== rec.base) {
    // This phone has changes to this guide that were never shared. Ask — never overwrite silently.
    let mine; try { mine = guideFromDraft(rec.data); } catch { mine = null; }
    if (mine) return askConflict(g, mine, rec);
  }
  adopt(g);
  return true;
}
function adopt(g) {
  guide = g; version++; link.ver = -1;
  saveRecord(g, { base: sig(draftString(g)), view: 'read' });
  setView('read');
  buildLink();
}
function askConflict(g, mine, rec) {
  $('#dock').hidden = true;
  fill(main(), h('div', { class: 'err-card', id: 'conflict' },
    h('h1', { text: 'You have unsent changes' }),
    h('p', { text: `This phone has a version of “${mine.title || 'this guide'}” with changes you haven't shared yet (last edited ${new Date(rec.saved).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}). The link has a different version.` }),
    h('div', { style: 'display:grid;gap:10px' },
      h('button', { class: 'btn primary', id: 'useLink', onclick: () => {
        mine.id = rid(); mine.title = (mine.title || 'Guide') + ' (my edits)'; saveRecord(mine, { view: 'edit' });
        adopt(g); toast('Your edits were kept as a separate copy');
      } }, "Open the link's version"),
      h('button', { class: 'btn', id: 'keepMine', onclick: () => {
        history.replaceState(null, '', location.pathname + location.search);
        guide = mine; version++; link.ver = -1; setView(rec.view === 'edit' ? 'edit' : 'read'); buildLink();
      } }, 'Keep my version'),
      h('p', { class: 'hint', text: "Opening the link's version keeps yours as a separate copy." }))));
}

async function start() {
  if (await openFromHash()) return;
  const cur = sess.get('current');
  if (cur && loadRecord(cur)) { openRecord(cur); return; }
  setView('home');
}
window.addEventListener('hashchange', () => { if (location.hash.length > 1) openFromHash(); });
window.addEventListener('pagehide', saveNow);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });
$('#homeBtn').addEventListener('click', () => { saveNow(); if (location.hash) history.replaceState(null, '', location.pathname + location.search); sess.set('current', ''); setView('home'); });

// test/debug hook (read-only views of state)
window.PetList = { get guide() { return guide; }, get view() { return view; }, buildLink, encodeGuide, decodeGuide, linkURL };
start();
