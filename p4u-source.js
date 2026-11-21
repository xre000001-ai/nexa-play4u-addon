'use strict';
/* p4u-source.js — ★ v2.4: **Play4u (play4u.org)** — আলাদা টার্গেট, Play4u
 *
 * প্রমাণ (curl + পেজ-পার্স):
 *   GET https://play4u.org/watch/tt0770828                → 200, ভেতরে window.__PA_PLAY__ {...}
 *   __PA_PLAY__.streams[].m3u8_url = "pa!~<XOR(base64url(আসল url), SEAL_KEY)>"
 *   SEAL_KEY = window.__PA_SEAL_KEY__ = "pa4u-stream-seal-v1"
 *   unseal → https://furiosamedia.vip/range/….html   (মাস্টার)
 *   ⚠ ওই হোস্ট **referer=https://play4u.org/** ছাড়া 302 করে ⇒ সব কিছু আমাদের /t/ রিলে দিয়ে
 *     যাবে (আর রিলে নিজেই **প্রক্সি-পুল প্রথমে** ব্যবহার করবে — সার্ভারের ডেটাসেন্টার IP-তে
 *     সাইট/সিডিএন ব্লক করে: "if you are using warp or vpn please disable it")।
 *   মাস্টার-প্লেলিস্টে ৪টি ভ্যারিয়েন্ট: 1080p, 1080p_hevc, 720p, 360p
 *   ⇒ প্রতি ভ্যারিয়েন্টের আলাদা কার্ড (ইউজার ম্যানুয়ালি কোয়ালিটি বাছতে চান, অটো নয়)।
 *   সিরিজ: /series/<imdb>                  → সিজন-চিপ /series/<imdb>/s-05/ep-01
 *          /series/<imdb>/s-05/ep-10       → ওই এপিসোডের __PA_PLAY__
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const HOST = 'https://play4u.org';
const REF = HOST + '/';
const SEAL = 'pa4u-stream-seal-v1';
const TMDB_KEY = process.env.TMDB_KEY || '1865f43a0549ca50d341dd9ab8b29f49';
const POOL = (() => { try { return require('./p4u-pool'); } catch (e) { return null; } })();

/* ── সিল (XOR + base64url) ─────────────────────────────────────────── */
function unseal(s) {
  try {
    const t = String(s || '');
    if (!t.startsWith('pa!~')) return t;
    const b = Buffer.from(t.slice(4).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const out = Buffer.alloc(b.length);
    for (let i = 0; i < b.length; i++) out[i] = b[i] ^ SEAL.charCodeAt(i % SEAL.length);
    return out.toString('utf8');
  } catch (e) { return ''; }
}
function seal(s) {
  const b = Buffer.from(String(s || ''), 'utf8');
  const out = Buffer.alloc(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b[i] ^ SEAL.charCodeAt(i % SEAL.length);
  return 'pa!~' + out.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ── HTTP: **প্রক্সি-পুল আগে**, না থাকলে ডাইরেক্ট (ইউজারের নির্দেশ) ── */
async function get(url, { ms = 9000, proxyFirst = true } = {}) {
  const H = { 'user-agent': UA, referer: REF, origin: HOST, accept: 'text/html,application/xhtml+xml,*/*' };
  const verN = proxyFirst && POOL && POOL.okNodes ? POOL.okNodes().filter(n => n.verified).length : 0;
  if (verN > 0) {
    try {
      const pr = await POOL.pfetch(url, { ms, ua: UA, headers: H });
      if (pr.status === 200 && pr.body && pr.body.length) return { code: 200, txt: pr.body.toString('utf8'), via: pr.via || 'proxy' };
    } catch (e) { }
  }
  try {
    const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(ms), redirect: 'follow' });
    return { code: r.status, txt: await r.text(), via: 'direct' };
  } catch (e) { return { code: 0, txt: '', err: String(e.message || e) }; }
}

/* ── প্লেলিস্ট-টেক্সট: পুল-ফার্স্ট, ব্যর্থ/জাঙ্ক হলে ডাইরেক্ট ── */
async function fetchText(url, { ms = 10000, ref, origin } = {}) {
  const H = { 'user-agent': UA, referer: ref || REF, origin: origin || HOST, accept: '*/*' };
  const good = t => /^\s*(#EXTM3U|<\?xml|<MPD)/i.test(String(t || '').slice(0, 200));
  if (POOL && POOL.stats && POOL.stats().ok > 0) {
    try {
      const pr = await POOL.pfetch(url, { ms, ua: UA, headers: H, noDirect: true });
      if (pr.status === 200 && pr.body) { const t = pr.body.toString('utf8'); if (good(t)) return { code: 200, txt: t, via: pr.via }; }
    } catch (e) { }
  }
  try {
    const r = await fetch(url, { headers: H, redirect: 'follow', signal: AbortSignal.timeout(ms) });
    const t = await r.text();
    return { code: good(t) ? 200 : (r.status || 0), txt: t, via: 'direct' };
  } catch (e) { return { code: 0, txt: '', via: 'direct', err: String(e.message || e) }; }
}

/* মাস্টার → ভ্যারিয়েন্ট ম্যাপিং ক্যাশ (প্রতি সেগমেন্ট-রিকোয়েস্টে মাস্টার টানা বন্ধ) */
const VMAP = new Map();
async function variantOf(master, pick, opts = {}) {
  const hit = VMAP.get(master);
  let list = hit && Date.now() - hit.at < 600000 ? hit.list : null;
  if (!list) {
    const r = await fetchText(master, opts);
    list = r.code === 200 ? parseVariants(r.txt) : [];
    if (list.length) VMAP.set(master, { at: Date.now(), list });
    if (VMAP.size > 300) VMAP.clear();
  }
  if (!list.length) return null;
  return list.find(v => v.label === pick) || list.find(v => (v.label || '').includes(pick)) || list[0];
}

/* ── __PA_PLAY__ JSON বের করা (brace ಮ್ಯাচিং, regex নয়) ── */
function grabPlay(html) {
  const i = html.indexOf('__PA_PLAY__');
  if (i < 0) return null;
  const s = html.indexOf('{', i);
  if (s < 0) return null;
  let d = 0, inStr = false, esc = false;
  for (let k = s; k < html.length; k++) {
    const c = html[k];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') d++; else if (c === '}') { d--; if (!d) { try { return JSON.parse(html.slice(s, k + 1)); } catch (e) { return null; } } }
  }
  return null;
}

/* ★ v3.4: বছর — সিরিজ-পাতায় release_date থাকে না ⇒ TMDB থেকে (ভিডির কার্ডেও বছর আছে) */
const YC = new Map();
async function yearOf(id, type, fallback) {
  if (fallback) return fallback;
  const k = type + ':' + id;
  if (YC.has(k)) return YC.get(k);
  try {
    const kind = (type === 'tv' || type === 'series') ? 'tv' : 'movie';
    const u = `https://api.themoviedb.org/3/${kind}/${String(id).replace(/^tmdb|^tt/i, '')}/external_ids?api_key=${TMDB_KEY}`;
    void u;
    /* imdb-id থাকলে TMDB find দিয়ে বছর */
    const f = `https://api.themoviedb.org/3/find/${id}?external_source=imdb_id&language=en-US&api_key=${TMDB_KEY}`;
    const r = await fetch(f, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    const arr = (kind === 'tv' ? (j.tv_results || []) : (j.movie_results || []));
    const d = arr[0] ? String(arr[0].first_air_date || arr[0].release_date || '') : '';
    const y = d.slice(0, 4);
    YC.set(k, y);
    return y;
  } catch (e) { return ''; }
}

/* ── tmdb → imdb (play4u-এর রুট imdb-ভিত্তিক) ── */
async function toImdb(id, type) {
  const s = String(id || '');
  if (/^tt\d+$/i.test(s)) return s.toLowerCase();
  try {
    const k = type === 'tv' || type === 'series' ? 'tv' : 'movie';
    const u = `https://api.themoviedb.org/3/${k}/${s.replace(/^tmdb/i, '')}/external_ids?api_key=${TMDB_KEY}`;
    const r = await fetch(u, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    return j && j.imdb_id ? j.imdb_id : null;
  } catch (e) { return null; }
}

const pad = n => String(Math.max(1, Number(n) || 1)).padStart(2, '0');

/* ── মাস্টার-প্লেলিস্টের ভ্যারিয়েন্ট তালিকা ── */
/* ★ v3.2: height → স্ট্যান্ডার্ড লেবেল। ক্যাচ: 1280x720 = 720p (আগে >=700 ধরে 1080 হয়ে যেত) */
function qLabel(h, w) {
  /* ★★ v3.2: লেবেল **প্রস্থ (width)** থেকে — কারণ 1920x800 মানে ১০৮০p কনটেন্ট (সিনেমাস্কোপ),
     শুধু height দিলে ৭২০ দেখাত (ইউজারের অভিযোগ: "720p এর ও 1080p show করতেছে")। */
  const W = Number(w) || 0, H = Number(h) || 0;
  const n = W || H;
  if (!n) return '';
  if (W) {
    if (W >= 3400) return '2160';
    if (W >= 1700) return '1080';
    if (W >= 1100) return '720';
    if (W >= 800) return '480';
    if (W >= 600) return '360';
    return '240';
  }
  if (H >= 2000) return '2160';
  if (H >= 900) return '1080';
  if (H >= 650) return '720';
  if (H >= 450) return '480';
  if (H >= 330) return '360';
  return '240';
}
function vLabel(v) {
  const l = String((v && v.label) || '');
  if (/hevc|hvc1|hev1/i.test(l)) return 'HEVC';
  if (/avc|h264/i.test(l)) return 'H.264';
  return l;
}
function parseVariants(txt) {
  const out = [];
  const lines = txt.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i].trim();
    if (!/^#EXT-X-STREAM-INF/i.test(L)) continue;
    const res = (L.match(/RESOLUTION=(\d+)x(\d+)/i) || []);
    const w = res[1] ? Number(res[1]) : 0;
    const h = res[2] ? Number(res[2]) : 0;
    const id = (L.match(/STABLE-VARIANT-ID="([^"]+)"/i) || [])[1] || (h ? h + 'p' : '');
    const codecs = (L.match(/CODECS="([^"]+)"/i) || [])[1] || '';
    const bw = Number((L.match(/BANDWIDTH=(\d+)/i) || [])[1] || 0);
    let uri = '';
    for (let k = i + 1; k < lines.length && k < i + 6; k++) {
      const t = lines[k].trim();
      if (!t) continue;
      if (t[0] !== '#') { uri = t; break; }
    }
    if (!uri) continue;
    out.push({ label: id || (w ? w + 'x' + h : 'AUTO'), height: h, width: w, codecs, bw, uri });
  }
  /* একই উচ্চতায় HEVC থাকলে সেটি আলাদা কার্ড (ছোট সাইজ) — সব রাখি, ইউজার বাছবে */
  return out;
}

/* ── মূল: স্ট্রিম তালিকা ──────────────────────────────────────────── */
async function resolve(o) {
  const imdb = await toImdb(o.id, o.type);
  if (!imdb) return { streams: [], note: 'no-imdb' };
  let pageUrl;
  if (o.type === 'tv' || o.type === 'series') pageUrl = `${HOST}/series/${imdb}/s-${pad(o.season)}/ep-${pad(o.episode)}`;
  else pageUrl = `${HOST}/watch/${imdb}`;
  const pg = await get(pageUrl, { proxyFirst: false }); /* পেজ = ডাইরেক্ট (দ্রুত) */
  if (pg.code !== 200) return { streams: [], note: 'page-' + pg.code, url: pageUrl };
  const play = grabPlay(pg.txt);
  if (!play || !Array.isArray(play.streams) || !play.streams.length) return { streams: [], note: 'no-streams', url: pageUrl };

  const item = play.item || play.movie || {};
  /* সিরিজে card-এ দেখানো হবে: show_title + (movie হলে movie title) */
  const showTitle = item.show_title || '';
  const title = (o.type === 'tv' || o.type === 'series') ? (showTitle || item.title || '') : (item.title || '');
  const epTitle = item.episode_title || '';
  const year = String(item.release_date || item.air_date || '').slice(0, 4);
  const out = [];
  const seen = new Set();
  const verN = (POOL && POOL.okNodes) ? POOL.okNodes().filter(n => n.verified).length : 0;

  for (const st of play.streams) {
    const master = unseal(st.m3u8_url);
    if (!/^https?:/i.test(master)) continue;
    if (seen.has(master)) continue;
    seen.add(master);
    const langs = (st.languages || []).map(x => x.name || x.code).filter(Boolean);
    const quals = (st.qualities || []).map(x => x.label).filter(Boolean);
    /* স্ট্রিম-প্লেলিস্ট = **পুল দিয়ে** (প্রক্সি-ফার্স্ট); verified নোড না থাকলে ডাইরেক্ট */
    /* ★ কঠোর সময়-সীমা: ২.৮সে-তে প্লেলিস্ট না এলে ডাইরেক্টে (কার্ড দ্রুত দেখানোই মুখ্য) */
    const mp = await Promise.race([
      get(master, { ms: verN > 0 ? 6000 : 5000, proxyFirst: verN > 0 }),
      new Promise(r => setTimeout(() => r(null), 2800)),
    ]);
    const mpRes = mp || await get(master, { ms: 4000, proxyFirst: false });
    const vars = mpRes && mpRes.code === 200 ? parseVariants(mpRes.txt) : [];
    /* ★ v3.3: অডিও-ট্র্যাকের ঘোষণা (কার্ডে Vidy-র মতো `⊞ Play4u ⌗ Audio` দেখানোর জন্য) */
    const auds = [];
    if (mpRes && mpRes.code === 200) {
      const are = /#EXT-X-MEDIA:TYPE=AUDIO[^\n]*?NAME="([^"]+)"[^\n]*?LANGUAGE="([^"]+)"[^\n]*?(?:DEFAULT=(YES|NO))/gi;
      let am;
      while ((am = are.exec(mpRes.txt))) auds.push({ name: am[1], lang: am[2], def: am[3] === 'YES' });
    }
    const audDef = (auds.find(a => a.def) || auds[0] || {}).name || '';
    /* ★ v3.5: **সব অডিও-ট্র্যাক declare** — কার্ডে "Hindi" দেখাচ্ছিল অথচ ৮টি ট্র্যাক আছে।
       ভাষারূপে ট্র্যাক-নামগুলোর সংক্ষিপ্ত-তালিকা (৫.১ বাদ), ৩+ হলে `Multi`। */
    const names = auds.map(a => String(a.name || '').replace(/\s*\(.*\)$/, '').trim()).filter(Boolean);
    const uniq = names.filter((x, i, a) => a.indexOf(x) === i);
    const audN = uniq.length > 2 ? 'Multi' : (uniq.length ? uniq.join('/') : (audDef || 'Original Audio'));
    const subs = [];
    if (mpRes && mpRes.code === 200) {
      const re = /#EXT-X-MEDIA:TYPE=SUBTITLES[^\n]*?NAME="([^"]+)"[^\n]*?LANGUAGE="([^"]+)"[^\n]*?URI="([^"]+)"/gi;
      let mm;
      while ((mm = re.exec(mpRes.txt))) subs.push({ lang: mm[2], name: mm[1], uri: new URL(mm[3], master).toString() });
    }
    const LANG = langs.length > 1 ? 'Multi' : (langs[0] || 'Original');
    if (!vars.length) {
      out.push({ server: 'Play4u', label: LANG, lang: LANG, url: master, kind: 'hls', quality: quals.slice(-1)[0] || '', subs, variants: [] });
      continue;
    }
    /* ★★ v3.3: **প্রতি ভ্যারিয়েন্ট = একটি কার্ড** (Vidy-র মতো — প্লেয়ারে কোয়ালিটি-মেনু আসে না,
       তাই কার্ডেই কোয়ালিটি declare করা হয়)। কিন্তু url = **মাস্টার**, আর রিলে মাস্টার থেকে
       শুধু ওই একটি ভ্যারিয়েন্ট রাখে (#EXT-X-MEDIA/AUDIO/SUBTITLES অটুট) ⇒ অডিও কখনো ভাঙে না,
       অটো-কোয়ালিটি-স্যুইচও হয় না। টোকেনে `p` = ভ্যারিয়েন্ট-আইডি; `q` = লেবেল। */
    for (const v of vars) {
      const q = qLabel(v.height, v.width) || (quals.slice(-1)[0] || 'Auto');
      out.push({
        server: 'Play4u',
        label: audN, lang: audN, audio: audN,
        audioList: uniq,
        url: master,
        pick: v.label || q + 'p',
        ql: q,
        kind: 'hls',
        quality: q,
        codec: vLabel(v) || 'H.264',
        tag: vLabel(v) || '',
        subs,
        audioTracks: auds.map(a => a.name),
        variants: vars.map(x => ({ q: qLabel(x.height, x.width), codec: vLabel(x), uri: x.uri })),
      });
    }
  }
  const yr = await yearOf(imdb, o.type, year);
  return { streams: out, title, year: yr || year, epTitle, url: pageUrl, via: pg.via };
}

module.exports = { resolve, unseal, seal, parseVariants, grabPlay, get, fetchText, variantOf, qLabel, vLabel, HOST, REF, UA, SEAL };
