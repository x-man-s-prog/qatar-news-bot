// Core library: sources, fetching, parsing, filtering, dedup, extraction.
// Pure logic (no secrets) — testable locally.
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';

const silentVC = new VirtualConsole();
silentVC.on('jsdomError', () => {}); // swallow harmless CSS/parse warnings

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// ---------- date helpers ----------
function qatarNow() { return new Date(Date.now() + 3 * 3600 * 1000); } // UTC+3 wall clock
export function monthParts() {
  const q = qatarNow();
  const y = q.getUTCFullYear(), m = q.getUTCMonth() + 1, day = q.getUTCDate();
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
  return { y, m, day, py, pm };
}

// ---------- sources ----------
export function buildSources() {
  const { y, m, day, py, pm } = monthParts();
  const S = [
    { newspaper: 'الشرق', lang: 'ar', type: 'scrape_a', base: 'https://al-sharq.com', url: 'https://al-sharq.com/' },
    { newspaper: 'العرب', lang: 'ar', type: 'scrape_a', base: 'https://alarab.qa', url: 'https://alarab.qa/' },
    { newspaper: 'الراية', lang: 'ar', type: 'scrape_raya', base: 'https://www.raya.com', url: 'https://www.raya.com/' },
    { newspaper: 'الوطن', lang: 'ar', type: 'rss', base: 'https://www.al-watan.com', url: 'https://www.al-watan.com/rssFeed/0' },
    { newspaper: 'لوسيل', lang: 'ar', type: 'sitemap', base: 'https://lusailnews.net', url: `https://lusailnews.net/sitemap_articles-${y}-${m}.xml` },
    { newspaper: 'Qatar Tribune', lang: 'en', type: 'rss', base: 'https://www.qatar-tribune.com', url: 'https://www.qatar-tribune.com/rssFeed/0' },
    { newspaper: 'The Peninsula', lang: 'en', type: 'sitemap', base: 'https://thepeninsulaqatar.com', url: `https://thepeninsulaqatar.com/sitemap_articles-${y}-${m}.xml` },
    { newspaper: 'Gulf Times', lang: 'en', type: 'rss', base: 'https://www.gulf-times.com', url: 'https://www.gulf-times.com/rssFeed/8' },
    { newspaper: 'Gulf Times', lang: 'en', type: 'rss', base: 'https://www.gulf-times.com', url: 'https://www.gulf-times.com/rssFeed/9' },
    { newspaper: 'Gulf Times', lang: 'en', type: 'rss', base: 'https://www.gulf-times.com', url: 'https://www.gulf-times.com/rssFeed/6' },
    { newspaper: 'Gulf Times', lang: 'en', type: 'rss', base: 'https://www.gulf-times.com', url: 'https://www.gulf-times.com/rssFeed/2' },
    { newspaper: 'Gulf Times', lang: 'en', type: 'rss', base: 'https://www.gulf-times.com', url: 'https://www.gulf-times.com/rssFeed/5' },
    { newspaper: 'Gulf Times', lang: 'en', type: 'rss', base: 'https://www.gulf-times.com', url: 'https://www.gulf-times.com/rssFeed/4' },
  ];
  if (day <= 2) {
    S.push({ newspaper: 'The Peninsula', lang: 'en', type: 'sitemap', base: 'https://thepeninsulaqatar.com', url: `https://thepeninsulaqatar.com/sitemap_articles-${py}-${pm}.xml` });
    S.push({ newspaper: 'لوسيل', lang: 'ar', type: 'sitemap', base: 'https://lusailnews.net', url: `https://lusailnews.net/sitemap_articles-${py}-${pm}.xml` });
  }
  return S;
}
export const GAZETTE_SOURCE = { newspaper: '📜 الجريدة الرسمية (الميزان)', lang: 'ar', type: 'meezan', base: 'https://almeezan.qa', url: 'https://r.jina.ai/https://almeezan.qa/' };

// ---------- fetch ----------
export async function fetchText(url, { timeout = 25000, retries = 1, extraHeaders = {} } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ar,en;q=0.8', ...extraHeaders }, redirect: 'follow', signal: ctrl.signal });
      const body = await r.text();
      clearTimeout(t);
      return { ok: r.ok, status: r.status, body };
    } catch (e) {
      clearTimeout(t);
      if (attempt === retries) return { ok: false, status: 0, body: '', err: String(e) };
      await new Promise(res => setTimeout(res, 1500));
    }
  }
  return { ok: false, status: 0, body: '' };
}

