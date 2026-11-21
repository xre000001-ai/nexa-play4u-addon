#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════
 * p4u-addon.js — **v3.0.0 · Play4u Only**
 *
 * ★ ইউজারের নির্দেশ: "Play4u
 *   দিয়ে দাও, টার্গেট আলাদা" ⇒ এখানে Play4u
 *
 * আর্কিটেকচার (৩টি ফাইল):
 *   p4u-source.js   → play4u.org স্ক্র্যাপ + সিল-আনসিল + ভ্যারিয়েন্ট তালিকা
 *   p4u-pool.js  → নিজস্ব ফ্রি-প্রক্সি পুল, **প্রোব-টার্গেট = furiosamedia.vip** (Play4u CDN)
 *   এই ফাইল     → Stremio অ্যাডন: Vidy-স্টাইল কার্ড + /t/ রিলে (রিলে সবসময় পুল দিয়ে)
 *
 * কেন রিলে দরকার (প্রমাণ, curl):
 *   furiosamedia.vip/range/… referer=https://play4u.org/ **ছাড়া 302** করে ⇒ প্লেয়ার
 *   সরাসরি টানলে source error। তাই কার্ডের url = আমাদের /t/<token>; রিলে **প্রথমে
 *   প্রক্সি-পুল** দিয়ে টানে (ডেটাসেন্টার IP ব্লক এড়াতে), পুল একেবারে না থাকলে ডাইরেক্ট।
 *   মাস্টার-প্লেলিস্টের প্রতিটি URI-ও /t/ দিয়ে রিরাইট হয় ⇒ ৪টি হপেই referer + IP ঘোরে।
 *
 * কোয়ালিটি: প্লেয়ারের অটো-কোয়ালিটি বন্ধ — মাস্টারের প্রতিটি ভ্যারিয়েন্ট (1080p /
 *   1080p_hevc / 720p / 360p) আলাদা কার্ড, আর রিলে ঠিক ওই ভ্যারিয়েন্টে লক থাকে।
 * ══════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const ATL = require('./p4u-source');                     /* ★ একমাত্র সোর্স */
const POOL = (() => { try { return require('./p4u-pool'); } catch (e) { console.error('[pool] ' + e.message); return null; } })();
const VERSION = (() => { try { return require('./package.json').version || '3.0.0'; } catch (e) { return '3.0.0'; } })();
const PORT = Number(process.env.PORT || 7000);
const DEFAULT_PUBLIC = process.env.PUBLIC_URL || 'https://3404d3c5dc63-nexa.baby-beamup.club';

const SRV_NAME = 'Play4u';
const ADDON_NAME = 'Play4u';

/* ── ডায়াগনস্টিক ───────────────────────────────────────────────────── */
const DIAG = { req: 0, ok: 0, zero: 0, cards: 0, relay: 0, relayFail: 0, viaProxy: 0, viaDirect: 0, junk: 0, locked: 0 };
const BLACK = Object.create(null);   /* host → Set(dead proxy) */

/* ── রিলে টোকেন ─────────────────────────────────────────────────────── */
function encTok(o) { return Buffer.from(JSON.stringify(o)).toString('base64url'); }
function decTok(t) { try { const j = JSON.parse(Buffer.from(t, 'base64url').toString('utf8')); return (j && j.u) ? j : null; } catch (e) { return null; } }

function originOf(req) {
  const pick = v => String(v || '').split(',')[0].trim();
  /* ★ v3.0.1: **মাপা বাস্তবতা** — dokku/ingress হেডার বদলে দেয়:
       local:  host='127.0.0.1:7750'                     ⇒ সোজা ব্যবহার
       prod :  host='localhost:6195', x-forwarded-host='3404d3c5dc63-nexa'
               (ডোমেইন নেই!) ⇒ আগে কার্ডে https://localhost:6195/… তৈরি হচ্ছিল = প্লেয়ারে মৃত।
     সমাধান: PUBLIC_URL থাকলে সেটাই; নইলে ডোমেইন-যুক্ত হেডার; নইলে
     `<x-forwarded-host>.baby-beamup.club` (beamup-এর প্রকৃত পাবলিক ডোমেইন)। */
  if (process.env.PUBLIC_URL) return String(process.env.PUBLIC_URL).replace(/\/+$/, '');
  const xf = pick(req.headers['x-forwarded-host']);
  const host = pick(req.headers['host']);
  const proto = pick(req.headers['x-forwarded-proto']) || ((req.socket && req.socket.encrypted) ? 'https' : 'http');
  const hasDot = v => !!v && v.indexOf('.') > 0;
  const isBare = v => /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(v || '');
  let h;
  if (hasDot(xf)) h = xf;
  else if (hasDot(host) && !isBare(host)) h = host;
  else if (xf) h = xf + '.baby-beamup.club';
  /* ★ v3.0.4: dokku এই অ্যাপে কোনো পাবলিক হোস্টই পাঠায় না (মাপা: host='localhost:6195',
     x-forwarded-host খালি) ⇒ ডিফল্ট পাবলিক-ডোমেইন বেঁধে দিলাম; PUBLIC_URL দিয়ে বদলানো যাবে। */
  else if (DEFAULT_PUBLIC) return DEFAULT_PUBLIC.replace(/\/+$/, '');
  else if (hasDot(host)) h = host;
  else h = 'localhost:' + PORT;
  return proto + '://' + h;
}

