// Cartesia text-to-speech: turns an Arabic ad script into an audio file.
//   node tts.mjs --list-voices              # Arabic voices available to your key
//   node tts.mjs --list-voices --all        # every voice, not just Arabic ones
//   node tts.mjs --accents                  # accent catalog (no Gulf entry exists)
//   node tts.mjs --clone --clip me.mp3 --name "Khaliji F"   # clone a Gulf voice
//   node tts.mjs --voice <voice-id>         # generate ads/employee-rights.ar.txt
//   node tts.mjs --voice <id> --in ads/x.txt --out out/x.mp3 --speed 1.05
// Needs CARTESIA_API_KEY in the environment. Node 18+ (uses global fetch).

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

const API = process.env.CARTESIA_BASE_URL || 'https://api.cartesia.ai';
const VERSION = '2026-08-14';

const KEY = process.env.CARTESIA_API_KEY;
const MODEL = process.env.CARTESIA_MODEL || 'sonic-3.5';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

function headers(extra = {}) {
  return { Authorization: `Bearer ${KEY}`, 'Cartesia-Version': VERSION, ...extra };
}

async function fail(res) {
  const body = await res.text().catch(() => '');
  const hint =
    res.status === 401 ? ' (bad or revoked CARTESIA_API_KEY)'
    : res.status === 402 ? ' (out of credits)'
    : res.status === 429 ? ' (rate limited — wait and retry)'
    : '';
  throw new Error(`Cartesia ${res.status}${hint}: ${body.slice(0, 400)}`);
}

// The /voices list is cursor-paginated; walk it so language filtering sees them all.
async function allVoices() {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 40; page++) {
    const url = new URL('/voices', API);
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('starting_after', cursor);
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) await fail(res);
    const json = await res.json();
    const batch = json.data || [];
    out.push(...batch);
    if (!json.has_more || !batch.length) break;
    cursor = batch[batch.length - 1].id;
  }
  return out;
}

async function listVoices() {
  const wantAll = arg('all') === true;
  const lang = arg('lang', 'ar');
  const voices = await allVoices();
  // A voice is usable for Arabic if it is native Arabic or carries an ar locale.
  const usable = wantAll
    ? voices
    : voices.filter(
        (v) => v.language === lang || (v.locales || []).some((l) => String(l.locale || l).startsWith(lang)),
      );
  if (!usable.length) {
    console.log(`No ${wantAll ? '' : `"${lang}" `}voices on this account. Try --all.`);
    return;
  }
  for (const v of usable) {
    const gender = v.gender || v.gender_presentation || '—';
    // "native" matters: a cross-lingual voice speaking Arabic carries its own accent.
    const native = v.language === lang ? 'native' : 'cross-lingual';
    const locales = (v.locales || []).map((l) => l.locale || l).join(',') || '—';
    console.log(`${v.id}\t${v.language}\t${gender}\t${native}\t${locales}\t${v.name}`);
  }
  console.log(`\n${usable.length} voice(s). Columns: id, language, gender, nativeness, locales, name.`);
  console.log('Prefer "native" for Arabic; cross-lingual voices speak it with a foreign accent.');
}

async function listAccents() {
  const res = await fetch(`${API}/accents`, { headers: headers() });
  if (!res.ok) await fail(res);
  const json = await res.json();
  const accents = json.data || json.accents || json;
  const arabic = (Array.isArray(accents) ? accents : []).filter((a) =>
    String(a.id || a).toLowerCase().includes('arab'),
  );
  console.log(JSON.stringify(arabic.length ? arabic : accents, null, 2));
}

// Cloning is the only route to a Gulf accent — the catalog has no Khaliji entry.
// Only clone a voice you own or have the speaker's permission to use.
async function cloneVoice() {
  const clip = arg('clip');
  const name = arg('name');
  if (!clip || clip === true) throw new Error('Missing --clip <audio file> (10-20s of clean speech)');
  if (!name || name === true) throw new Error('Missing --name "<voice name>"');

  const form = new FormData();
  form.append('clip', new Blob([await readFile(clip)]), basename(clip));
  form.append('name', name);
  form.append('language', arg('lang', 'ar'));
  const accent = arg('accent');
  if (accent && accent !== true) form.append('accent', accent);
  const description = arg('description');
  if (description && description !== true) form.append('description', description);

  const res = await fetch(`${API}/voices/clone`, { method: 'POST', headers: headers(), body: form });
  if (!res.ok) await fail(res);
  const voice = await res.json();
  console.log(`Cloned voice ${voice.id} (${voice.name})`);
  console.log(`Use it: node tts.mjs --voice ${voice.id} --in ads/marasim.plain.ar.txt`);
}

async function generate() {
  const voice = arg('voice');
  if (!voice || voice === true) {
    throw new Error('Missing --voice <id>. Run: node tts.mjs --list-voices');
  }

  const inPath = arg('in', 'ads/employee-rights.ar.txt');
  const outPath = arg('out', 'out/employee-rights.mp3');
  const transcript = (await readFile(inPath, 'utf8')).trim();
  if (!transcript) throw new Error(`${inPath} is empty`);

  const generation_config = {};
  const speed = Number(arg('speed', ''));
  if (Number.isFinite(speed) && speed) generation_config.speed = speed; // 0.6–1.5
  const emotion = arg('emotion');
  if (emotion && emotion !== true) generation_config.emotion = emotion;

  const body = {
    model_id: MODEL,
    transcript,
    voice: { id: voice },
    output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 128000 },
    ...(Object.keys(generation_config).length ? { generation_config } : {}),
  };

  // The API accepts `language` or `locale`, never both. A locale like ar-SA lets
  // you ask for a regional reading instead of the generic Arabic default.
  const locale = arg('locale');
  if (locale && locale !== true) body.locale = locale;
  else body.language = arg('lang', 'ar');

  const normalization = arg('normalization');
  if (normalization && normalization !== true) body.normalization = normalization;

  console.log(`Generating ${transcript.length} chars with ${MODEL} / voice ${voice}…`);
  const res = await fetch(`${API}/tts/bytes`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) await fail(res);

  const audio = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, audio);
  console.log(`Wrote ${outPath} (${(audio.length / 1024).toFixed(0)} KB)`);
}

if (!KEY) {
  console.error('Set CARTESIA_API_KEY first:  export CARTESIA_API_KEY=sk_car_...');
  process.exit(1);
}

try {
  if (arg('list-voices')) await listVoices();
  else if (arg('accents')) await listAccents();
  else if (arg('clone')) await cloneVoice();
  else await generate();
} catch (e) {
  console.error(String(e.message || e));
  process.exit(1);
}
