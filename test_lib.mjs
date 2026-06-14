// Local verification (no secrets): coverage per paper + extraction quality + dedup.
import { buildSources, GAZETTE_SOURCE, fetchText, parseSource, toCandidates, extractBody, makeSig, jaccard } from './lib.mjs';

const sources = buildSources();
console.log('Sources:', sources.length, '+ gazette');

// 1) coverage: candidates per newspaper
const all = [];
for (const src of sources) {
  const r = await fetchText(src.url, { timeout: 25000, retries: 1 });
  const raw = parseSource(src, r.body);
  const cand = toCandidates(src, raw);
  all.push(...cand);
  console.log(`  ${src.newspaper} [${src.type}] http=${r.status} raw=${raw.length} kept=${cand.length}`);
}
const byPaper = {};
for (const c of all) byPaper[c.newspaper] = (byPaper[c.newspaper] || 0) + 1;
console.log('\nCandidates per newspaper (48h, sport+jobs excluded):', JSON.stringify(byPaper));
console.log('TOTAL candidates:', all.length);

// gazette
const g = await fetchText(GAZETTE_SOURCE.url, { timeout: 45000, retries: 1 });
const gz = parseSource(GAZETTE_SOURCE, g.body);
console.log('\nGazette (al-meezan via jina) http=' + g.status + ' laws found=' + gz.length);
for (const x of gz.slice(0, 3)) console.log('   •', x.title.slice(0, 90));

// 2) extraction quality: one article per Arabic + English source
console.log('\n=== EXTRACTION (Readability) sample ===');
const picks = [];
for (const paper of ['الشرق','العرب','الراية','الوطن','لوسيل','Gulf Times','The Peninsula','Qatar Tribune']) {
  const c = all.find(x => x.newspaper === paper); if (c) picks.push(c);
}
for (const c of picks) {
  const r = await fetchText(c.url, { timeout: 25000, retries: 1 });
  const body = extractBody(r.body, c.url);
  console.log(`\n--- ${c.newspaper} | http=${r.status} | extracted=${body.length} chars`);
  console.log('   HEAD:', body.slice(0, 180).replace(/\n/g, ' '));
}

// 3) dedup sanity
console.log('\n=== DEDUP ===');
const p = [
  ['SAME', 'دولة قطر توقع عقد جناحها المشارك في إكسبو 2027', 'قطر توقع عقد تنفيذ جناحها في إكسبو 2027 يوكوهاما'],
  ['DIFF', 'السويد تعلن اعتراض طائرتين روسيتين فوق البلطيق', 'إخلاء مركز للجيش اللبناني في النبطية'],
];
for (const [lbl, a, b] of p) console.log('  ', jaccard(makeSig(a), makeSig(b)).toFixed(2), lbl);
