// Unit tests for GEM (Job Offer Coach) — pure backend functions.
// Requiring ../server.js does NOT start the HTTP server and does NOT
// touch the real data directory (module-export mode only reads nothing
// from disk on load; all heavy init happens under the else-branch).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const s = require('../server.js');

// ---- extractMetryka ----
test('extractMetryka: standard one-line block', () => {
  const r = s.extractMetryka('SOMETHING\nMETRYKA: Szanse na interview: 60% | Szanse na zatrudnienie: 35% | Dopasowanie do roli: 90% | Poziom satysfakcji ze stanowiska: 72% | Porównanie wynagrodzenia: 80% | Rekomendacja czy aplikować: 90%');
  assert.ok(r);
  assert.deepStrictEqual(r.metrics, { interview: 60, employment: 35, role: 90, satisfaction: 72, salary: 80, recommend: 90 });
});

test('extractMetryka: bare METRYKA heading with values below (regression: eleQtron)', () => {
  const r = s.extractMetryka('# Wynik\n\nMETRYKA\n\nMETRYKA: Szanse na interview: 60% | Szanse na zatrudnienie: 35% | Dopasowanie do roli: 90% | Poziom satysfakcji ze stanowiska: 72% | Porównanie wynagrodzenia: 80% | Rekomendacja czy aplikować: 90%\n');
  assert.ok(r);
  assert.strictEqual(r.metrics.interview, 60);
  assert.strictEqual(r.metrics.recommend, 90);
});

test('extractMetryka: pipe fallback uses values in order', () => {
  const r = s.extractMetryka('METRYKA: 10% | 20% | 30% | 40% | 50% | 99%');
  assert.ok(r);
  assert.strictEqual(r.metrics.recommend, 99);
  assert.strictEqual(r.metrics.interview, 10);
});

test('extractMetryka: no percentages -> null', () => {
  assert.strictEqual(s.extractMetryka('METRYKA: nic tu nie ma'), null);
  assert.strictEqual(s.extractMetryka('no metrics at all'), null);
});

test('extractMetryka: out-of-range values rejected', () => {
  // 150% is dropped by the range guard; pipe fallback then has only 5 valid
  // values (< 6 needed) -> the block yields nothing.
  assert.strictEqual(s.extractMetryka('METRYKA: interview 150% | 20% | 30% | 40% | 50% | 60%'), null);
});

// ---- parseOfferFile ----
const DESC = 'We are looking for an engineer with strong background in embedded systems and AI integration. Long enough description for the parser to accept this offer entry.';

test('parseOfferFile: plain text format (title/company/location/url --- description)', () => {
  const text = `Senior Embedded Engineer\neleQtron\nHamburg\nhttps://example.com/1\n---\n${DESC}`;
  const offers = s.parseOfferFile(text);
  assert.strictEqual(offers.length, 1);
  assert.strictEqual(offers[0].company, 'eleQtron');
  assert.strictEqual(offers[0].title, 'Senior Embedded Engineer');
  assert.strictEqual(offers[0].url, 'https://example.com/1');
});

test('parseOfferFile: LinkedIn CSV export', () => {
  const text = `jobId,title,company,location,workplaceType,url,status,savedAt,descriptionText\n1,Embedded Engineer,eleQtron,Hamburg,Remote,https://example.com/1,apply,2026-01-01,"${DESC}"`;
  const offers = s.parseOfferFile(text);
  assert.strictEqual(offers.length, 1);
  assert.strictEqual(offers[0].status, 'apply');
});

test('parseOfferFile: LinkedIn JSON export ({saved:[...]})', () => {
  const text = JSON.stringify({ saved: [{ title: 'Eng', company: 'ACME', location: 'Berlin', descriptionText: DESC, status: 'applied' }] });
  const offers = s.parseOfferFile(text);
  assert.strictEqual(offers.length, 1);
  assert.strictEqual(offers[0].company, 'ACME');
  assert.strictEqual(offers[0].status, 'applied');
});

test('parseOfferFile: description too short -> dropped', () => {
  const text = `Senior Embedded Engineer\neleQtron\nHamburg\nhttps://example.com/1\n---\ntoo short`;
  assert.strictEqual(s.parseOfferFile(text).length, 0);
});

