#!/usr/bin/env node
/* p4u-pool.js — ★ আমাদের নিজের প্রক্সি-পুল (rate limit এড়াতে)
 *
 * ব্যবহার: hls.lol / shegu / pal API আর মিডিয়া-হোস্ট সবাই এই পুল দিয়ে ফেচ হবে।
 * ডিজাইন (nexa-র প্রমাণিত প্যাটার্ন, কিন্তু নিজস্ব কোড/ডেটা):
 *   • উৎস-তালিকা থেকে নোড সংগ্রহ (প্রতি ২ মিনিটে, LRU-ক্রমে) — প্রথমে বান্ডল করা যাচাই-তালিকা
 *   • CONNECT/TLS-যাচাই সমান্তরালে (কর্মী ২৪)
 *   • নোড-স্কোর + কুলডাউন (403/429/টাইমআউট হলে ওই নোড ৯০সে বাদ)
 *   • ঘোরাফেরা (round-robin) — একই নোডে চাপ পড়ে না ⇒ ratelimit কম
 *   • হেলথ-স্ট্যাট: কোন নোড কতগুলো ফেচ সার্ভ করল
 *
 * নোড-ফরম্যাট: { px: 'host:port', ok, ms, fails, cool, served }
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const tls = require('tls');

const POOL_FILE = process.env.ATL_POOL_FILE || path.join(__dirname, 'p4u_px_verified.json');
const ENABLED = String(process.env.ATL_PROXY || '1') !== '0';   /* ATL_PROXY=0 ⇒ সরাসরি */
const GOAL = Number(process.env.P4U_PX_GOAL || 30);
const COOL_MS = Number(process.env.P4U_PX_COOL || 90000);
const WORKERS = Number(process.env.P4U_PX_WORKERS || 24);
const CYCLE_MS = Number(process.env.P4U_PX_CYCLE || 120000);

/* ── তালিকা ── */
const LISTS = [
  'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=8000&country=all&ssl=all&anonymity=all',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
  'https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt',
  'https://raw.githubusercontent.com/prxchk/proxy-list/main/http.txt',
  'https://raw.githubusercontent.com/zloi-user/hideip.me/main/http.txt',
  'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt',
  'https://proxyspace.pro/http.txt',
  'https://www.proxy-list.download/api/v1/get?type=http',
  'https://www.proxy-list.download/api/v1/get?type=https',
];

const nodes = new Map();     /* px → node */
let rr = 0, cycleAt = 0, cycleN = 0;
const STATS = { fetches: 0, viaProxy: 0, direct: 0, fails: 0 };

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8')) || {};
    for (const k of Object.keys(j)) nodes.set(k, { px: k, ok: true, ms: j[k].ms || 3000, fails: 0, cool: 0, served: 0, ts: j[k].ts || 0 });
  } catch (e) { }
}
function save() {
  try {
    const o = {};
    for (const n of nodes.values()) if (n.ok) o[n.px] = { ms: n.ms, ts: Date.now() };
    fs.writeFileSync(POOL_FILE + '.tmp', JSON.stringify(o));
    fs.renameSync(POOL_FILE + '.tmp', POOL_FILE);
  } catch (e) { }
}
load();

/* ── CONNECT-যাচাই (TLS) ── */
/* ★ v3.1: **পুলের টার্গেট = Play4u-র CDN** (আগে api.themoviedb.org)।
   নোড "ok" তখনই, যখন সে CDN-এ CONNECT করতে পারে — ওখানেই আসল HLS। */
