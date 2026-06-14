// Poll Telegram for "full text" button taps and reply with the full article (translated to Arabic if English).
import { gemini, tgApi, esc, fmtDate, chunkText, loadJson, saveJson, sleep, QuotaError } from './bot.mjs';
import { fetchText, extractBody } from './lib.mjs';

const STORE = 'data/articles.json', OFFSET = 'data/offset.json';
const store = loadJson(STORE, {});
const st = loadJson(OFFSET, { offset: 0 });

// ensure polling works (n8n had set a webhook; webhook + getUpdates are mutually exclusive)
await tgApi('deleteWebhook', { drop_pending_updates: false });

const upd = await tgApi('getUpdates', { offset: st.offset, timeout: 0, allowed_updates: ['callback_query'] });
let handled = 0;
if (upd && upd.ok) {
  for (const u of upd.result) {
    st.offset = u.update_id + 1;
    const cq = u.callback_query; if (!cq) continue;
    const id = String(cq.data || '').trim();
    const chat = (cq.message && cq.message.chat && cq.message.chat.id) || (cq.from && cq.from.id);
    await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: 'جارٍ إحضار النص الكامل…' });
    const a = store[id];
    if (!a) { await tgApi('sendMessage', { chat_id: chat, text: 'تعذّر إيجاد هذا الخبر (قد يكون قديماً). افتح الرابط من الصحيفة.' }); handled++; continue; }
    let text = a.full_text || '';
    if (!text && a.url) { const r = await fetchText(a.url, { timeout: 25000, retries: 1 }); text = extractBody(r.body, a.url); } // news: re-fetch full article on demand
    if (a.lang === 'en' && text) {
      try { const tr = await gemini(`Translate the following Qatari newspaper article fully into clear Modern Standard Arabic. Output ONLY the Arabic translation, no preamble:\n\n${text}`, { maxTokens: 8192 }); if (tr) text = tr; }
      catch (e) { /* quota/etc: fall back to original text */ }
    }
    const header = `📰 <b>${esc(a.newspaper)}</b>  •  🗓 ${fmtDate(a.pub_date)}\n\n<b>${esc(a.title_ar)}</b>\n\n`;
    const parts = chunkText(text, 3500);
    for (let i = 0; i < parts.length; i++) {
      await tgApi('sendMessage', { chat_id: chat, text: (i === 0 ? header : '') + esc(parts[i]), parse_mode: 'HTML', disable_web_page_preview: true });
      await sleep(350);
    }
    handled++;
  }
}
saveJson(OFFSET, st);
console.log(`callback done: handled=${handled} offset=${st.offset}`);