// ---- bulkOfferTitle ----
test('bulkOfferTitle: company - title', () => {
  assert.strictEqual(s.bulkOfferTitle({ company: 'ACME', title: 'Dev' }), 'ACME - Dev');
});

test('bulkOfferTitle: capped at 80 chars', () => {
  const t = s.bulkOfferTitle({ company: 'X'.repeat(50), title: 'Y'.repeat(50) });
  assert.ok(t.length <= 80);
});

// ---- offer similarity / duplicates ----
test('offerSimilarity: identical texts -> 1, disjoint -> 0', () => {
  const a = s.offerTokens('quantum embedded engineer hamburg');
  const b = s.offerTokens('quantum embedded engineer hamburg');
  assert.strictEqual(s.offerSimilarity(a, b), 1);
  const c = s.offerTokens('chef restaurant pizza italy');
  assert.strictEqual(s.offerSimilarity(a, c), 0);
});

test('offerSimilarity: empty sets -> 0', () => {
  assert.strictEqual(s.offerSimilarity(new Set(), s.offerTokens('abc def')), 0);
});

// ---- deriveOfferMeta ----
test('deriveOfferMeta: bulk layout (title/company/location/url/---)', () => {
  const meta = s.deriveOfferMeta([{ role: 'user', content: `Embedded Engineer\neleQtron\nHamburg\nhttps://example.com/1\n---\n${DESC}` }]);
  assert.strictEqual(meta.company, 'eleQtron');
  assert.strictEqual(meta.jobTitle, 'Embedded Engineer');
  assert.strictEqual(meta.location, 'Hamburg');
  assert.strictEqual(meta.url, 'https://example.com/1');
});

// ---- normalizeTagsInput ----
test('normalizeTagsInput: valid patch', () => {
  const p = s.normalizeTagsInput({ matchPct: 65, status: 'applied', german: 'required' });
  assert.deepStrictEqual(p, { matchPct: 65, status: 'applied', german: 'required' });
});

test('normalizeTagsInput: invalid status -> null', () => {
  assert.strictEqual(s.normalizeTagsInput({ status: 'whatever' }), null);
});

test('normalizeTagsInput: legacy booleans', () => {
  const p = s.normalizeTagsInput({ applied: true, notApplying: false });
  assert.strictEqual(p.status, 'applied');
});

test('normalizeTagsInput: empty object -> empty patch (no-op)', () => {
  assert.deepStrictEqual(s.normalizeTagsInput({}), {});
});

// ---- job search: html -> text ----
test('offerHtmlToText: strips tags, keeps breaks, decodes entities', () => {
  const t = s.offerHtmlToText('<p>Hello&nbsp;<b>World</b></p><ul><li>One</li><li>Two</li></ul><script>x</script>');
  assert.ok(t.includes('Hello World'));
  assert.ok(t.includes('One'));
  assert.ok(t.includes('Two'));
  assert.ok(!t.includes('script'));
  assert.ok(!t.includes('<'));
});

test('offerHtmlToText: decodes entity-escaped HTML (themus/arbeitnow feeds)', () => {
  const t = s.offerHtmlToText('&lt;div&gt;&lt;p&gt;About us&lt;/p&gt;&lt;p&gt;Senior &amp;amp; Lead&lt;/p&gt;&lt;/div&gt;');
  assert.ok(t.includes('About us'));
  assert.ok(t.includes('Senior & Lead'), 'double-encoded entity decoded: ' + t);
  assert.ok(!t.includes('<') && !t.includes('&lt;'));
});

// ---- job search: source normalizers ----
test('normalizeArbeitnow: maps remote flag and drops short descriptions', () => {
  const out = s.normalizeArbeitnow({ data: [
    { title: 'Dev', company_name: 'ACME', location: 'Hamburg', remote: false, url: 'https://a/1', description: 'x'.repeat(150) },
    { title: 'Too Short', company_name: 'X', location: 'Y', remote: true, url: 'https://a/2', description: 'short' }
  ] });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].workplace, 'onsite');
  assert.strictEqual(out[0].source, 'arbeitnow');
});

test('normalizeRemotive: prefers apply_url, remote workplace', () => {
  const out = s.normalizeRemotive({ jobs: [{ title: 'Lead', company_name: 'ACME', url: 'https://r/1', apply_url: 'https://r/apply', description: 'y'.repeat(150) }] });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].applyUrl, 'https://r/apply');
  assert.strictEqual(out[0].workplace, 'remote');
});