let PROBE_HOST = process.env.P4U_PX_HOST || 'furiosamedia.vip';
function tlsOk(px, ms = 5000) {
  return new Promise(res => {
    const i = px.lastIndexOf(':');
    const host = px.slice(0, i), port = Number(px.slice(i + 1));
    let done = false;
    const fin = v => { if (!done) { done = true; try { s.destroy(); } catch (e) { } res(v); } };
    const s = require('net').connect({ host, port });
    const to = setTimeout(() => fin(false), ms);
    s.once('error', () => { clearTimeout(to); fin(false); });
    s.once('connect', () => {
      s.write('CONNECT ' + PROBE_HOST + ':443 HTTP/1.1\r\nHost: ' + PROBE_HOST + ':443\r\n\r\n');
      let buf = '';
      const onD = d => {
        buf += d.toString('latin1');
        if (buf.indexOf('\r\n\r\n') < 0) return;
        s.removeListener('data', onD);
        if (!/^HTTP\/1\.[01] 200/.test(buf)) { clearTimeout(to); return fin(false); }
        const t = tls.connect({ socket: s, servername: PROBE_HOST, rejectUnauthorized: false }, () => { clearTimeout(to); fin(true); });
        t.on('error', () => { clearTimeout(to); fin(false); });
      };
      s.on('data', onD);
    });
  });
}

let SCANNING = false;
async function scan() {
  /* ★ v3.0.2: **ওভারল্যাপ-গার্ড** (মাপা: চক্র প্রতি ৫০–৫০০ms চালু হচ্ছিল ⇒ CPU/নেট সম্পূর্ণ
     দখল হয়ে ক্যানারি-যাচাই মার খাচ্ছিল, verified=0)। একসাথে একটাই স্ক্যান। */
  if (SCANNING) return 0;
  SCANNING = true;
  try { return await scanOnce(); } finally { SCANNING = false; } // eslint-disable-line

}
async function scanOnce() {
  cycleAt = Date.now();
  const seen = new Set(nodes.keys());
  const cand = [];
  await Promise.all(LISTS.map(async u => {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(9000), headers: { 'user-agent': 'p4u-pool/1' } });
      const txt = await r.text();
      for (const m of txt.matchAll(/\b(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})\b/g)) {
        const px = m[1] + ':' + m[2];
        if (!seen.has(px)) { seen.add(px); cand.push(px); }
      }
    } catch (e) { }
  }));
  /* LRU: পুরোনো-প্রচেষ্টা আগে */
  cand.sort((a, b) => ((nodes.get(a) || {}).ts || 0) - ((nodes.get(b) || {}).ts || 0));
  const verifiedN = okNodes().filter(n => n.verified).length;
  const cap = Number(process.env.P4U_PX_BATCH || 200);
  /* ★ v3.0.3: verified নোড goal-এর কম থাকলে পূর্ণ ব্যাচ (নাহলে পুরোনো 'ok' গোনায় স্ক্যানার অলস হয়) */
  /* warmup: verified খুব কম থাকলে বড় ব্যাচ (দ্রুত পুল গড়া) */
  const warm = verifiedN < GOAL;
  const batch = cand.slice(0, verifiedN >= GOAL ? Math.min(60, cap) : (warm ? Math.min(320, cap + 120) : cap));
  let i = 0;
  const found = [];
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    while (i < batch.length) {
      const px = batch[i++];
      const t0 = Date.now();
      let ok = await tlsOk(px, Number(process.env.P4U_PX_CONN || 3000));
      /* ★ ক্যানারি-যাচাই: নোড সত্যিই Play4u-র প্লেলিস্ট আনতে পারে কি না */
      if (ok && CANARY) {
        try {
          const x = await proxyFetch(px, CANARY, { ms: Number(process.env.P4U_PX_GET || 6000), ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/147.0.0.0', headers: { referer: 'https://play4u.org/', origin: 'https://play4u.org', accept: '*/*' } });
          ok = x.status === 200 && /^\s*#EXTM3U/i.test((x.body || Buffer.alloc(0)).slice(0, 100).toString('utf8'));
        } catch (e) { ok = false; }
      }
      const n = nodes.get(px) || { px, fails: 0, cool: 0, served: 0 };
      n.ts = Date.now();
      if (ok) { n.ok = true; n.host = PROBE_HOST; n.verified = !!CANARY; n.ms = Date.now() - t0; n.fails = 0; found.push(px); }
      else { n.ok = false; n.fails = (n.fails || 0) + 1; }
      nodes.set(px, n);
    }
  }));
  cycleN = found.length + [...nodes.values()].filter(n => n.ok).length;
  /* ★ মেমরি-প্রুন: verified নোড + সর্বোচ্চ ৮০টি ok নোড রাখি, বাকি ফেলে দিই (স্বার্ম-মেমরি কম) */
  if (nodes.size > 1500) {
    const keep = [...nodes.values()].filter(n => n.verified || (n.ok && n.host === PROBE_HOST)).sort((a, b) => (b.verified ? 1 : 0) - (a.verified ? 1 : 0) || a.ms - b.ms).slice(0, 400);
    nodes.clear();
    for (const n of keep) nodes.set(n.px, n);
  }
  save();
  console.log('[p4u-pool] চক্র: প্রার্থী=' + cand.length + ' পরীক্ষিত=' + batch.length + ' নতুন live=' + found.length + ' মোট ok=' + okNodes().length);
  return found.length;
}

