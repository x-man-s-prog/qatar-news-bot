// Ingest: gather all Qatar papers + official gazette -> filter -> dedup -> summarize/translate -> Telegram.
// No per-run cap. Fair round-robin across papers. Stops cleanly on Gemini quota (resumes next run).
import { buildSources, GAZETTE_SOURCE, fetchText, parseSource, toCandidates, extractBody, makeSig, jaccard } from './lib.mjs';
import { gemini, tgApi, esc, fmtDate, chunkText, loadJson, saveJson, pruneByTs, sleep, QuotaError } from './bot.mjs';

const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SEEN = 'data/seen.json', STORE = 'data/articles.json', FLAGS = 'data/flags.json';
const TH = Number(process.env.DEDUP_THRESHOLD || 0.5);
const PACE_MS = Number(process.env.PACE_MS || 4200);   // ~14/min, respects Gemini free RPM
const SEEN_KEEP = 8000, STORE_KEEP = 800;

if (!CHAT_ID) { console.error('Missing TELEGRAM_CHAT_ID'); process.exit(1); }
{ const me = await tgApi('getMe'); if (!me || !me.ok) { console.error('FATAL: TELEGRAM_BOT_TOKEN is invalid — getMe failed: ' + JSON.stringify(me)); process.exit(1); } console.log('Bot OK: @' + (me.result && me.result.username)); }

const seen = loadJson(SEEN, {});    // id -> { ts, sig:[...], sent:0|1, section? }
const store = loadJson(STORE, {});  // id -> { newspaper, lang, title_ar, full_text, url, pub_date, ts }
const flags = loadJson(FLAGS, { backlogDone: false }); // one-time "backlog finished" separator

function buildPrompt(c, body) {
  return [
    'You are a precise Arabic news editor for a Qatar news digest.',
    `Newspaper: ${c.newspaper}`,
    `Source language: ${c.lang}`,
    `Raw title: ${c.title_slug}`,
    'Body:', body, '',
    'TASKS:',
    '1) Decide if the article is SPORTS-related (football, matches, leagues, tournaments, players, Olympics, athletics, etc.).',
    '2) If it is NOT sports: write a clean Arabic title and a 2 to 4 sentence Arabic summary with the key facts (who/what/when/where). If the source language is English, fully translate into Modern Standard Arabic. Use Arabic guillemets «» for quotes, never straight quotes.',
    'Respond in EXACTLY this plain-text format, nothing else (no JSON, no code fences):',
    'IS_SPORT: yes or no',
    'TITLE: the Arabic title on one line',
    'SUMMARY: the Arabic summary',
    'If it is sports, put IS_SPORT: yes and leave TITLE and SUMMARY empty.',
  ].join('\n');
}
function lineAfter(t, key) { const i = t.indexOf(key); if (i < 0) return ''; const s = t.slice(i + key.length); const nl = s.indexOf('\n'); return (nl >= 0 ? s.slice(0, nl) : s).trim(); }
function blockAfter(t, key) { const i = t.indexOf(key); if (i < 0) return ''; return t.slice(i + key.length).trim(); }
function parseLLM(raw) {
  const t = String(raw || '').trim();
  const sp = lineAfter(t, 'IS_SPORT:').toLowerCase();
  return { is_sport: sp.includes('yes') || sp.includes('نعم'), title_ar: lineAfter(t, 'TITLE:'), summary_ar: blockAfter(t, 'SUMMARY:') };
}

// 1) gather candidates from all sources
const sources = buildSources();
const cands = [];
for (const src of sources) {
  const r = await fetchText(src.url, { timeout: 25000, retries: 1 });
  const got = toCandidates(src, parseSource(src, r.body));
  cands.push(...got);
  console.log(`fetch ${src.newspaper} [${src.type}] http=${r.status} -> ${got.length}`);
}
{ // official gazette (via reader proxy; valid TLS)
  const r = await fetchText(GAZETTE_SOURCE.url, { timeout: 45000, retries: 1 });
  const got = toCandidates(GAZETTE_SOURCE, parseSource(GAZETTE_SOURCE, r.body));
  cands.push(...got);
  console.log(`fetch gazette http=${r.status} -> ${got.length}`);
}

// 2) unique by id, drop already-seen
const uniq = {}; for (const c of cands) if (!uniq[c.article_id]) uniq[c.article_id] = c;
const fresh = Object.values(uniq).filter(c => !seen[c.article_id]);

// 3) fair round-robin order (each paper newest-first, interleaved)
const groups = {}, order = [];
for (const c of fresh) { if (!groups[c.newspaper]) { groups[c.newspaper] = []; order.push(c.newspaper); } groups[c.newspaper].push(c); }
for (const p of order) groups[p].sort((a, b) => b._date - a._date);
const ordered = []; let idx = 0, added = true;
while (added) { added = false; for (const p of order) { if (groups[p][idx]) { ordered.push(groups[p][idx]); added = true; } } idx++; }