test('normalizeThemuse: detects remote from location list', () => {
  const out = s.normalizeThemuse({ results: [{ name: 'Eng', company: { name: 'ACME' }, locations: [{ name: 'Remote' }], contents: '<p>' + 'z'.repeat(150) + '</p>', refs: { landing_page: 'https://t/1' } }] });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].workplace, 'remote');
});

test('normalizeWwrRss: splits "Company: Title", parses items', () => {
  const xml = '<rss><channel><item><title>ACME: Senior Dev</title><link>https://w/1</link><description><![CDATA[<p>' + 'q'.repeat(150) + '</p>]]></description></item></channel></rss>';
  const out = s.normalizeWwrRss(xml);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].company, 'ACME');
  assert.strictEqual(out[0].title, 'Senior Dev');
});

// ---- job search: prefilter + prompt + AI reply ----
const JP = (t, d, wp, loc) => ({ title: t, description: d, workplace: wp, location: loc, company: 'C', source: 's' });
test('jobPrefilter: keyword hit in title ranks first', () => {
  const pool = [
    JP('Team Lead Software', 'AI products and coaching engineers', 'remote', 'Europe'),
    JP('Senior AI Engineer', 'build llm systems and lead', 'remote', 'Europe')
  ];
  const kept = s.jobPrefilter(pool, { keywords: 'team lead software', workplace: ['remote', 'onsite', 'hybrid'] });
  assert.strictEqual(kept.length, 2);
  assert.strictEqual(kept[0].title, 'Team Lead Software', 'title hit outranks description-only hit');
});

test('jobPrefilter: drops offers with zero keyword relevance', () => {
  const pool = [JP('Chef', 'cooking italian food', 'onsite', 'Rome'), JP('AI Dev', 'build llm systems', 'remote', 'Europe')];
  const kept = s.jobPrefilter(pool, { keywords: 'quantum', workplace: ['remote', 'onsite', 'hybrid'] });
  assert.strictEqual(kept.length, 0, 'irrelevant offers are dropped so the AI does not drown in noise');
});

test('jobPrefilter: workplace filter excludes onsite when only remote wanted', () => {
  const pool = [JP('AI Engineer', 'build llm systems', 'onsite', 'Berlin'), JP('AI Dev', 'build llm systems', 'remote', 'Europe')];
  const kept = s.jobPrefilter(pool, { keywords: 'ai', workplace: ['remote'] });
  assert.strictEqual(kept.length, 1, 'workplace remains a hard filter');
  assert.strictEqual(kept[0].workplace, 'remote');
});

test('jobPrefilter: keeps all workplaces when keyword unmatched', () => {
  const pool = [JP('AI Chef', 'cooking with ai food', 'onsite', 'Rome'), JP('AI Dev', 'build llm systems', 'remote', 'Europe')];
  const kept = s.jobPrefilter(pool, { keywords: 'ai', workplace: ['remote', 'onsite', 'hybrid'] });
  assert.strictEqual(kept.length, 2, 'both match the keyword, so both survive');
});

test('jobPrefilter: free-text location with workplace words ranks matching offers first', () => {
  const pool = [
    JP('Rola A', 'desc a', 'onsite', 'Rome'),
    JP('Rola B', 'desc b', 'onsite', 'Hamburg'),
    JP('Rola C', 'desc c', 'remote', 'EU')
  ];
  const kept = s.jobPrefilter(pool, { keywords: '', location: 'Hamburg onsite, Poznan onsite, EU remotely', workplace: ['remote', 'onsite', 'hybrid'] });
  assert.strictEqual(kept[0].location, 'Hamburg', 'Hamburg offer ranks first');
});

test('jobAiPrompt: carries criteria and numbered offers', () => {
  const p = s.jobAiPrompt({ keywords: 'ai lead', location: 'Hamburg onsite, EU remotely', workplace: ['onsite'], languages: 'english only' }, [JP('X', 'desc', 'onsite', 'Hamburg')]);
  assert.ok(p.includes('english only'));
  assert.ok(p.includes('Hamburg onsite, EU remotely'), 'location field is verbatim in the prompt');
  assert.ok(p.includes('1. X'));
});