function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length, 'access-control-allow-origin': '*', 'cache-control': 'no-store, max-age=0' });
  res.end(b);
}

/* ── কার্ড: **ভিডি-র হুবহু ফরম্যাট** (লাইভ vidy-addon আউটপুট থেকে যাচাই করা) ─────
   ▥ 1080 ▥
   ⧉ Man of Steel | 2013 |
    ⌘ Vidy ⌗ English • Miami
   ⇒ আমাদের:  ⌘ Play4u ⌗ <Language> • <CDN-নাম>
   server-নামটা CDN হোস্ট থেকেই আসে (ফুরিওসা/আপরাইজিং/নিওপালস/গোথাম) — ভিডির
   শহর-নামের মতোই, আর সত্যি (আসলেই ওই এজ থেকে স্ট্রিম আসে)। */
const CDN_NAME = { 'furiosamedia.vip': 'Furiosa', 'uprising.best': 'Uprising', 'neopulse.vip': 'Neopulse', 'gothamnet.vip': 'Gotham' };
function cdnLabel(u) {
  try { const h = new URL(u).host.replace(/^www\./, ''); return CDN_NAME[h] || h.split('.')[0].replace(/^./, c => c.toUpperCase()); } catch (e) { return 'Play4u'; }
}
function card(s, meta, origin, epLabel, epTitle) {
  const q = String(s.quality || '').replace(/[^0-9]/g, '') || 'Auto';
  /* ★★ v3.4 — ভিডির **লাইভ আউটপুট** হুবহু (codepoint ধরে যাচাই করা):
       ▥ 1080 ▥
       ⧉ Game of Thrones | 2011 |
        ⏣ S5E10 • Mother's Mercy      ← U+23E3, লাইনের আগে একটি স্পেস
        ⌘ Play4u ⌗ English • Furiosa  ← U+2318, লাইনের আগে একটি স্পেস
     মুভিতে এপিসোড-লাইন থাকে না। বছর থাকলে `| Year |`, না থাকলে কিছুই না।
     ভাষা = অডিও-ট্র্যাকের নাম (ভিডি যেমন `English` লিখে)। */
  const yTx = meta.year ? ' | ' + meta.year + ' |' : '';
  const lang = String(s.audio || s.lang || 'English').replace(/\s*\(.*\)$/, '').trim() || 'English';
  const epLine = epLabel ? ('\n \u23e3 ' + epLabel + (epTitle ? ' \u2022 ' + epTitle : '')) : '';
  const txt = '\u29c9 ' + (meta.title || 'Play4u') + yTx + epLine + '\n \u2318 ' + ADDON_NAME + ' \u2317 ' + lang + ' \u2022 ' + cdnLabel(s.url);
  const tok = encTok({ u: s.url, r: ATL.REF, a: ATL.UA, p: s.pick || '', x: 1 });
  const H = { 'User-Agent': ATL.UA, Referer: ATL.REF };
  return {
    name: '\u25a5 ' + q + ' \u25a5',
    title: txt,
    description: txt,
    /* ★ v3.5: প্যারেন্ট-অ্যাডন (Vidy) এগুলো পড়ে **নিজের** কার্ড-ফরম্যাট বানায় —
       `_addon`/`_srv`/`_alist` ছাড়া প্যারেন্ট জানতেই পারে না সোর্স Play4u বা অডিও কতগুলো। */
    _addon: ADDON_NAME,
    _srv: cdnLabel(s.url),
    _lang: String(s.audio || 'English'),
    _alist: Array.isArray(s.audioList) ? s.audioList : [],
    _q: q,
    url: origin + '/t/' + tok + '?cb=' + Date.now().toString(36),
    behaviorHints: {
      notWebReady: true,
      proxyHeaders: { request: Object.assign({}, H, { Origin: 'https://play4u.org' }) },
    },
  };
}

/* ── প্লেলিস্ট-রিরাইট: প্রতিটি URI → /t/ (referer+প্রক্সি সব হপে) ──────── */
function rewritePlaylist(txt, base, origin, ref, ua) {
  const toRelay = (u) => {
    let abs;
    try { abs = new URL(u, base).toString(); } catch (e) { return u; }
    if (!/^https?:/i.test(abs)) return u;
    return origin + '/t/' + encTok({ u: abs, r: ref, a: ua });
  };
  if (/^\s*#EXTM3U/i.test(txt)) {
    return txt.split('\n').map(line => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/gi, (m, p1) => 'URI="' + toRelay(p1) + '"');
      return toRelay(t);
    }).join('\n');
  }
  if (/<MPD|<\?xml/i.test(txt)) {
    let out = txt.replace(/<BaseURL>([^<]+)<\/BaseURL>/gi, (m, p1) => '<BaseURL>' + toRelay(p1.trim()) + '</BaseURL>');
    out = out.replace(/(media|initialization)="([^"]+)"/gi, (m, k, p1) => k + '="' + toRelay(p1) + '"');
    return out.replace(/(xlink:href)="([^"]+)"/gi, (m, k, p1) => k + '="' + toRelay(p1) + '"');
  }
  return txt;
}