const MAX = Number(process.env.MAX_PER_RUN || 400);
const work = ordered.slice(0, MAX);
console.log(`candidates: total=${Object.keys(uniq).length} new=${ordered.length} processing=${work.length} (MAX_PER_RUN=${MAX})`);

// 4) process (no cap), stop on Gemini quota
const recentSigs = Object.values(seen).filter(x => x.sig && x.sig.length && x.sent).map(x => x.sig);
const acceptedSigs = [];
let sent = 0, dups = 0, sports = 0, invalid = 0, quota = false;

for (const c of work) {
  try {
    let title_ar = '', summary_ar = '', full_text = '';
    if (c.type === 'meezan') {
      const expl = (await gemini(`اشرح بإيجاز شديد، في جملة أو جملتين بالعربية الفصحى المبسطة، ما الذي يقرره أو يعدله هذا التشريع القطري بناءً على عنوانه، دون مقدمة أو ألقاب أو رموز:\n${c.title_slug}`, { maxTokens: 300 })).trim();
      title_ar = c.title_slug;
      summary_ar = expl;
      full_text = `${title_ar}\n\n${expl}\n\n🔗 النص الرسمي الكامل على الميزان: ${c.url}`;
    } else {
      const r = await fetchText(c.url, { timeout: 25000, retries: 1 });
      const body = (extractBody(r.body, c.url) || c.desc || c.title_slug || '').slice(0, 9000);
      const parsed = parseLLM(await gemini(buildPrompt(c, body), { maxTokens: 1024 }));
      if (parsed.is_sport) { seen[c.article_id] = { ts: Date.now(), sig: [], sent: 0, section: 'sport' }; sports++; await sleep(PACE_MS); continue; }
      title_ar = parsed.title_ar || c.title_slug;
      summary_ar = parsed.summary_ar;
      if (!summary_ar) { invalid++; await sleep(PACE_MS); continue; } // leave unseen -> retry next run
      full_text = (body && body.length > 60) ? body : (c.desc || title_ar);
    }

    // cross-source dedup
    const sig = makeSig(`${title_ar} ${summary_ar}`);
    let dup = false;
    for (const rs of recentSigs) { if (jaccard(sig, rs) >= TH) { dup = true; break; } }
    if (!dup) for (const as of acceptedSigs) { if (jaccard(sig, as) >= TH) { dup = true; break; } }
    if (dup) { seen[c.article_id] = { ts: Date.now(), sig, sent: 0, section: 'dup' }; dups++; await sleep(PACE_MS); continue; }

    // send
    const btn = c.type === 'meezan' ? '📄 التفاصيل ورابط النص' : '📄 اقرأ النص الكامل';
    const msg = `📰 <b>${esc(c.newspaper)}</b>  •  🗓 ${fmtDate(c.pub_date)}\n\n<b>${esc(title_ar)}</b>\n\n${esc(summary_ar)}`;
    const res = await tgApi('sendMessage', { chat_id: CHAT_ID, text: msg, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: btn, callback_data: c.article_id }]] } });
    if (res && res.ok) {
      seen[c.article_id] = { ts: Date.now(), sig, sent: 1 };
      const rec = { newspaper: c.newspaper, lang: c.lang, title_ar, url: c.url, pub_date: c.pub_date, ts: Date.now() };
      if (c.type === 'meezan') rec.full_text = full_text.slice(0, 4000); // gazette: keep explanation+link; news: re-fetched on tap
      store[c.article_id] = rec;
      acceptedSigs.push(sig); recentSigs.push(sig); sent++;
    } else {
      console.log('send failed', c.article_id, JSON.stringify(res).slice(0, 160));
    }
    await sleep(PACE_MS);
  } catch (e) {
    if (e instanceof QuotaError) { quota = true; console.log('Gemini quota reached — stopping; resumes next run.'); break; }
    if (String(e).includes('API key not valid') || String(e).includes('API_KEY_INVALID')) { console.error('FATAL: GEMINI_API_KEY is invalid — fix the secret and re-run.'); break; }
    console.log('item error', c.article_id, String(e).slice(0, 160));
  }
}

// one-time separator: fires when the accumulated backlog is fully drained (no leftover, not quota-stopped)
const leftover = ordered.length - work.length;
if (!quota && leftover <= 0 && !flags.backlogDone && Object.keys(store).length > 0) {
  await tgApi('sendMessage', { chat_id: CHAT_ID, parse_mode: 'HTML', text: '✅ <b>انتهى إرسال الأخبار المتراكمة (آخر 48 ساعة).</b>\n\nمن الآن ستصلك الأخبار الجديدة فقط فور ورودها.' });
  flags.backlogDone = true;
  console.log('backlog catch-up separator sent');
}
pruneByTs(seen, SEEN_KEEP);
pruneByTs(store, STORE_KEEP);
saveJson(SEEN, seen);
saveJson(STORE, store);
saveJson(FLAGS, flags);
console.log(`DONE sent=${sent} dups=${dups} sports=${sports} invalid=${invalid} quotaStop=${quota} | seen=${Object.keys(seen).length} store=${Object.keys(store).length}`);
