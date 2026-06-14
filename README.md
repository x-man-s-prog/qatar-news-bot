# Qatar News → Telegram (GitHub Actions)

نظام سحابي دائم: يراقب صحف قطر، يلخّص/يترجم للعربية عبر Gemini، ويرسل لتيلجرام مع زرّ «النص الكامل». بلا رياضة، بلا وظائف، بلا تكرار بين الصحف، ويشمل الجريدة الرسمية (الميزان).

Cloud, permanent digest of every Qatar newspaper → Arabic summaries on Telegram, with a "full text on demand" button. Sports + jobs excluded, cross‑source de‑duplication, plus the Official Gazette.

## How it runs
- **`news.yml`** — every 6 hours: gathers all papers + gazette → filters (sports/jobs) → de‑dups across papers → summarizes/translates to Arabic (Gemini) → sends to Telegram. **No per‑run cap**; fair round‑robin across papers; **stops cleanly if it hits Gemini's free daily limit and resumes next run.**
- **`bot.yml`** — every 5 minutes: answers «📄 النص الكامل» taps with the full article (translated to Arabic if the source was English).
- State (seen items, fingerprints, article store, poll offset) lives in `data/*.json`, committed back by the Actions.

## One‑time setup
1. **Create a GitHub repo** and push these files. **Make it public** → unlimited free Actions minutes (the code contains **no secrets**; tokens live only in GitHub Secrets). A private repo also works but the 5‑min poller will use your 2,000 free minutes/month.
2. **Add repository Secrets** (Settings → Secrets and variables → Actions → *New repository secret*):
   - `TELEGRAM_BOT_TOKEN` — your @Qtr974newsbot token from BotFather.
   - `TELEGRAM_CHAT_ID` — `915765345` (your Telegram user id).
   - `GEMINI_API_KEY` — your free key from https://aistudio.google.com/apikey
   - *(optional)* repo **Variable** `GEMINI_MODEL` (default `gemini-2.5-flash`; use `gemini-2.5-flash-lite` for a larger free daily quota).
3. **Actions tab → enable workflows** → run **“Qatar News Digest”** once via *Run workflow* to test. Then it's automatic.
4. Open **@Qtr974newsbot** and press **Start** (so the bot can message you).

## Tuning
- **Cadence:** edit the `cron` in `.github/workflows/news.yml`.
- **De‑dup strictness:** repo Variable `DEDUP_THRESHOLD` (default `0.5`; higher = fewer merges).
- **Gemini pacing:** `PACE_MS` (default `4200` ms between calls, ~14/min to respect the free rate limit).

## Notes
- **لوسيل (Lusail)** is behind Cloudflare and may intermittently block server fetches (best‑effort).
- The first run sends a catch‑up of the last ~48h, fairly across papers, draining over a few runs (and across days if the free Gemini quota is reached).
