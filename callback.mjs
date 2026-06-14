// Long-poll Telegram for "full text" button taps and reply with the full article (translated to Arabic if English).
// Runs for a bounded window (~4.5 min) handling taps in real time, then exits; scheduled every 5 min for near-continuous coverage.
import { gemini, tgApi, esc, fmtDate, chunkText, loadJson, saveJson, sleep } from './bot.mjs';
import { fetchText, extractBody } from './lib.mjs';

const STORE = 'data/articles.json', OFFSET = 'data/offset.json';
const store = loadJson(STORE, {});
const st = loadJson(OFFSET, { offset: 0 });
const RUN_MS = Number(process.env.CALLBACK_RUN_MS || 270000); // ~4.5 min listening window per scheduled run
const startedAt = Date.now();

// webhook + getUpdates are mutually exclusive — ensure polling works
await tgApi('deleteWebhook', { drop_pending_updates: false });

async function handleTap(cq) {
  const id = String(cq.data || '').trim();
  const chat = (cq.message && cq.message.chat && cq.message.chat.id) || (cq.from && cq.from.id);
  await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: 'جارٍ إحضار النص الكامل…' });
  const a = store[id];
  if (!a) { await tgApi('sendMessage', { chat_id: chat, text: 'تعذّر إيجاد هذا الخبر (قد يكون قديماً). افتح الرابط من الصحيفة.' }); return; }
  let text = a.full_text || '';
  if (!text && a.url) { // fallback for older/pruned entries that lack stored text
    try { const r = await fetchText(a.url, { timeout: 25000, retries: 1 }); text = extractBody(r.body, a.url) || ''; } catch { /* leave empty -> placeholder */ }
  }
  if (a.lang === 'en' && text) {
    try { const tr = await gemini(`Translate the following Qatari newspaper article fully into clear Modern Standard Arabic. Output ONLY the Arabic translation, no preamble:\n\n${text}`, { maxTokens: 8192 }); if (tr) text = tr; }
    catch { /* quota/etc: fall back to original text */ }
  }
  const header = `📰 <b>${esc(a.newspaper)}</b>  •  🗓 ${fmtDate(a.pub_date)}\n\n<b>${esc(a.title_ar)}</b>\n\n`;
  const parts = chunkText(text, 3500);
  for (let i = 0; i < parts.length; i++) {
    await tgApi('sendMessage', { chat_id: chat, text: (i === 0 ? header : '') + esc(parts[i]), parse_mode: 'HTML', disable_web_page_preview: true });
    await sleep(350);
  }
}

let handled = 0;
while (Date.now() - startedAt < RUN_MS) {
  let upd;
  try { upd = await tgApi('getUpdates', { offset: st.offset, timeout: 25, allowed_updates: ['callback_query'] }); }
  catch { await sleep(2000); continue; }
  if (!upd || !upd.ok || !Array.isArray(upd.result)) { await sleep(1500); continue; }
  for (const u of upd.result) {
    st.offset = u.update_id + 1;               // advance cursor first so a failing tap is never retried forever
    if (!u.callback_query) continue;
    try { await handleTap(u.callback_query); handled++; }
    catch (e) { console.log('tap error', String(e).slice(0, 160)); } // one bad tap must not drop the others
  }
  saveJson(OFFSET, st); // persist progress within the run
}
saveJson(OFFSET, st);
console.log(`callback window done: handled=${handled} offset=${st.offset}`);