function okNodes() {
  const now = Date.now();
  /* ★ v3.0: **ক্যানারি-যাচাই করা নোড আগে** (CONNECT-পাস কিন্তু GET-ব্যর্থ নোড প্লেয়ার ভাঙে) */
  return [...nodes.values()].filter(n => n.ok && n.host === PROBE_HOST && (!n.cool || n.cool < now))
    .sort((a, b) => (b.verified ? 1 : 0) - (a.verified ? 1 : 0) || a.ms - b.ms || (a.served || 0) - (b.served || 0));
}

/* ── প্রক্সি-ফেচ (http/https দুটোই, GET) ── */
function proxyFetch(px, url, opts = {}) {
  return new Promise((resolve, reject) => {
    const i = px.lastIndexOf(':');
    const ph = px.slice(0, i), pp = Number(px.slice(i + 1));
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const targetHost = u.hostname, targetPort = u.port || (isHttps ? 443 : 80);
    let done = false, sock = null;
    const to = setTimeout(() => fin(new Error('timeout')), opts.ms || 9000);
    function fin(err, val) {
      if (done) return; done = true;
      clearTimeout(to);
      try { sock && sock.destroy(); } catch (e) { }
      err ? reject(err) : resolve(val);
    }
    /* ★ v3.0.4: **দ্রুত ব্যর্থতা** — কানেক্ট/CONNECT-ফেজে ৪সে; নাহলে মৃত নোডে ৩০সে আটকায় */
    const phase = setTimeout(() => fin(new Error('connect-timeout')), Number(process.env.P4U_PX_PHASE || 4000));
    const clearPhase = () => clearTimeout(phase);
    sock = require('net').connect({ host: ph, port: pp });
    sock.once('error', e => { clearPhase(); fin(e); });
    sock.once('connect', () => {
      if (isHttps) {
        sock.write('CONNECT ' + targetHost + ':' + targetPort + ' HTTP/1.1\r\nHost: ' + targetHost + ':' + targetPort + '\r\n\r\n');
        let buf = '';
        const onD = d => {
          buf += d.toString('latin1');
          if (buf.indexOf('\r\n\r\n') < 0) return;
          sock.removeListener('data', onD);
          if (!/^HTTP\/1\.[01] 200/.test(buf)) return fin(new Error('proxy-refused'));
          const t = tls.connect({ socket: sock, servername: targetHost, rejectUnauthorized: false }, () => { clearPhase(); send(t); });
          t.on('error', e => fin(e));
        };
        sock.on('data', onD);
      } else send(sock);
    });

    function send(strm) {
      /* ★ v2.4: শুধু সাধারণ ব্রাউজার-হেডার পাঠাই। `origin`/`referer`/`range` ইত্যাদি
         পাবলিক প্রক্সি পাস করালে কিছু প্রক্সি **নিজের CGI ডাম্প** (REMOTE_ADDR=…) ফেরত দেয়
         ⇒ মাপা: প্লেলিস্টের বদলে টেক্সট = source error। */
      /* ★ v3.0: **referer/origin বাধ্যতামূলক** — Play4u CDN referer ছাড়া 302 করে (মাপা)।
         বাকি সব (cookie ইত্যাদি) বাদ; জাঙ্ক-উত্তর আলাদা ফিল্টারে বাতিল হয়। */
      const SAFE = ['accept', 'accept-language', 'range', 'if-none-match', 'if-modified-since', 'referer', 'origin'];
      const extra = {};
      for (const k of Object.keys(opts.headers || {})) if (SAFE.includes(String(k).toLowerCase())) extra[k] = opts.headers[k];
      const headers = Object.assign({
        host: u.host, 'user-agent': opts.ua || 'Mozilla/5.0', accept: '*/*', connection: 'close',
        'accept-encoding': 'identity',
      }, extra);
      let head = 'GET ' + (u.pathname + (u.search || '')) + ' HTTP/1.1\r\n';
      for (const k of Object.keys(headers)) if (headers[k] != null) head += k + ': ' + headers[k] + '\r\n';
      head += '\r\n';
      strm.write(head);
      const chunks = [];
      strm.on('data', c => chunks.push(c));
      strm.on('end', () => {
        const raw = Buffer.concat(chunks);
        const idx = raw.indexOf('\r\n\r\n');
        if (idx < 0) return fin(new Error('bad-response'));
        const headTxt = raw.slice(0, idx).toString('latin1');
        const status = Number((headTxt.match(/^HTTP\/1\.[01] (\d{3})/) || [])[1]) || 0;
        let body = raw.slice(idx + 4);
        if (/transfer-encoding:\s*chunked/i.test(headTxt)) {
          const out = []; let p = 0;
          while (p < body.length) {
            const nl = body.indexOf('\r\n', p);
            if (nl < 0) break;
            const sz = parseInt(body.slice(p, nl).toString('latin1'), 16);
            if (!sz || isNaN(sz)) break;
            out.push(body.slice(nl + 2, nl + 2 + sz));
            p = nl + 2 + sz + 2;
          }
          body = Buffer.concat(out);
        }
        /* ★ v2.4: ভুয়া ২০০ — প্রক্সির নিজের পেজ (REMOTE_ADDR=… / <html> / proxy error) বাতিল */
        const sniff = body.slice(0, 400).toString('latin1');
        const looksPl = /^\s*(#EXTM3U|<\?xml|<MPD)/i.test(sniff);
        const looksMedia = /^(\x00|\xff\xd8|\x89PNG|ID3|\x1a\x45\xdf\xa3|\x47)/.test(sniff) || /^\s*(\{|\[|<)/.test(sniff);
        const junk = /REMOTE_ADDR\s*=|REMOTE_PORT\s*=|^HTTP\/1\.[01] [45]\d\d|proxy (authentication|error)|<title>\s*(?:error|proxy)/i.test(sniff);
        if (junk || (!looksPl && !looksMedia && sniff.trim().length && /^[A-Z_]+\s*=/.test(sniff.trim()))) return fin(new Error('proxy-junk'));
        fin(null, { status, body, head: headTxt });
      });
      strm.on('error', e => fin(e));
    }
  });
}

/* ★ v3.0: **ক্যানারি** — Play4u CDN-এর আসল প্লেলিস্ট। স্ক্যানে CONNECT-পাস নোড দিয়েও
   একবার GET করি; #EXTM3U না এলে নোড "ok" নয় (নাহলে CONNECT-সফল কিন্তু GET-ব্যর্থ নোডে
   রিলে আটকে যায় ⇒ source error)। */
let CANARY = process.env.P4U_CANARY || null;
function setCanary(u) {
  if (!u || u === CANARY) return;
  CANARY = u;
  try { const h = new URL(u).host; if (h && !process.env.P4U_PX_HOST) PROBE_HOST = h; } catch (e) { }
  try { require('fs').writeFileSync('/tmp/p4u_canary.json', JSON.stringify({ u, h: PROBE_HOST })); } catch (e) { }
  console.log('[p4u-pool] ক্যানারি সেট → ' + PROBE_HOST);
}

/* ── মূল API: পুল দিয়ে ফেচ, ব্যর্থ হলে সরাসরি (fallback) ── */
async function pfetch(url, opts = {}) {
  STATS.fetches++;
  const direct = async () => {
    STATS.direct++;
    const r = await fetch(url, {
      signal: AbortSignal.timeout(opts.ms || 9000),
      headers: Object.assign({ 'user-agent': opts.ua || 'Mozilla/5.0', accept: '*/*' }, opts.headers || {}),
    });
    const body = Buffer.from(await r.arrayBuffer());
    return { status: r.status, body, via: 'direct' };
  };
  /* ★ v2.4: `noDirect` — ইউজারের নির্দেশ: **স্ট্রিম-ফেচ সবসময় প্রক্সি দিয়ে**;
     প্রক্সি একেবারেই না থাকলে তবেই ডাইরেক্ট (এখানে status 0 ফেরত দিই, কলার ডাইরেক্ট করবে)। */
  if (!ENABLED || !okNodes().length) return opts.noDirect ? { status: 0, body: null, via: 'no-proxy' } : direct();
  const avoid = opts.avoid ? (opts.avoid instanceof Set ? opts.avoid : new Set(opts.avoid)) : null;
  const list = okNodes().filter(n => !avoid || !avoid.has(n.px)).slice(0, 8);
  for (let k = 0; k < Math.min(4, list.length); k++) {
    const n = list[rr++ % list.length];
    try {
      const r = await proxyFetch(n.px, url, { ms: opts.ms || 9000, ua: opts.ua, headers: opts.headers });
      if (r.status === 403 || r.status === 429 || r.status === 407) { n.cool = Date.now() + COOL_MS; n.fails++; continue; }
      if (r.status === 0 || !r.body || !r.body.length) { n.fails++; continue; }
      n.served = (n.served || 0) + 1; STATS.viaProxy++;
      return Object.assign(r, { via: n.px });
    } catch (e) {
      n.fails = (n.fails || 0) + 1;
      if (n.fails >= 2) n.cool = Date.now() + COOL_MS;
      STATS.fails++;
    }
  }
  return opts.noDirect ? { status: 0, body: null, via: 'no-proxy' } : direct();
}

/* ★ v3.0: **প্যারালাল রেস** — ছোট রিসোর্সে (প্লেলিস্ট) ৩টি verified নোড একসাথে;
   প্রথম বৈধ উত্তরই জেতে (লেটেন্সি ~৩গুণ কমে)। বাকিগুলো abort হয় না — বডি ছোট, ক্ষতি নেই। */
const VALID = b => {
  if (!b || !b.length) return false;
  const h = b.slice(0, 240).toString('utf8');
  if (/^\s*(#EXTM3U|<\?xml|<MPD)/i.test(h)) return true;
  if (/^\s*[A-Z_]{4,}\s*=/m.test(h) || /<html|REMOTE_ADDR\s*=/i.test(h)) return false;
  return true;                       /* মিডিয়া-বাইট (ts/fmp4) */
};
async function praise(url, opts = {}) {
  STATS.fetches++;
  const cand = okNodes().filter(n => !opts.avoid || !opts.avoid.has(n.px));
  /* verified (ক্যানারি-পাস) নোড আগে — অন্যগুলো শুধু ব্যাকআপ */
  const vlist = cand.filter(n => n.verified);
  const pool = opts.verifiedOnly ? vlist.slice(0, 2) : vlist.slice(0, 3).concat(cand.filter(n => !n.verified).slice(0, 1));
  if (!pool.length) return opts.noDirect ? { status: 0, body: null, via: 'no-proxy' } : NULLDIRECT(url, opts);
  const tries = pool.slice(0, 3).map(n => proxyFetch(n.px, url, { ms: opts.ms || 9000, ua: opts.ua, headers: opts.headers })
    .then(r => ({ r, n })).catch(() => null));
  const proxyRace = Promise.race(tries.map(p => p.then(v => (v && v.r.status === 200 && VALID(v.r.body) ? v : Promise.reject(0)))));
  /* ★ v3.0.3: **হেজ** — প্রক্সি `hedge` মি.লি.-এর মধ্যে না এলে ডাইরেক্টও শুরু; আগে যেটা বৈধ,
     সেটাই যায়। (ইউজারের নীতি: প্রক্সি সবসময় আগে, কিন্তু প্রক্সি না পারলে ডাইরেক্ট।) */
  const hedge = Number(opts.hedge || 2500);
  const directRace = new Promise((res, rej) => setTimeout(() => {
    NULLDIRECT(url, opts).then(v => (v && v.status === 200 && VALID(v.body) ? res({ r: v, n: { px: 'direct', ms: 0 } }) : rej(0))).catch(() => rej(0));
  }, hedge));
  const res = await Promise.race([proxyRace, directRace]);
  return { status: res.r.status, body: res.r.body, via: res.n.px };
}
function NULLDIRECT(url, opts) {
  STATS.direct++;
  return fetch(url, { signal: AbortSignal.timeout(opts.ms || 9000), headers: Object.assign({ 'user-agent': opts.ua || 'Mozilla/5.0', accept: '*/*' }, opts.headers || {}) })
    .then(async r => ({ status: r.status, body: Buffer.from(await r.arrayBuffer()), via: 'direct' }))
    .catch(() => ({ status: 0, body: null, via: 'direct' }));
}

/* ★ v3.0: **স্ট্রিমিং** — সেগমেন্টের প্রথম কয়েক KB যাচাই করে বাকিটা সরাসরি পাস-থ্রু
   (পুরো ফাইল মেমরিতে জমিয়ে রাখলে প্লেব্যাক ৮–২৬সে দেরি হয় — মাপা)। */
/* ★★ v3.2: **ডেডলক-ফিক্স** — আগে CONNECT-উত্তর টিএলএস থেকে আসা ডেটা প্যারেন্ট-সকেটের
   পুরোনো `onC` হ্যান্ডলারেও যেত; একাধিক স্ট্রিম একসাথে (ভিডিও+অডিও) হলে সেগুলোর
   CONNECT-বাফারে ঢুকে হ্যান্ডলার আটকে যেত ⇒ অডিও-সেগমেন্ট কখনো আসত না ("ভিডিওতে অডিও নেই")।
   এখন হ্যান্ডলার সরাসরি সকেটে `prependListener` দিয়ে বসে আর কনজিউম হয়. */
function pstream(px, url, opts, onHead, onData, onEnd, onFail) {
  const i = px.lastIndexOf(':');
  const ph = px.slice(0, i), pp = Number(px.slice(i + 1));
  const u = new URL(url);
  let sock = null, done = false, headDone = false, status = 0, bodyBuf = Buffer.alloc(0);
  const to = setTimeout(() => fin(new Error('timeout')), opts.ms || 25000);
  const phase = setTimeout(() => fin(new Error('connect-timeout')), Number(process.env.P4U_PX_PHASE || 5000));
  function fin(err) {
    if (done) return; done = true;
    clearTimeout(to); clearTimeout(phase);
    try { sock && sock.destroy(); } catch (e) { }
    err ? onFail(err) : onEnd();
  }
  function handle(d) {
    if (headDone) return onData(d);
    bodyBuf = Buffer.concat([bodyBuf, d]);
    const idx = bodyBuf.indexOf('\r\n\r\n');
    if (idx < 0) { if (bodyBuf.length > 65536) fin(new Error('bad-head')); return; }
    const headTxt = bodyBuf.slice(0, idx).toString('latin1');
    status = Number((headTxt.match(/^HTTP\/1\.[01] (\d{3})/) || [])[1]) || 0;
    const rest = bodyBuf.slice(idx + 4);
    bodyBuf = Buffer.alloc(0);
    /* ★ v3.6: ২০৬ (Range/Partial-Content) আগে ব্যর্থ ধরা হতো ⇒ প্লেয়ারের Range-অনুরোধ
       সবসময় ফেল হতো আর ধীর direct-পথে যেত (প্লে-স্টার্ট ৩.২সে+)। এখন ২০০/২০৬/৪১৬ বৈধ। */
    if (status !== 200 && status !== 206 && status !== 416) return fin(new Error('status-' + status));
    const sniff = rest.slice(0, 240).toString('utf8');
    headDone = true;
    onHead(status, headTxt);
    if (rest.length) onData(rest);
  }
  sock = require('net').connect({ host: ph, port: pp });
  sock.on('error', e => fin(e));
  sock.once('connect', () => {
    sock.write('CONNECT ' + u.hostname + ':443 HTTP/1.1\r\nHost: ' + u.hostname + ':443\r\n\r\n');
    let cbuf = '';
    const onC = d => {
      cbuf += d.toString('latin1');
      const idx = cbuf.indexOf('\r\n\r\n');
      if (idx < 0) { if (cbuf.length > 16384) fin(new Error('bad-connect')); return; }
      sock.removeListener('data', onC);
      cbuf = '';
      const headStr = d.toString('latin1');
      if (!/^HTTP\/1\.[01] 200/.test(headStr)) return fin(new Error('proxy-refused'));
      clearTimeout(phase);
      const t = require('tls').connect({ socket: sock, servername: u.hostname, rejectUnauthorized: false }, () => {
        const H = Object.assign({ host: u.host, 'user-agent': opts.ua || 'Mozilla/5.0', accept: '*/*', connection: 'close', 'accept-encoding': 'identity' }, opts.headers || {});
        let head = 'GET ' + (u.pathname + (u.search || '')) + ' HTTP/1.1\r\n';
        for (const k of Object.keys(H)) if (H[k] != null) head += k + ': ' + H[k] + '\r\n';
        t.write(head + '\r\n');
      });
      t.on('error', e => fin(e));
      t.on('data', handle);
      t.on('end', () => fin(null));
      t.on('close', () => fin(null));
    };
    sock.on('data', onC);
  });
}

function start() {
  if (!ENABLED) { console.log('[p4u-pool] বন্ধ (ATL_PROXY=0)'); return; }
  load();
  /* ★ রিস্টার্টের পরেই ক্যানারি ফিরে আসে ⇒ কোল্ড-স্টার্টে নোড যাচাই শুরু থেকে চলে */
  try {
    const c = JSON.parse(require('fs').readFileSync('/tmp/p4u_canary.json', 'utf8'));
    if (c && c.u) { CANARY = c.u; if (!process.env.P4U_PX_HOST && c.h) PROBE_HOST = c.h; console.log('[p4u-pool] ক্যানারি লোড → ' + PROBE_HOST); }
  } catch (e) { }
  const tick = async () => {
    try { await scan(); } catch (e) { console.error('[p4u-pool] scan-err ' + (e && e.message)); }
    const behind = okNodes().filter(n => n.verified).length < GOAL;
    const wait = behind ? 15000 : CYCLE_MS;
    const t = setTimeout(tick, wait); if (t.unref) t.unref();
  };
  setTimeout(tick, 1500);
  console.log('[p4u-pool] শুরু — নোড=' + nodes.size + ' goal=' + GOAL + ' workers=' + WORKERS);
}

function stats() {
  const ok = okNodes();
  return {
    enabled: ENABLED, nodes: nodes.size, ok: ok.length, goal: GOAL,
    verified: ok.filter(n => n.verified).length,
    top: ok.slice(0, 6).map(n => ({ px: n.px, ms: n.ms, served: n.served || 0, v: !!n.verified })),
    fetches: STATS.fetches, viaProxy: STATS.viaProxy, direct: STATS.direct, fails: STATS.fails,
    lastCycle: cycleAt ? Math.round((Date.now() - cycleAt) / 1000) + 's ago' : 'never',
  };
}

module.exports = {
  pfetch, praise, pstream, start, stats, okNodes, scan, proxyFetch, STATS, setCanary, VALID,
  get PROBE_HOST() { return PROBE_HOST; },
};