test('parseJobAiReply: extracts matches, ignores out-of-range ids and junk', () => {
  const r = s.parseJobAiReply('{"matches":[{"id":1,"language":"English","reason":"good fit"},{"id":99,"language":"x","reason":"ghost"}]}', 2);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].id, 1);
  assert.strictEqual(r[0].language, 'English');
});

test('parseJobAiReply: malformed -> empty (no crash)', () => {
  assert.deepStrictEqual(s.parseJobAiReply('no json here', 3), []);
  assert.deepStrictEqual(s.parseJobAiReply('{broken', 3), []);
});

test('JOB_SOURCES: sample source exists and needs no network', () => {
  const sample = s.JOB_SOURCES.find((x) => x.id === 'sample');
  assert.ok(sample);
  assert.strictEqual(s.normalizeJobSample().length, 8);
});

// ---- job search: XING / Stepstone / NoFluffJobs (JSON-LD JobPosting) ----
test('parseJsonLdJobPostings: extracts JobPosting from flat and @graph forms', () => {
  const flat = '<script type="application/ld+json">' + JSON.stringify({ '@type': 'JobPosting', title: 'Flat' }) + '</script>';
  const graph = '<script type="application/ld+json">' + JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'Organization' }, { '@type': 'JobPosting', title: 'Graph' }] }) + '</script>';
  assert.strictEqual(s.parseJsonLdJobPostings(flat).length, 1);
  const g = s.parseJsonLdJobPostings(graph);
  assert.strictEqual(g.length, 1);
  assert.strictEqual(g[0].title, 'Graph');
});

test('parseJsonLdJobPostings: malformed JSON is skipped, not fatal', () => {
  const html = '<script type="application/ld+json">{broken</script><script type="application/ld+json">' + JSON.stringify({ '@type': 'JobPosting', title: 'OK' }) + '</script>';
  const r = s.parseJsonLdJobPostings(html);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].title, 'OK');
});

test('jsonLdLocation / jsonLdSalary: address and range formatting', () => {
  const loc = s.jsonLdLocation({ jobLocation: { address: { addressLocality: 'Hamburg', addressRegion: 'HH', addressCountry: 'DE' } } });
  assert.strictEqual(loc, 'Hamburg, HH, DE');
  const sal = s.jsonLdSalary({ baseSalary: { currency: 'PLN', value: { minValue: 15000, maxValue: 25000, unitText: 'MONTH' } } });
  assert.match(sal, /15000-25000 PLN/);
});

test('normalizeJsonLdOffer: maps JobPosting and drops short descriptions', () => {
  const base = {
    '@type': 'JobPosting', title: 'Lead Software Developer', datePosted: '2026-09-29',
    hiringOrganization: { '@type': 'Organization', name: 'SIGNAL IDUNA' },
    jobLocation: { address: { addressLocality: 'Hamburg', addressCountry: 'DE' } },
    description: 'x'.repeat(150), url: 'https://www.stepstone.de/x.html'
  };
  const o = s.normalizeJsonLdOffer(base, 'stepstone', 'https://fallback');
  assert.strictEqual(o.company, 'SIGNAL IDUNA');
  assert.strictEqual(o.source, 'stepstone');
  assert.strictEqual(o.location, 'Hamburg, DE');
  assert.strictEqual(o.workplace, 'onsite');
  assert.strictEqual(s.normalizeJsonLdOffer({ ...base, description: 'short' }, 'x', 'u'), null);
});

test('normalizeJsonLdOffer: remote detection from title/description', () => {
  const jp = {
    '@type': 'JobPosting', title: 'Senior Developer (Remote)', description: 'y'.repeat(150),
    hiringOrganization: { name: 'ACME' }, jobLocation: { address: { addressLocality: 'Kraków', addressCountry: 'PL' } }
  };
  assert.strictEqual(s.normalizeJsonLdOffer(jp, 'nofluffjobs', 'u').workplace, 'remote');
});

test('JOB_SOURCES: XING, Stepstone, NoFluffJobs, pracuj are wired as html sources', () => {
  for (const id of ['xing', 'stepstone', 'nofluffjobs', 'pracuj']) {
    const src = s.JOB_SOURCES.find((x) => x.id === id);
    assert.ok(src, id + ' source present');
    assert.strictEqual(src.kind, 'html', id + ' is an html source');
    assert.ok(src.linkRe && src.listing, id + ' has linkRe + listing');
  }
});