// ---------- small html/text utils ----------
export function decodeEnt(s) {
  return String(s || '')
    .split('&nbsp;').join(' ').split('&amp;').join('&').split('&quot;').join('"')
    .split('&#39;').join("'").split('&apos;').join("'").split('&laquo;').join('«')
    .split('&raquo;').join('»').split('&lt;').join('<').split('&gt;').join('>');
}
function norm(s) { return decodeEnt(String(s || '')).replace(/\s+/g, ' ').trim(); }
function stripTags(s) { return String(s || '').replace(/<[^>]+>/g, ' '); }
function decodeSlug(u) {
  try {
    let last = u.split('?')[0].replace(/\/+$/, '').split('/').pop();
    last = decodeURIComponent(last);
    return last.replace(/[-_]+/g, ' ').trim();
  } catch { return ''; }
}
export function canon(u) { return String(u || '').split('#')[0].split('?')[0].replace(/\/+$/, ''); }
export function hashId(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return 'q' + h.toString(36); }
function pDate(str) {
  if (!str) return NaN;
  let s = String(str).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) s = s.replace(' ', 'T') + '+03:00';
  return Date.parse(s);
}
function blocks(body, name) {
  const res = []; const open = '<' + name + '>'; const close = '</' + name + '>';
  let idx = 0;
  while (true) {
    const oi = body.indexOf(open, idx); if (oi < 0) break;
    const ci = body.indexOf(close, oi); if (ci < 0) break;
    res.push(body.slice(oi, ci + close.length)); idx = ci + close.length;
    if (res.length > 2000) break;
  }
  return res;
}
function tag(block, name) {
  const oi = block.indexOf('<' + name); if (oi < 0) return '';
  const gt = block.indexOf('>', oi); if (gt < 0) return '';
  const close = '</' + name + '>'; const ci = block.indexOf(close, gt); if (ci < 0) return '';
  return block.slice(gt + 1, ci).split('<![CDATA[').join('').split(']]>').join('').trim();
}

// ---------- filters: sport + jobs ----------
const sportAr = /(الرياضة|الرياضي|رياضية|رياضي|رياضة|كرة القدم|كرة السلة|كرة اليد|كرة الطائرة|مباراة|مباريات|الدوري|دوري|المنتخب|منتخب|بطولة|كأس العالم|المونديال|مونديال|فيفا|لاعب|اللاعبين|أولمبي|أولمبية|التنس|الجولف|كريكيت|بادل|الملعب|ميسي|رونالدو|نيمار|هاتريك|تشكيلة|الهداف)/;
const jobsAr = /(وظيفة|وظائف|شواغر|شاغر|فرص عمل|فرصة عمل|توظيف|التوظيف|للتوظيف|منصة كوادر|تعيينات|مطلوب للعمل|مطلوب موظف|التقديم على الوظائف|استقطاب الكفاءات|تطرح وظيف|تعلن عن وظيف)/;
const sportSet = new Set(['sport','sports','football','soccer','match','matches','league','cup','fifa','goal','goals','player','players','tournament','olympic','olympics','tennis','golf','cricket','formula','motogp','padel','basketball','athletic','athletics','striker','goalkeeper','messi','ronaldo','neymar','uefa','worldcup']);
const jobsSet = new Set(['job','jobs','vacancy','vacancies','hiring','recruit','recruitment','recruiting','careers','employ','employment']);
function hit(t, re, set) {
  if (!t) return false;
  if (re.test(t)) return true;
  const toks = String(t).toLowerCase().match(/[a-z]+/g) || [];
  for (const w of toks) if (set.has(w)) return true;
  return false;
}
export function isSport(t) { return hit(t, sportAr, sportSet); }
export function isJobs(t) { return hit(t, jobsAr, jobsSet); }

// ---------- dedup fingerprint ----------
export function makeSig(text) {
  let s = String(text || '');
  s = s.replace(/[ً-ٕـٰ]/g, ''); // diacritics + tatweel
  s = s.replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
  s = s.toLowerCase();
  s = s.replace(/[^ء-ي a-z0-9]+/g, ' ');
  const stop = new Set(['علي','الي','التي','الذي','هذا','هذه','ذلك','بين','بعد','قبل','خلال','حول','عند','كل','مع','عن','من','الى','the','and','for','with','that','this','new']);
  const words = s.split(' ').filter(w => w.length >= 3 && !stop.has(w));
  return Array.from(new Set(words)).sort();
}
export function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