/* ★★ v3.3: মাস্টার-প্লেলিস্ট থেকে **শুধু বাছা ভ্যারিয়েন্ট** রাখি, কিন্তু #EXT-X-MEDIA
   (AUDIO/SUBTITLES) লাইনগুলো **অটুট** রাখি ⇒ প্লেয়ার ঠিক ওই কোয়ালিটি চালাবে,
   অডিও-ট্র্যাকের রেফারেন্স ভাঙবে না, আর অটো-কোয়ালিটি-স্যুইচও হবে না।
   (আগে পুরো মাস্টার দিলে প্লেয়ারে কোয়ালিটি-মেনুই আসত না — ইউজারের রিপোর্ট।) */
const LOCKC = new Map();      /* key: target|pick → {at, txt} */
function lockVariant(txt, pick) {
  const lines = String(txt).split('\n');
  const blocks = [];
  /* প্রতি STREAM-INF + তার পরের URI-লাইন একসাথে ধরি */
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (!/^#EXT-X-STREAM-INF/i.test(L.trim())) continue;
    let j = i + 1, uri = '', uriIdx = -1;
    while (j < lines.length) {
      const t2 = lines[j].trim();
      if (!t2) { j++; continue; }
      if (t2[0] === '#') { j++; continue; }
      uri = t2; uriIdx = j; break;
    }
    blocks.push({ inf: L, uri, uriIdx });
  }
  if (!blocks.length) return txt;
  const norm = v => String(v || '').toLowerCase();
  let pickB = blocks.find(b => norm((b.inf.match(/STABLE-VARIANT-ID="([^"]+)"/i) || [])[1]) === norm(pick));
  if (!pickB) {
    const want = Number(String(pick).replace(/[^0-9]/g, '')) || 0;
    let best = null;
    for (const b of blocks) {
      const w = Number((b.inf.match(/RESOLUTION=(\d+)x/i) || [])[1] || 0);
      const d = Math.abs((w || 0) - (want >= 1000 ? want : Math.round(want * 16 / 9)));
      if (!best || d < best.d) best = { b, d };
    }
    pickB = best ? best.b : blocks[0];
  }
  /* ★ v3.4 বাগ-ফিক্স: STREAM-INF বাদ দেওয়ার সময় তার **URI লাইনটাও** বাদ দিতে হবে,
     নাহলে ওই এগিয়ে-থাকা URI-গুলোই প্লেয়ার আগে পড়ে (সব কার্ড ১০৮০p হয়ে যেত)। */
  const drop = new Set();
  for (const b of blocks) { drop.add(lines.indexOf(b.inf)); if (b.uriIdx >= 0) drop.add(b.uriIdx); }
  const out = [];
  lines.forEach((L, i) => { if (!drop.has(i)) out.push(L); });
  return out.join('\n').trimEnd() + '\n' + pickB.inf + '\n' + pickB.uri + '\n';
}

/* ── রিলে: **প্রথমে পুল**, তারপর ডাইরেক্ট ───────────────────────────── */
/* v3.5.1: Play4u-র `/range/….html` আসলে মাস্টার-প্লেলিস্ট (কিছু নোডে html/gzip মোড়কে) */
function plInsideHtml(txt) {
  const t0 = String(txt || '');
  if (t0.indexOf('#EXTM3U') >= 0) return t0.slice(t0.indexOf('#EXTM3U'));
  try { const d = Buffer.from(t0, 'base64').toString('utf8'); if (d.indexOf('#EXTM3U') >= 0) return d.slice(d.indexOf('#EXTM3U')); } catch (e) { }
  try { const d2 = decodeURIComponent(t0); if (d2.indexOf('#EXTM3U') >= 0) return d2.slice(d2.indexOf('#EXTM3U')); } catch (e) { }
  return '';
}
async function relay(req, res, tok, sub) {
  const t = decTok(tok);
  if (!t) { res.writeHead(400); return res.end('bad-token'); }
  let target = String(t.u || '');

  /* চেইনড-টোকেন হলে ভেতরের আসল url-এ নামি */
  try {
    for (let g = 0; g < 4; g++) {
      const m = target.match(/^https?:\/\/[^/]+\/t\/([A-Za-z0-9_\-.]+)/);
      if (!m) break;
      const inner = decTok(m[1]);
      if (!inner || !inner.u) break;
      target = inner.u;
      if (!t.r && inner.r) t.r = inner.r;
    }
  } catch (e) { }

  const qs = (req.url || '').includes('?') ? '?' + req.url.split('?').slice(1).join('?') : '';
  if (sub && !/^x\.m3u8$/i.test(sub)) { try { target = new URL(sub, t.u).toString(); } catch (e) { } }
  else if (qs) { try { const u2 = new URL(t.u); u2.search = qs; target = u2.toString(); } catch (e) { } }

  /* ★ v3.3: মাস্টার + pick থাকলে ⇒ মাস্টারই টানি, পরে lockVariant() দিয়ে ছাঁটি (অডিও অটুট) */
  const HD = {
    'user-agent': t.a || ATL.UA,
    referer: t.r || ATL.REF,
    origin: 'https://play4u.org',
    accept: '*/*',
    ...(req.headers.range ? { range: req.headers.range } : {}),
  };
  let st = 0, ct = 'application/octet-stream', body = Buffer.alloc(0);
  const host = (() => { try { return new URL(target).host; } catch (e) { return ''; } })();
  const avoid = BLACK[host] || (BLACK[host] = new Set());

  /* ★ v3.0: **প্লেলিস্ট** হলে ছোট ⇒ পুল রেস (৩ নোড প্যারালাল, প্রথম বৈধ) ❘
     **সেগমেন্ট** হলে স্ট্রিমিং পাস-থ্রু (মেমরিতে জমা নয় ⇒ বাফারিং দেরি নেই)। */
  const isSeg = !/\/range\/[^/]+\.(html?|js|css|json|png|jpg)$/i.test(new URL(target).pathname)
    && !/m3u8|playlist|\.m3u\b/i.test(target);
  const poolReady = !!(POOL && POOL.stats().ok > 0);

  if (!poolReady) {          /* প্রক্সি নেই ⇒ ডাইরেক্ট (ইউজারের অনুমোদিত ব্যতিক্রম) */
    return passthruDirect(req, res, target, HD, t);
  }

  if (!isSeg) {
    /* ★★ v3.2: প্লেলিস্ট **একবারে সম্পূর্ণ** নামাই (২ চেষ্টা, verified নোড, ৬সে সীমা)।
       আগে স্ট্রিমিং-rewrite-এ প্রক্সি মাঝপথে মরে গেলে প্লেলিস্ট **কাটা** যেত
       ⇒ প্লেয়ার "মাঝখানে source error" দিত। কাটা প্লেলিস্টের চেয়ে একবারে লেখা নিরাপদ। */
    const tried = new Set();
    let gotPl = null;
    for (let a = 0; a < 2 && !gotPl; a++) {
      try {
        /* ★ দ্রুত: প্রক্সি ৮০০ms-এ না এলে ডাইরেক্টও দৌড়ে; মোট সীমা ৩.৫সে */
        const pr = await Promise.race([
          POOL.praise(target, { ms: 4000, ua: HD['user-agent'], headers: HD, avoid, hedge: 800, verifiedOnly: true }),
          new Promise(r => setTimeout(() => r(null), 3500)),
        ]);
        if (pr && pr.status === 200 && pr.body && pr.body.length) gotPl = pr;
        else if (pr && pr.via && pr.via !== 'direct') avoid.add(pr.via);
      } catch (e) { }
    }
    if (gotPl) {
      /* v3.5.1: HTML-মোড়কে আসা মাস্টার-প্লেলিস্ট খুলে নিই, নাহলে লকও হয় না */
      const txt = plInsideHtml(gotPl.body.toString('utf8')) || gotPl.body.toString('utf8');
      if (/^\s*(#EXTM3U|<\?xml|<MPD)/i.test(txt)) {
        let t2 = txt;
        if (t.p) { t2 = lockVariant(t2, t.p); DIAG.locked = (DIAG.locked || 0) + 1; }
        const rw = rewritePlaylist(t2, target, originOf(req), t.r || ATL.REF, t.a || ATL.UA);
        const b2 = Buffer.from(rw, 'utf8');
        const dash = /<MPD|<\?xml/i.test(txt);
        DIAG.viaProxy++; DIAG.relay++;
        res.writeHead(200, {
          'content-type': dash ? 'application/dash+xml' : 'application/vnd.apple.mpegurl',
          'content-length': b2.length, 'access-control-allow-origin': '*', 'cache-control': 'no-store',
        });
        return res.end(b2);
      }
    }
    let got = null;
    /* ★ মোট সীমা ৫সে — তারপর সোজা ডাইরেক্ট (ধীর নোডে ২৯সে আটকে থাকা মাপা হয়েছে) */
    const cap = new Promise(r => setTimeout(() => r(null), 5000));
    for (let a = 0; a < 2 && !got; a++) {
      try {
        /* ★ প্রতিটির জন্য ৫সে সীমা — ধীর নোডে আটকে ২৭সে হওয়া বন্ধ */
        const pr = await Promise.race([
          POOL.praise(target, { ms: 4000, ua: HD['user-agent'], headers: HD, avoid, hedge: 3500 }),
          cap,
        ]);
        if (pr === null) break;
        if (pr.status === 200 && pr.body && pr.body.length) got = pr;
        else if (pr.via && pr.via !== 'direct') avoid.add(pr.via);
      } catch (e) { }
    }
    if (!got) {
      try {
        const r = await fetch(target, { headers: HD, redirect: 'follow', signal: AbortSignal.timeout(20000) });
        got = { status: r.status, body: Buffer.from(await r.arrayBuffer()), via: 'direct' };
        ct = r.headers.get('content-type') || ct; DIAG.viaDirect++;
      } catch (e) { DIAG.relayFail++; res.writeHead(502, { 'access-control-allow-origin': '*' }); return res.end('relay-fail'); }
    } else DIAG.viaProxy++;
    body = got.body; st = got.status;
    const sniff0 = body.slice(0, 300).toString('utf8');
    if (/^\s*[A-Z_]{4,}\s*=/m.test(sniff0) && !/^\s*(#EXTM3U|<\?xml|<MPD)/i.test(sniff0)) { DIAG.junk++; res.writeHead(502, { 'access-control-allow-origin': '*' }); return res.end('junk'); }
  } else {
    const tried = new Set();
    /* ১) ডাইরেক্ট (দ্রুততম) — মাপা: ০.৩-০.৫সে বনাম প্রক্সি ৭-১২সে */
    try { if (await tryDirectSegment(req, res, target, HD, 6000)) { DIAG.viaDirect++; return; } } catch (e) { }
    /* ২) না হলে প্রক্সি (প্রতিটি ২সে-সীমা) */
    for (let a = 0; a < 2; a++) {
      const ok = await tryStreamSegment(req, res, target, HD, avoid, tried);
      if (ok) { DIAG.viaProxy++; return; }
    }
    DIAG.viaDirect++;
    return passthruDirect(req, res, target, HD, t);
  }

  /* প্লেলিস্ট হলে ভেতরের URI-ও রিলে-পথে */
  const sniff = body.slice(0, 300).toString('utf8');
  const looksPl = /^(\s*#EXTM3U|\s*<\?xml|\s*<MPD)/i.test(sniff);
  if (looksPl && body.length < 4 * 1024 * 1024) {
    body = Buffer.from(rewritePlaylist(body.toString('utf8'), target, originOf(req), t.r || ATL.REF, t.a || ATL.UA), 'utf8');
    ct = /<MPD|<\?xml/i.test(sniff) ? 'application/dash+xml' : 'application/vnd.apple.mpegurl';
  }
  DIAG.relay++;
  res.writeHead(st || 200, {
    'content-type': ct,
    'content-length': body.length,
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  });
  res.end(body);
}

/* ── সরাসরি পাস-থ্রু (শেষ উপায়) ───────────────────────────────────── */
async function passthruDirect(req, res, target, HD, t) {
  try {
    const r = await fetch(target, { headers: HD, redirect: 'follow', signal: AbortSignal.timeout(30000) });
    const ct = r.headers.get('content-type') || 'application/octet-stream';
    /* ★★ v3.5.2: **সেগমেন্ট আর মেমরিতে জমা নয়** — আগে `arrayBuffer()` পুরো ফাইল (১৫MB)
       নামানো পর্যন্ত অপেক্ষা করত ⇒ প্লে-স্টার্ট ৭-১৩সে, আর BeamUp গেটওয়ে ১৫সে-তে **504**।
       এখন: প্লেলিস্ট হলে বাফার (লক/রিরাইট দরকার), নাহলে সরাসরি স্ট্রিম — Range/২০৬ অক্ষত। */
    const _looksPl = /mpegurl|dash\+xml/i.test(ct)
      || /m3u8|playlist|\.m3u\b|\.html?($|\?)/i.test(String(target));
    if (!_looksPl && r.body) {
      const H = { 'content-type': ct, 'access-control-allow-origin': '*', 'cache-control': 'no-store', 'accept-ranges': 'bytes' };
      for (const k of ['content-length', 'content-range', 'last-modified', 'etag']) {
        const v = r.headers.get(k); if (v) H[k] = v;
      }
      res.writeHead(r.status, H);
      const { Readable } = require('stream');
      const src = Readable.fromWeb(r.body);
      src.on('error', () => { try { res.end(); } catch (e) { } });
      req.on('close', () => { try { src.destroy(); } catch (e) { } });
      DIAG.streamed = (DIAG.streamed || 0) + 1;
      return src.pipe(res);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    /* v3.5.1: মাস্টার-প্লেলিস্ট `.html` ফাইলেও আসে — খুলে lockdown+rewrite করি */
    const rawTxt = (/^\s*(#EXTM3U|<\?xml|<MPD)/i.test(buf.slice(0, 200).toString('utf8')))
      ? buf.toString('utf8') : (t.p ? plInsideHtml(buf.toString('utf8')) : '');
    if (rawTxt) {
      let lk = rawTxt;
      if (t.p) { lk = lockVariant(rawTxt, t.p); DIAG.locked = (DIAG.locked || 0) + 1; }
      const rw = rewritePlaylist(lk, target, originOf(req), t.r || ATL.REF, t.a || ATL.UA);
      const b2 = Buffer.from(rw, 'utf8');
      res.writeHead(200, { 'content-type': /<MPD|<\?xml/i.test(rw) ? 'application/dash+xml' : 'application/vnd.apple.mpegurl', 'content-length': b2.length, 'access-control-allow-origin': '*' });
      return res.end(b2);
    }
    res.writeHead(r.status, { 'content-type': ct, 'content-length': buf.length, 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    return res.end(buf);
  } catch (e) { DIAG.relayFail++; res.writeHead(502, { 'access-control-allow-origin': '*' }); return res.end('relay-fail'); }
}


/* v3.5.6: **সেগমেন্টে আগে ডাইরেক্ট** — মাপা: প্রক্সি-নোড ~৯৭KB/s ও হেডার দিয়ে ঝুলে থাকে
   (৩×২সে + ফলব্যাক = ১২সে ⇒ BeamUp গেটওয়ে **504**), অথচ সીધা CDN ০.৩-০.৫সে/৫০০KB/s।
   Range/২০৬ অক্ষত পাস করি; ৪সে-এ হেডার না এলে false ফিরিয়ে প্রক্সি-পথে যেতে দিই। */
function tryDirectSegment(req, res, target, HD, ms) {
  return fetch(target, { headers: HD, redirect: 'follow', signal: AbortSignal.timeout(ms || 8000) })
    .then(r => {
      if (!r.body) return false;
      const H = { 'content-type': r.headers.get('content-type') || 'video/mp4',
        'access-control-allow-origin': '*', 'cache-control': 'no-store', 'accept-ranges': 'bytes' };
      for (const k of ['content-length', 'content-range']) { const v = r.headers.get(k); if (v) H[k] = v; }
      res.writeHead(r.status, H);
      const { Readable } = require('stream');
      const src = Readable.fromWeb(r.body);
      src.on('error', () => { try { res.end(); } catch (e) { } });
      req.on('close', () => { try { src.destroy(); } catch (e) { } });
      src.pipe(res);
      return true;
    })
    .catch(() => false);
}

/* ── সেগমেন্ট স্ট্রিমিং (প্রক্সি নোড → ব্যবহারকারী, হেডার আসার সাথে সাথে) ── */
function tryStreamSegment(req, res, target, HD, avoid, tried) {
  const nodes = POOL.okNodes().filter(n => !avoid.has(n.px) && !tried.has(n.px)).slice(0, 3);
  if (!nodes.length) return Promise.resolve(false);
  const n = nodes[0]; tried.add(n.px);
  return new Promise(resolve => {
    let started = false, bytes = 0, hd = '', hst = 200;
    /* ★★ v3.5.3: **প্রথম-বাইট ডেডলাইন** — নোড হেডার না দিলে ২সে-এ হাল ছেড়ে দিই।
       আগে ৩০সে × ৩ নোড = ৯০সে ধরে ঝুলত ⇒ BeamUp গেটওয়ে ~১৩সে-এ 504 (মাপা)। */
    const fb = setTimeout(() => { if (!started) { try { avoid.add(n.px); } catch (e) { } resolve(false); } }, 2000);
    POOL.pstream(n.px, target, { ms: 30000, ua: HD['user-agent'], headers: HD },
      (status, headTxt) => {
        /* ★★ v3.5.5: হেডার এলেই যেন ২০০/২০৬ না পাঠাই — প্রথম **ডেটা-চাঙ্ক** এলে তবেই
           হেডার লিখি। নোড হেডার দিয়ে চুপ করে বসে থাকলে (প্রোডে মাপা: ১২.৭সে ⇒ গেটওয়ে 504)
           আমরা সেটা ধরতে পারি এবং পরের নোড/ডাইরেক্টে যেতে পারি। */
        hd = headTxt || ''; hst = status || 200;
        /* v3.5.1: নোডের ২০৬ + content-range/length অক্ষত পাস (নাহলে প্লেয়ার পুরো ফাইল চায়) */
        const H = { 'content-type': (/content-type:\s*([^\r\n]+)/i.exec(headTxt || '') || [])[1] || 'video/mp4',
          'access-control-allow-origin': '*', 'cache-control': 'no-store', 'accept-ranges': 'bytes' };
        const cl = /content-length:\s*([^\r\n]+)/i.exec(headTxt || '');
        const cr = /content-range:\s*([^\r\n]+)/i.exec(headTxt || '');
        if (cl) H['content-length'] = String(cl[1]).trim();
        if (cr) H['content-range'] = String(cr[1]).trim();
        res.writeHead(status || 200, H);
      },
      d => {
        if (!started) {
          started = true; clearTimeout(fb);
          const H = { 'content-type': (/content-type:\s*([^\r\n]+)/i.exec(hd) || [])[1] || 'video/mp4',
            'access-control-allow-origin': '*', 'cache-control': 'no-store', 'accept-ranges': 'bytes' };
          const cl = /content-length:\s*([^\r\n]+)/i.exec(hd), cr = /content-range:\s*([^\r\n]+)/i.exec(hd);
          if (cl) H['content-length'] = String(cl[1]).trim();
          if (cr) H['content-range'] = String(cr[1]).trim();
          res.writeHead(hst, H);
        }
        bytes += d.length; try { res.write(d); } catch (e) { }
      },
      () => { clearTimeout(fb); if (!started) { n.fails = (n.fails || 0) + 1; avoid.add(n.px); return resolve(false); } try { res.end(); } catch (e) { } resolve(true); },
      e => {
        clearTimeout(fb);
        if (!started) { n.fails = (n.fails || 0) + 1; if (n.fails >= 2) n.cool = Date.now() + 60000; avoid.add(n.px); return resolve(false); }
        try { res.end(); } catch (e2) { } resolve(true);
      });
  });
}

/* ★ v3.0.4: **স্ট্রিমিং প্লেলিস্ট রিলে** — ৭৯০KB/হাজারো-সেগমেন্টের প্লেলিস্ট পুরো নামিয়ে
   rewrite করতে ১০–৩০সে লাগছিল (মাপা) ⇒ এখন লাইন-ধরে-ধরে rewrite করে সাথে সাথে পাঠাই। */
function tryStreamPlaylist(req, res, target, HD, avoid, tried) {
  const nodes = POOL.okNodes().filter(n => !avoid.has(n.px) && !tried.has(n.px)).slice(0, 3);
  if (!nodes.length) return Promise.resolve(false);
  const n = nodes[0]; tried.add(n.px);
  const origin = originOf(req);
  return new Promise(resolve => {
    let started = false, rest = '';
    const rew = line => rewritePlaylist(line, target, origin, HD.referer, HD['user-agent']);
    POOL.pstream(n.px, target, { ms: 30000, ua: HD['user-agent'], headers: HD },
      (status, headTxt) => {
        const ct = (/content-type:\s*([^\r\n]+)/i.exec(headTxt || '') || [])[1] || '';
        DIAG.ctSample = String(ct).trim().slice(0, 40);
        started = true;
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
      },
      d => {
        rest += d.toString('utf8');
        const parts = rest.split('\n');
        rest = parts.pop() || '';
        if (parts.length) { try { res.write(rew(parts.join('\n') + '\n')); } catch (e) { } }
      },
      () => {
        if (!started) { n.fails = (n.fails || 0) + 1; avoid.add(n.px); return resolve(false); }
        try { if (rest) res.write(rew(rest)); res.end(); } catch (e) { }
        resolve(true);
      },
      e => {
        if (!started) { n.fails = (n.fails || 0) + 1; if ((n.fails || 0) >= 2) n.cool = Date.now() + 60000; avoid.add(n.px); return resolve(false); }
        try { res.end(); } catch (e2) { }
        resolve(true);
      });
  });
}

/* ── স্ট্রিম-তালিকা (ক্যাশ ২০সে) ─────────────────────────────────────── */
const CACHE = new Map();
const TTL = 20000;
async function streamsFor(type, id, s, e) {
  const key = type + ':' + id + ':' + (s || 0) + ':' + (e || 0);
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.res;
  const t0 = Date.now();
  const r = await ATL.resolve({ id, type: type === 'series' ? 'tv' : 'movie', season: s, episode: e })
    .catch(er => ({ streams: [], note: 'err:' + ((er && er.message) || er) }));
  r.ms = Date.now() - t0;
  /* ★ পুলকে আসল CDN-প্লেলিস্টের ক্যানারি দিই ⇒ স্ক্যান এখন থেকে শুধু সত্যিকারের কাজ করা নোড রাখবে */
  try { if (POOL && POOL.setCanary && r.streams && r.streams[0]) POOL.setCanary(r.streams[0].url); } catch (e) { }
  if (CACHE.size > 200) CACHE.clear();
  CACHE.set(key, { at: Date.now(), res: r });
  return r;
}

/* ── সার্ভার ────────────────────────────────────────────────────────── */
const srv = http.createServer(async (req, res) => {
  let p = (req.url || '/').split('?')[0];
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  DIAG.req++;
  const origin = originOf(req);

  let m = p.match(/^\/t\/([A-Za-z0-9_\-.]+)(\/.*)?$/);
  if (m) return relay(req, res, m[1], (m[2] || '').replace(/^\//, ''));

  /* ★★ v3.5: প্যারেন্ট (Vidy) চাইল্ডের `/health`-এ **`pool` সংখ্যা** খোঁজে (NetHex-এর চুক্তি:
     `{pool:<বেঞ্চ-সংখ্যা>, waves, size}`). আমরা object পাঠাতাম ⇒ Vidy-র NXBENCH=-1 হয়ে
     নেক্সা-সোর্সই বাদ পড়ে যেত ("vidy তে Play4u কার্ড নেই")। এখন দুই ফরম্যাটই দেওয়া হয়:
       /health   → প্যারেন্ট-চুক্তি (pool = verified-নোড-সংখ্যা, waves, size)
       /_health  → আমাদের পূর্ণ ডায়াগনস্টিক (pool = বিস্তারিত object) */
  if (p === '/health' || p === '/healthz') {
    const st = POOL ? POOL.stats() : { ok: 0, nodes: 0 };
    return json(res, 200, {
      ok: 1, status: '200 OK', version: VERSION, source: 'play4u.org',
      pool: Math.max(1, Number(st.verified || st.ok || 1)),   /* ০ নয় — নইলে প্যারেন্ট থামিয়ে দেয় */
      waves: Number(DIAG.relay || 0), size: Number(st.nodes || 0),
      up: Math.round(process.uptime()),
    });
  }
  if (p === '/_probe') {   /* v3.5.3: প্রোড→CDN আউটবাউন্ড গতি মাপার ডায়াগনস্টিক */
    const u0 = (new URL(req.url, 'http://x')).searchParams.get('u') || '';
    if (!/^https:\/\//.test(u0)) return json(res, 200, { ok: 0, why: 'bad-url' });
    const t0 = Date.now();
    try {
      const r0 = await fetch(u0, { headers: { 'user-agent': ATL.UA, referer: ATL.REF, origin: 'https://play4u.org', accept: '*/*', range: 'bytes=0-200000' }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
      let got = 0, first = 0;
      const rd = r0.body.getReader();
      for (; ;) {
        const { done, value } = await rd.read();
        if (done) break;
        if (!first) first = Date.now() - t0;
        got += value.length;
        if (got > 400000) { try { await rd.cancel(); } catch (e) { } break; }
      }
      return json(res, 200, { ok: 1, status: r0.status, ct: r0.headers.get('content-type'), cr: r0.headers.get('content-range'), bytes: got, firstMs: first, totalMs: Date.now() - t0 });
    } catch (e) { return json(res, 200, { ok: 0, err: String((e && e.message) || e).slice(0, 120), ms: Date.now() - t0 }); }
  }
  if (p === '/_health') {
    return json(res, 200, {
      ok: 1, status: '200 OK', version: VERSION, source: 'play4u.org', up: Math.round(process.uptime()),
      diag: DIAG, pool: POOL ? POOL.stats() : null, probeHost: POOL ? POOL.PROBE_HOST : null,
    });
  }
  if (p === '/_pool' || p === '/_pool/scan') {
    try {
      if (p === '/_pool/scan' && POOL) await POOL.scan();
      return json(res, 200, { ok: 1, pool: POOL ? POOL.stats() : { enabled: false }, seen: Object.keys(BLACK).length });
    } catch (er) { return json(res, 200, { ok: 0, err: String((er && er.message) || er) }); }
  }
  if (p === '/_whoami') return json(res, 200, { origin: originOf(req), headers: req.headers, publicDefault: DEFAULT_PUBLIC });
  if (p === '/manifest.json') return json(res, 200, {
    id: 'community.play4u.streams', version: VERSION, name: ADDON_NAME,
    description: 'play4u.org — সব কোয়ালিটি আলাদা কার্ড (1080p/HEVC/720p/360p), নিজস্ব প্রক্সি-পুল + রিলে',
    resources: ['stream'], types: ['movie', 'series'], idPrefixes: ['tt', 'tmdb'],
    catalogs: [], behaviorHints: { configurable: false },
  });
  if (p === '/logo.png') { res.writeHead(404); return res.end(''); }

  m = p.match(/^\/stream\/(movie|series)\/([^/]+)\.json$/);
  if (m) {
    const type = m[1];
    let id = decodeURIComponent(m[2]), s = 0, e = 0;
    const se = id.match(/^(tt\d+|tmdb\d+|\d+):(\d+):(\d+)$/i);
    if (se) { id = se[1]; s = Number(se[2]) || 1; e = Number(se[3]) || 1; }
    try {
      const r = await streamsFor(type, id, type === 'series' ? (s || 1) : 0, type === 'series' ? (e || 1) : 0);
      const epLabel = type === 'series' ? ('S' + (s || 1) + 'E' + (e || 1)) : '';
      const meta = { title: r.title || '', year: r.year || '' };
      const cards = (r.streams || []).map(x => card(x, meta, origin, epLabel, r.epTitle || ''));
      if (cards.length) { DIAG.ok++; DIAG.cards += cards.length; } else DIAG.zero++;
      console.log('[p4u] ' + type + ' ' + id + epLabel + ' → ' + cards.length + ' cards ' + (r.ms || 0) + 'ms via=' + (r.via || '-') + (r.note ? ' note=' + r.note : ''));
      return json(res, 200, { streams: cards });
    } catch (er) { return json(res, 200, { streams: [], err: String((er && er.message) || er).slice(0, 90) }); }
  }

  m = p.match(/^\/(movie|series)\/([^/]+)\/stream\/([^/]+)\.json$/);
  if (m) {
    const type = m[1], id = decodeURIComponent(m[3]);
    const r = await streamsFor(type, id, type === 'series' ? 1 : 0, type === 'series' ? 1 : 0).catch(() => ({ streams: [] }));
    const meta = { title: r.title || '', year: r.year || '' };
    return json(res, 200, { streams: (r.streams || []).map(x => card(x, meta, origin, '', '')) });
  }
  return json(res, 200, { ok: 1, status: '200 OK', source: 'play4u.org', version: VERSION, hint: '/manifest.json , /stream/movie/<imdb|tmdb>.json' });
});

srv.listen(PORT, '0.0.0.0', () => console.log('play4u addon v' + VERSION + ' on ' + PORT + ' (probe=' + (POOL ? POOL.PROBE_HOST : '-') + ')'));
try { if (POOL) POOL.start(); } catch (e) { console.error('[pool] start-err ' + (e && e.message)); }
/* ★ বুটেই ক্যানারি — রিস্টার্টের পর প্রথম সেকেন্ড থেকেই নোড যাচাই শুরু হয় */
setTimeout(async () => {
  try {
    const r = await ATL.resolve({ id: 'tt0770828', type: 'movie' });
    if (r && r.streams && r.streams[0] && POOL && POOL.setCanary) { POOL.setCanary(r.streams[0].url); console.log('[p4u] ক্যানারি প্রস্তুত'); }
  } catch (e) { }
}, 2000);
process.on('uncaughtException', e => console.error('[uncaught] ' + ((e && e.stack) || e)));
process.on('unhandledRejection', e => console.error('[unhandled] ' + ((e && e.message) || e)));
module.exports = { srv, streamsFor };