// ---------- per-source parsing ----------
export function parseSource(src, body) {
  const NOW = Date.now();
  const out = [];
  if (!body || typeof body !== 'string') return out;
  if (src.type === 'rss') {
    for (const b of blocks(body, 'item')) {
      const link = tag(b, 'link'); if (!link) continue;
      out.push({ url: link, title: tag(b, 'title'), desc: tag(b, 'description'), date: orNow(pDate(tag(b, 'pubDate')), NOW) });
    }
  } else if (src.type === 'sitemap') {
    for (const b of blocks(body, 'url')) {
      const loc = tag(b, 'loc').split('&amp;').join('&'); if (!loc) continue;
      const d = tag(b, 'news:publication_date') || tag(b, 'lastmod') || tag(b, 'publication_date');
      out.push({ url: loc, title: decodeSlug(loc), desc: '', date: orNow(pDate(d), NOW) });
    }
  } else if (src.type === 'scrape_a') {
    const re = /\/article\/(\d{2})\/(\d{2})\/(\d{4})\/[^"'<>\s]+/g; let m; const seen = new Set();
    while ((m = re.exec(body)) !== null) {
      if (seen.has(m[0])) continue; seen.add(m[0]);
      const url = src.base + m[0];
      out.push({ url, title: decodeSlug(url), desc: '', date: orNow(Date.parse(`${m[3]}-${m[2]}-${m[1]}T08:00:00+03:00`), NOW) });
    }
  } else if (src.type === 'scrape_raya') {
    const re = /https?:\/\/(?:www\.)?raya\.com\/(\d{4})\/(\d{2})\/(\d{2})\/[^"'<>\s]+/g; let m; const seen = new Set();
    while ((m = re.exec(body)) !== null) {
      if (seen.has(m[0])) continue; seen.add(m[0]);
      out.push({ url: m[0], title: decodeSlug(m[0]), desc: '', date: orNow(Date.parse(`${m[1]}-${m[2]}-${m[3]}T08:00:00+03:00`), NOW) });
    }
  } else if (src.type === 'meezan') {
    // jina markdown: [text](https://almeezan.qa/LawPage.aspx?id=N&language=ar "FULL TITLE")
    const key = 'LawPage.aspx?id='; let pos = 0; const seen = new Set();
    while (true) {
      const k = body.indexOf(key, pos); if (k < 0) break;
      let j = k + key.length; let id = '';
      while (j < body.length && body[j] >= '0' && body[j] <= '9') { id += body[j]; j++; }
      let title = '';
      const q1 = body.indexOf('"', j);
      if (q1 >= 0 && q1 - j < 80) { const q2 = body.indexOf('"', q1 + 1); if (q2 > q1 && q2 - q1 < 900) title = body.slice(q1 + 1, q2); }
      pos = q1 >= 0 ? q1 + 1 : j;
      if (!id || seen.has(id)) continue; seen.add(id);
      title = norm(title);
      if (!title || title.length < 8) continue;
      out.push({ url: `https://almeezan.qa/LawPage.aspx?id=${id}&language=ar`, title, desc: '', date: Date.now(), gazetteId: 'meezan' + id });
    }
  }
  return out;
}
function orNow(t, NOW) { return isNaN(t) ? NOW : t; }

// build candidate objects (filtered, recency, within-batch dedup by url)
export function toCandidates(src, rawItems, { maxAgeMs = 48 * 3600 * 1000 } = {}) {
  const NOW = Date.now(); const out = [];
  for (const it of rawItems) {
    if (src.type !== 'meezan') {
      if (isNaN(it.date) || (NOW - it.date) > maxAgeMs) continue;
      if (/\/(category|writers|tag|author|video|photos|gallery|page)\//i.test(it.url)) continue;
      if (isSport(it.title) || isSport(it.url) || isSport(it.desc)) continue;
      if (isJobs(it.title) || isJobs(it.url) || isJobs(it.desc)) continue;
    }
    const cu = canon(it.url); if (!cu || cu.length < 12) continue;
    const id = it.gazetteId || hashId(cu);
    out.push({
      article_id: id, newspaper: src.newspaper, lang: src.lang, type: src.type,
      url: cu, title_slug: it.title || '', desc: it.desc || '',
      pub_date: new Date(it.date).toISOString(), _date: it.date,
    });
  }
  return out;
}

// ---------- article body extraction (Readability + fallback) ----------
const MARKERS = ['text-end article-body','article-body','news-mm-detail','entry-content','post-content','article__body','article-content','article-details','content-detail','td-post-content','story-body','articleBody','the-content','field--name-body'];
function fallbackExtract(html) {
  if (!html) return '';
  let h = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ').replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ').replace(/<aside[\s\S]*?<\/aside>/gi, ' ');
  let i = -1; for (const mk of MARKERS) { const k = h.indexOf(mk); if (k >= 0) { i = k; break; } }
  let slice = i >= 0 ? h.slice(i) : h;
  if (i >= 0) { const gt = slice.indexOf('>'); if (gt >= 0 && gt < 200) slice = slice.slice(gt + 1); }
  const ps = (slice.match(/<p[\s\S]*?<\/p>/gi) || []).map(p => norm(stripTags(p))).filter(x => x.length >= 40);
  let body = ps.join('\n');
  if (body.length < 150) body = norm(stripTags(slice));
  return body.slice(0, 12000);
}
export function extractBody(html, url) {
  if (!html) return '';
  try {
    const dom = new JSDOM(html, { url, virtualConsole: silentVC });
    const art = new Readability(dom.window.document).parse();
    if (art && art.textContent) {
      const txt = art.textContent.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
      if (txt.length > 150) return txt.slice(0, 14000);
    }
  } catch { /* fall through */ }
  return fallbackExtract(html);
}
