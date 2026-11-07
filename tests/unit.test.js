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

// ---- expired tag ----
test('normalizeTagsInput: expired boolean (optional tag)', () => {
  assert.deepStrictEqual(s.normalizeTagsInput({ expired: true }), { expired: true });
  assert.deepStrictEqual(s.normalizeTagsInput({ expired: false }), { expired: false });
  assert.deepStrictEqual(s.normalizeTagsInput({ expired: null }), { expired: false });
  assert.deepStrictEqual(s.normalizeTagsInput({ status: 'applied', expired: true }), { status: 'applied', expired: true });
  assert.deepStrictEqual(s.normalizeTagsInput({}), {}, 'no expired key -> not in the patch');
});

// ---- interview / rejected statuses ----
test('normalizeTagsInput: interview and rejected statuses are accepted', () => {
  assert.deepStrictEqual(s.normalizeTagsInput({ status: 'interview' }), { status: 'interview' });
  assert.deepStrictEqual(s.normalizeTagsInput({ status: 'rejected' }), { status: 'rejected' });
  assert.strictEqual(s.normalizeTagsInput({ status: 'nope' }), null, 'unknown values still rejected');
});

test('analyzeConversationTags: interview and rejected detection', () => {
  const mk = (texts) => ({ messages: texts.map((content) => ({ role: 'assistant', content })) });
  assert.strictEqual(s.analyzeConversationTags(mk(['Odezwali się — zaproszenie na rozmowę kwalifikacyjną w przyszłym tygodniu.'])).status, 'interview');
  assert.strictEqual(s.analyzeConversationTags(mk(['Great news: we would like to move to the interview stage.'])).status, 'interview');
  assert.strictEqual(s.analyzeConversationTags(mk(['Wysłaliśmy aplikację, potem przyszła odpowiedź: niestety aplikacja została odrzucona.'])).status, 'rejected');
  assert.strictEqual(s.analyzeConversationTags(mk(['Thank you for applying. Unfortunately your application was rejected.'])).status, 'rejected');
  assert.strictEqual(s.analyzeConversationTags(mk(['Rejection email arrived this morning.'])).status, 'rejected');
  assert.strictEqual(s.analyzeConversationTags(mk(['Deadline is close, apply this week. Great offer.'])).status, null, 'no application statement');
  assert.strictEqual(s.analyzeConversationTags(mk(['Application has been sent today.'])).status, 'applied');
});

test('analyzeConversationTags: expired posting is detected conservatively', () => {
  const mk = (texts) => ({ messages: texts.map((content) => ({ role: 'assistant', content })) });
  assert.strictEqual(s.analyzeConversationTags(mk(['Metryka OK.\nOferta już wygasła, nie warto aplikować.'])).expired, true);
  assert.strictEqual(s.analyzeConversationTags(mk(['The recruiter replied: the position has been filled.'])).expired, true);
  assert.strictEqual(s.analyzeConversationTags(mk(['The posting is no longer available on the company portal.'])).expired, true);
  assert.strictEqual(s.analyzeConversationTags(mk(['Deadline is close, apply this week. Great offer.'])).expired, false, 'no explicit expiration -> false');
  assert.strictEqual(s.analyzeConversationTags(mk(['Metryka: interview 35%.'])).expired, false);
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
  for (const id of ['xing', 'stepstone', 'nofluffjobs', 'pracuj', 'rocketjobs']) {
    const src = s.JOB_SOURCES.find((x) => x.id === id);
    assert.ok(src, id + ' source present');
    assert.strictEqual(src.kind, 'html', id + ' is an html source');
    assert.ok(src.linkRe && src.listing, id + ' has linkRe + listing');
  }
});

// ---- job search: UAE / Gulf portals ----
test('JOB_SOURCES: gulfhire and linkedin are wired with custom fetchers', () => {
  for (const id of ['gulfhire', 'linkedin']) {
    const src = s.JOB_SOURCES.find((x) => x.id === id);
    assert.ok(src, id + ' source present');
    assert.strictEqual(typeof src.fetchOffers, 'function', id + ' has a custom fetcher');
  }
});

test('jobGulfCity / jobGulfCities: UAE cities in the free-text location', () => {
  assert.strictEqual(s.jobGulfCity('Dubai, Abu Dhabi, UAE').cc, 'AE');
  assert.strictEqual(s.jobGulfCity('Hamburg'), null);
  const all = s.jobGulfCities('Dubai, Abu Dhabi, Sharjah, UAE').map((c) => c.city);
  assert.deepStrictEqual(all, ['Abu Dhabi', 'Dubai', 'Sharjah']);
  assert.strictEqual(s.jobCityCountry('Dubai'), 'AE');
  assert.strictEqual(s.jobCityCountry('Doha'), 'QA');
});

test('jobShortDate: "13 Oct" becomes an ISO date', () => {
  assert.match(s.jobShortDate('13 Oct'), /^\d{4}-10-13$/);
  assert.strictEqual(s.jobShortDate('No closing date'), 'No closing date');
});

test('jobLinkedinLocation: maps a Gulf city to "City, Country"', () => {
  assert.strictEqual(s.jobLinkedinLocation('Dubai'), 'Dubai, United Arab Emirates');
  assert.strictEqual(s.jobLinkedinLocation('UAE'), 'United Arab Emirates');
  assert.strictEqual(s.jobLinkedinLocation('Hamburg'), 'Hamburg');
});

test('parseGulfhireListing: card -> offer (title, company, city/country, summary, date)', () => {
  const html = '<article class="jr"><div class="jr-main"><h2 class="jr-title"><a class="jr-link" href="/jobs/its-atms-software-engineer-dubai-qe2nk0"><span lang="en">ITS ATMS Software Engineer</span></a></h2>' +
    '<p class="jr-meta"><span class="jr-fact jr-company"><svg></svg><bdi>Parsons</bdi></span><span class="jr-fact"><svg></svg><span>Dubai</span></span></p>' +
    '<p class="jr-summary" lang="en">Parsons is hiring an ITS ATMS Software Engineer in Dubai to support the Resident Engineer in delivering software components for an Advanced Traffic Management System.</p>' +
    '</div><div class="jr-facts"><span class="jr-posted"><svg></svg><span class="num">13 Oct</span></span></div></article>';
  const offers = s.parseGulfhireListing(html, 'https://gulfhire.com');
  assert.strictEqual(offers.length, 1);
  assert.strictEqual(offers[0].title, 'ITS ATMS Software Engineer');
  assert.strictEqual(offers[0].company, 'Parsons');
  assert.strictEqual(offers[0].location, 'Dubai, United Arab Emirates');
  assert.strictEqual(offers[0].source, 'gulfhire');
  assert.strictEqual(offers[0].url, 'https://gulfhire.com/jobs/its-atms-software-engineer-dubai-qe2nk0');
  assert.match(offers[0].savedAt, /^\d{4}-10-13$/);
  assert.match(offers[0].description, /Advanced Traffic Management System/);
});

test('parseLinkedinGuestCards: guest search card -> offer', () => {
  const html = '<li><div class="base-card base-search-card job-search-card" data-entity-urn="urn:li:jobPosting:4362132219">' +
    '<a class="base-card__full-link" href="https://ae.linkedin.com/jobs/view/senior-software-engineer-backend-at-talabat-4362132219?position=1&amp;pageNum=0"><span class="sr-only">Senior Software Engineer- Backend</span></a>' +
    '<div class="base-search-card__info"><h3 class="base-search-card__title">Senior Software Engineer- Backend</h3>' +
    '<h4 class="base-search-card__subtitle"><a href="https://ae.linkedin.com/company/talabat-com">talabat</a></h4>' +
    '<div class="base-search-card__metadata"><span class="job-search-card__location">Dubai, Dubai, United Arab Emirates</span></div>' +
    '<time class="job-search-card__listdate" datetime="2026-10-13">1 week ago</time></div></div></li>';
  const jobs = s.parseLinkedinGuestCards(html);
  assert.strictEqual(jobs.length, 1);
  assert.strictEqual(jobs[0].title, 'Senior Software Engineer- Backend');
  assert.strictEqual(jobs[0].company, 'talabat');
  assert.strictEqual(jobs[0].location, 'Dubai, Dubai, United Arab Emirates');
  assert.strictEqual(jobs[0].id, '4362132219');
  assert.strictEqual(jobs[0].savedAt, '2026-10-13');
  assert.ok(!jobs[0].url.includes('?'), 'tracking query stripped');
});

// ---- RocketJobs (PL): listing ItemList -> detail JobPosting ----
// Regression setup: the listing page renders offer CARDS client-side, so the
// source must pull the offer URLs out of the embedded JSON-LD ItemList (not
// out of <a href> anchors).
const RJ_LISTING = [
  '<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"CollectionPage",',
  '"mainEntity":{ "@type":"ItemList", "itemListElement":[',
  '{"@type":"ListItem","position":1,"url":"https://rocketjobs.pl/oferta-pracy/power-media-embedded-developer-nrf-stm32-esp32--poznan-inzynieria-elektronika","name":"Embedded Developer (nRF / STM32 / ESP32)"},',
  '{"@type":"ListItem","position":2,"url":"https://rocketjobs.pl/oferta-pracy/power-media-senior-embedded-developer-nrf-stm32-esp32--poznan-inzynieria-elektronika","name":"Senior Embedded Developer (nRF / STM32 / ESP32)"},',
  '{"@type":"ListItem","position":3,"url":"https://other-portal.example/oferta-pracy/not-a-rocketjobs-link","name":"Foreign offer"}]}}</script></head>',
  '<body><div class="MuiBox-root">cards are client-rendered, no <a href="/oferta-pracy/..."> anchors here</div></body></html>'
].join('');
const RJ_DETAIL = (title, org, city) => '<html><head><script type="application/ld+json">{"@type":"JobPosting","title":"' + title +
  '","hiringOrganization":{"@type":"Organization","name":"' + org + '"},"datePosted":"2026-10-30T11:05:10Z",' +
  '"jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","addressCountry":"PL","addressLocality":"' + city + '"}},' +
  '"baseSalary":{"@type":"MonetaryAmount","currency":"PLN","value":{"@type":"QuantitativeValue","unitText":"HOUR","minValue":50,"maxValue":90}},' +
  '"description":"<p>Role: embedded real-time software in Poland. ' + 'Long description body for the plausibility gate. '.repeat(6) + '</p>"}</script></head><body></body></html>';

test('JOB_SOURCES: rocketjobs html source wired', () => {
  const src = s.JOB_SOURCES.find((x) => x.id === 'rocketjobs');
  assert.ok(src, 'rocketjobs source present');
  assert.strictEqual(src.kind, 'html');
  assert.ok(src.linkRe && src.listing, 'linkRe + listing present');
  const u = src.listing({ keywords: 'embedded', location: 'remote' }, 'embedded');
  assert.ok(u.includes('/oferty-pracy/praca-zdalna?'), 'pure remote location -> remote region');
  const u2 = src.listing({ keywords: 'embedded', location: 'Poznan' }, 'embedded');
  assert.ok(u2.includes('/oferty-pracy/wszystkie-lokalizacje?keyword=embedded'), 'city location -> all of Poland');
});

test('fetchRocketjobsOffers via html harness: ItemList urls -> detail JSON-LD offers', async () => {
  const src = s.JOB_SOURCES.find((x) => x.id === 'rocketjobs');
  const fetcher = src.fetchOffers || s.jobFetchHtmlSource;
  const calls = [];
  const offers = await fetcher(src, { keywords: 'embedded', location: 'Poznan' }, {
    getText: async (u) => {
      calls.push(u);
      if (u.includes('oferty-pracy')) return RJ_LISTING;
      throw new Error('unexpected detail for ' + u);
    },
    delay: 0
  });
  assert.strictEqual(offers.length, 0, 'stub has no detail pages, nothing crashes');
  assert.strictEqual(calls.filter((u) => u.includes('/oferta-pracy/')).length, 2, 'only rocketjobs ItemList urls fetched, foreign host ignored');
  assert.ok(calls.some((u) => u.includes('power-media-embedded-developer')));
  assert.strictEqual(calls.some((u) => u.includes('other-portal.example')), false);
  // Now with detail pages served for each slug -> full normalized offers.
  const pages = {
    'https://rocketjobs.pl/oferta-pracy/power-media-embedded-developer-nrf-stm32-esp32--poznan-inzynieria-elektronika': RJ_DETAIL('Embedded Developer (nRF / STM32 / ESP32)', 'Power Media', 'Poznan'),
    'https://rocketjobs.pl/oferta-pracy/power-media-senior-embedded-developer-nrf-stm32-esp32--poznan-inzynieria-elektronika': RJ_DETAIL('Senior Embedded Developer (nRF / STM32 / ESP32)', 'Power Media', 'Poznan')
  };
  const offers2 = await fetcher(src, { keywords: 'embedded', location: 'Poznan' }, {
    getText: async (u) => (u.includes('oferty-pracy') ? RJ_LISTING : (pages[u] || (() => { throw new Error('404 ' + u); })())),
    delay: 0
  });
  assert.strictEqual(offers2.length, 2);
  const o = offers2[0];
  assert.strictEqual(o.company, 'Power Media');
  assert.strictEqual(o.location, 'Poznan, PL');
  assert.ok(o.description.length >= 300, 'full description from JobPosting JSON-LD');
  assert.match(o.savedAt, /^2026-10-30/);
  assert.ok(o.url.includes('/oferta-pracy/'), 'offer url preserved');
});

// ---- remotely.de (DE/remote): sitemap slugs -> detail JobPosting JSON-LD ----
test('fetchRemotelyDeOffers: sitemap slug scoring picks keyword hits, details read job-posting-jsonld', async () => {
  const src = s.JOB_SOURCES.find((x) => x.id === 'remotelyde');
  assert.ok(src && typeof src.fetchOffers === 'function', 'remotelyde custom fetcher wired');
  const detail = (title, org, city) => '<html><head><script id="job-posting-jsonld" type="application/ld+json">' + JSON.stringify({
    '@type': 'JobPosting', title,
    description: '<p>Embedded work in ' + city + '. ' + 'Detail body padding for the length gate. '.repeat(10),
    datePosted: '2026-10-23T10:00:00.000+00:00',
    hiringOrganization: { '@type': 'Organization', name: org },
    url: 'https://www.remotely.de/job/' + org.toLowerCase(),
    jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: city, addressCountry: 'DE' } }
  }) + '</script></head><body></body></html>';
  const sitemap = [
    '<urlset>',
    '<url><loc>https://www.remotely.de/job/gamma-sales-manager-mwd</loc></url>',
    '<url><loc>https://www.remotely.de/job/beta-embedded-developer-mwd</loc></url>',
    '<url><loc>https://www.remotely.de/job/acme-embedded-software-engineer-mwd</loc></url>',
    '<url><loc>https://www.remotely.de/job/delta-embedded-fpga-mwd</loc></url>',
    '</urlset>'
  ].join('');
  const pages = {
    'https://www.remotely.de/job/gamma-sales-manager-mwd': detail('Sales Manager', 'Gamma Co', 'Hamburg'),
    'https://www.remotely.de/job/beta-embedded-developer-mwd': detail('Embedded Developer', 'Beta AG', 'Berlin'),
    'https://www.remotely.de/job/acme-embedded-software-engineer-mwd': detail('Embedded Software Engineer', 'Acme GmbH', 'Bremen'),
    'https://www.remotely.de/job/delta-embedded-fpga-mwd': detail('Embedded FPGA Developer', 'Delta SE', 'Berlin')
  };
  const fetches = [];
  const offers = await src.fetchOffers(src, { keywords: 'embedded engineer', location: 'remote' }, {
    getText: async (u) => { fetches.push(u); return (u.includes('sitemap') ? sitemap : pages[u] || (() => { throw new Error('404 ' + u); })()); },
    delay: 0
  });
  assert.ok(fetches[1].includes('/job/acme-'), 'all-keyword hit sorts first');
  assert.strictEqual(offers.length, 3, 'gamma has no keyword hit -> never fetched');
  assert.strictEqual(fetches.some((u) => u.includes('gamma-')), false, 'no-hit slugs are skipped entirely');
  const o = offers[0];
  assert.strictEqual(o.company, 'Acme GmbH');
  assert.strictEqual(o.location, 'Bremen, DE');
  assert.strictEqual(o.workplace, 'remote');
  assert.match(o.savedAt, /^2026-10-23/);
  assert.strictEqual(o.source, 'remotelyde');
  assert.ok(o.description.length >= 300);
});

// ---- conversation export (.md / .pdf) ----
test('composeConversationMd: title, meta, role sections and model badges', () => {
  const md = s.composeConversationMd({
    name: 'ACME — Embedded',
    messages: [
      { role: 'user', content: 'Offer text\nwith two lines' },
      { role: 'assistant', content: 'ANALIZA\nMETRYKA: 90%', model: 'gpt-test' },
      { role: 'assistant', content: '' }
    ]
  }, '2026-11-06 10:30');
  assert.match(md, /^# ACME — Embedded\n\nExported: 2026-11-06 10:30 · 3 messages\n/);
  assert.match(md, /## You\n\nOffer text\nwith two lines/);
  assert.match(md, /## Assistant — gpt-test\n\nANALIZA\nMETRYKA: 90%/);
  assert.match(md, /## Assistant\n\n_\(empty\)_/);
  assert.strictEqual(md.split('---').length, 4, 'one separator per message');
});

test('sanitizeChatHtml: strips scripts, handlers and dangerous tags, keeps marks', () => {
  const out = s.sanitizeChatHtml('<p>he<b>llo</b></p><script>alert(1)</script><img src="x" onerror="evil()"><iframe src="y"></iframe>');
  assert.ok(out.includes('<p>he<b>llo</b></p>'));
  assert.strictEqual(out.includes('script'), false);
  assert.strictEqual(out.includes('onerror'), false);
  assert.strictEqual(out.includes('iframe'), false);
  const marks = s.sanitizeChatHtml('<p>The <mark>key part is important</mark> stays.</p>');
  assert.ok(marks.includes('<mark>key part is important</mark>'), 'highlights survive');
});

// ---- Package export part selection ----
// Regression: "EDGE Group - Principal, Networks" — a later KATIM-form
// message numbered "## 3. Aktualizacja CV (AXE PRIM bullet)" (an editorial
// bullet swap, not a document) outranked the full package as the latest CV
// match, so the exported CV ODT contained the update comment instead of the
// CV, and the document title became "Aktualizacja formularza KATIM".

const OWNER = 'Tomasz Kuehn';

const PKG_FULL = [
  '# Pakiet aplikacyjny: Principal Engineer - Networks (EDGE Group, Abu Dhabi)',
  '## 1. Podsumowanie stanowiska',
  'EDGE Group is a UAE-based advanced technology and defence group focused on networking and satellite communication systems.',
  '## 2. Niemiecki na poziomie B1 - czy to problem?',
  'Brak niemieckiego nie jest blokerem dla tej roli.',
  '## 4. CV (ATS-friendly, EN) + Cover Letter (EN)',
  '',
  'Oferta jest anglojezyczna (ZEA), wiec cover letter tylko po angielsku. Usunalem MatchX z experience.',
  '',
  '**TOMASZ KUEHN**',
  'Hamburg, Germany | tomasz.kuehn@gmail.com | +49 162 8166352',
  '',
  '### PROFESSIONAL SUMMARY',
  'Hands-on networking and wireless systems engineer and technical leader with more than 20 years of experience in communication protocols, mesh networking, wireless systems and satellite communication software. I design and build complete systems from architecture and prototyping through integration, testing and certification.',
  '### PROFESSIONAL EXPERIENCE',
  '**CoreNetiX GmbH, Berlin, Germany | Head of Software Development | 2017 - 07/2019**',
  '- Redesigned a failing IoT network protocol into a reliable dual-band mesh network, demonstrated live at the Essen electronics fair, followed by EU and VdS radio certification.',
  '### EDUCATION',
  'Master of Science in Computer Science, Poznan University of Technology, Poland',
  '### CONTRACTING NOTE',
  'Windoorsen, Eduintegrator and initial CoreNetiX roles were long-term full-time B2B engagements invoiced through AXE PRIM.',
  '---',
  '',
  '**COVER LETTER (EN)**',
  '',
  'Subject: Application for Principal Engineer - Networks (Networking Prototyping)',
  '',
  'Dear Hiring Team,',
  '',
  'I am applying for the Principal Engineer - Networks position at EDGE Group. Across these roles I did exactly what this position asks for: design and develop communication protocols and networking software.',
  '',
  'Best regards,',
  'Tomasz Kuehn',
  '## 5. Ocena rekrutera i rekomendacja',
  'Moja rekomendacja: aplikowac, szanse sa realne.'
].join('\n');

const KATIM_UPDATE = [
  '# Aktualizacja formularza KATIM',
  '## 1. Wzmocnienie punktu 8 (relevant experience)',
  'W formularzu odpowiedz zostaje bez zmian.',
  '## 3. Aktualizacja CV (AXE PRIM bullet)',
  'Zamien bullet w AXE PRIM na:',
  '- Built and operated a local wireless ISP: Mikrotik-based routed and bridged backbones, hotspots, VPN links, base stations and custom router software.'
].join('\n');

test('extractPackageMessage: editorial CV fragment is rejected by the plausibility gate', () => {
  const out = s.extractPackageMessage(KATIM_UPDATE, OWNER);
  assert.strictEqual(out.cv, null, 'a mentioning "Aktualizacja CV" heading must not yield a CV');
  assert.strictEqual(out.clEn, null);
  assert.strictEqual(out.clDe, null);
});

test('extractPackageMessage: heading with an empty body is reported as an empty string', () => {
  const out = s.extractPackageMessage('## 4. CV (ATS-friendly, EN)\n## 5. Ocena rekrutera', OWNER);
  assert.strictEqual(out.cv, '');
  assert.strictEqual(out.clEn, null);
});

test('extractPackageMessage: classic numbered 4a/4b sections still parse', () => {
  const md = [
    '# PAKIET: QA Lead — ACME',
    '### 4a. CV',
    '**TOMASZ KUEHN**',
    'Hamburg, Germany | tomasz.kuehn@gmail.com | +49 162 8166352',
    '### PROFESSIONAL SUMMARY',
    'Hands-on QA and networking engineer with more than 20 years of experience in communication protocols, wireless systems and satellite communication software, spanning embedded firmware, test campaigns and team leadership.',
    '### 4b. Cover Letter (EN)',
    'Dear Hiring Team,',
    '',
    'I am applying for the QA Lead position at ACME. With more than 20 years of hands-on engineering in communication protocols, embedded systems and regulated environments, I bring the certification discipline and technical leadership this role requires.',
    'My background spans radio certification campaigns, satellite communication software and leading multidisciplinary teams from failing prototypes to production-ready systems.',
    '',
    'Best regards,',
    'Tomasz Kuehn'
  ].join('\n');
  const out = s.extractPackageMessage(md, OWNER);
  assert.ok(out.cv.includes('TOMASZ KUEHN'));
  assert.ok(out.cv.length >= 300);
  assert.ok(out.clEn.includes('Dear Hiring Team'));
  assert.ok(/Tomasz Kuehn\s*$/.test(out.clEn), 'signature block kept, trailing commentary dropped');
});

test('pickPackageParts: CV fragment never overrides the full package (EDGE regression)', () => {
  const msgs = [
    { role: 'user', content: 'offer' },
    { role: 'assistant', content: PKG_FULL },
    { role: 'user', content: 'KATIM questions' },
    { role: 'assistant', content: KATIM_UPDATE }
  ];
  const out = s.pickPackageParts(msgs, OWNER);
  assert.ok(out.cvMsg === msgs[1], 'CV must come from the full package message, not the KATIM fragment');
  assert.ok(out.cv.startsWith('# **TOMASZ KUEHN**'), 'CV body starts at the owner name line (preamble dropped)');
  assert.ok(!out.cv.includes('Aktualizacja formularza KATIM'));
  assert.ok(!out.cv.startsWith('Oferta jest anglojezyczna'), 'editorial preamble must not leak into the CV');
  assert.ok(out.clEnMsg === msgs[1]);
  assert.ok(out.clEn.includes('Subject: Application for Principal Engineer'));
  assert.strictEqual(out.clDe, null);
  assert.ok(/^Pakiet aplikacyjny/.test(out.title), `title from the package message, got: ${out.title}`);
});

test('pickPackageParts: a later full standalone CV update still wins', () => {
  const cv2 = [
    '# TOMASZ KUEHN',
    'Hamburg, Germany | tomasz.kuehn@gmail.com | +49 162 8166352',
    '',
    'Hands-on networking and wireless systems engineer and technical leader with more than 20 years of experience in communication protocols, mesh networking, wireless systems and satellite communication software.',
    '',
    '### PROFESSIONAL EXPERIENCE',
    '**IDAIR GmbH, Hamburg | Systems Software Engineer | 02/2023 - 01/2026**',
    '- Led DO-160 certification activities for a multifunctional communication module for VIP aircraft.',
    ''
  ].join('\n');
  const msgs = [
    { role: 'assistant', content: PKG_FULL },
    { role: 'assistant', content: KATIM_UPDATE },
    { role: 'assistant', content: cv2 }
  ];
  const out = s.pickPackageParts(msgs, OWNER);
  assert.ok(out.cvMsg.content === cv2, 'a full CV outside a package (owner-H1) is still the newest version');
  assert.ok(out.clEnMsg && out.clEn.includes('Subject: Application'), 'cover letter still taken from the package message');
});

// Regression: a cover letter that OPENS with the sender block
// ("## Cover Letter (EN)" followed by a bold owner line) made the extracted
// letter body empty — the promoted owner H1 was read as a document boundary,
// so the export failed with "heading found but the body is empty"
// (observed: "Senior embedded Bremen").
test('pickPackageParts: letter sender block right after the CL heading stays in the letter', () => {
  const cl = [
    '## Cover Letter (EN)',
    '',
    '**Tomasz Kuehn**',
    'Hamburg, Germany | tomasz.kuehn@example.com | +49 123 4567',
    '',
    'Dear Hiring Team,',
    '',
    'I am applying for the freelance Senior Embedded Software Engineer position in Bremen with strong focus on safety-critical systems.' +
    ' I bring more than twenty years of experience in embedded real-time software and satellite flight software development.',
    '',
    'Kind regards,',
    'Tomasz Kuehn',
    '',
    '---'
  ].join('\n');
  const msg = ['# 4. CV (ATS-friendly) i Cover Letter', '', '## CV', '', '**TOMASZ KUEHN**',
    'Hands-on networking and wireless systems engineer with more than 20 years of experience in communication protocols.',
    '', '### PROFESSIONAL EXPERIENCE',
    '**IDAIR GmbH, Hamburg | Systems Software Engineer | 02/2023 - 01/2026**',
    '- Led DO-160 certification activities for a multifunctional communication module for VIP aircraft and owned the full verification workflow.',
    '- Resolved hardware and software integration defects for the cabin management system and ran qualification testing.',
    '', cl, '', '# 5. Ocena aplikacji'].join('\n');
  const out = s.pickPackageParts([{ role: 'assistant', content: msg }], OWNER);
  assert.ok(out.clEn && out.clEn.trim().length > 300, 'letter body is NOT empty: ' + (out.clEn == null ? 'null' : out.clEn.length));
  assert.ok(out.clEn.startsWith('# **Tomasz Kuehn**'), 'sender block kept as the letter opening');
  assert.ok(out.clEn.includes('Dear Hiring Team'));
  assert.ok(!out.clEn.includes('---'), 'trailing rule cut by the signature trim');
  assert.ok(!out.clEn.includes('# 5.'), 'next analysis section not swallowed');
  assert.ok(out.cv.includes('# **TOMASZ KUEHN**'), 'CV still extracted');
});

// ---- GulfHire: full "The posting" instead of the listing summary ----
// Regression: the result offers carried only the ~300-char listing summary
// (jr-summary, cut mid-sentence) because detail pages are fetched for the
// first listings only, and some detail pages have no JobPosting JSON-LD even
// though the server-rendered "The posting" section is there.
const GH_LIST_CARD = (href, title, company, city, summary) =>
  '<article class="jr"><div class="jr-main"><h2 class="jr-title"><a class="jr-link" href="' + href + '"><span lang="en">' + title + '</span></a></h2>' +
  '<p class="jr-meta"><span class="jr-fact jr-company"><bdi>' + company + '</bdi></span><span class="jr-fact"><span>' + city + '</span></span></p>' +
  '<p class="jr-summary" lang="en">' + summary + '</p>' +
  '</div><div class="jr-facts"><span class="jr-posted"><span class="num">13 Oct</span></span></div></article>';
const GH_PROSE = 'Role details from the employer posting. ' + 'The engineer designs, builds and operates the platform core services, ' +
  'leads delivery across squads and drives the certification programme for radio modules in scope. ' +
  'Requirements include ten years of experience, SQL, agile practices and strong stakeholder communication skills across regions.';
const ghDetailJsonLd = (desc) => '<html><head><script type="application/ld+json">{"@type":"JobPosting","title":"x","description":"' + desc + '"}</script></head><body></body></html>';
const ghDetailProse = () => '<html><body><section class="jd-section jd-posting" aria-labelledby="posting-1"><h2 class="jd-eyebrow">The posting</h2>' +
  '<p class="jd-machine">As published on example.com.</p><div class="jd-prose" lang="en" dir="ltr"><p>' + GH_PROSE + '</p><p>Second paragraph.</p></div></section></body></html>';
const GH_SUMMARY_A = 'Nokia is hiring a Senior Software Engineer in Dubai to work on packet core network functions and cloud native deployments, including integration testing and vendor coordination across the release train.';
const GH_SUMMARY_B = 'Ericsson seeks a DevOps Engineer in Abu Dhabi to automate CI/CD pipelines, manage Kubernetes clusters and support monitoring of production systems for its managed services customers.';
const GH_SUMMARY_C = 'Thuraya hires a Satellite Ground Segment Engineer in Dubai specialising on gateway operations, RF link budgets and antenna tracking systems for L and S band services.';

test('parseGulfhirePosting: JSON-LD description wins, jd-prose fallback, none -> empty', () => {
  const ld = s.parseGulfhirePosting(ghDetailJsonLd('<p>' + GH_PROSE + '</p>'));
  assert.ok(ld.includes('employer posting.') && ld.length > 300, 'JSON-LD path returns the full text');
  const prose = s.parseGulfhirePosting(ghDetailProse());
  assert.ok(prose.includes('Second paragraph.') && prose.length > 300, 'jd-prose fallback when there is no JSON-LD');
  const none = s.parseGulfhirePosting('<section class="jd-section jd-lead"><h2 class="jd-eyebrow">Summary</h2><p class="jd-summary">Only a summary here, ' + GH_SUMMARY_A + '</p></section>');
  assert.strictEqual(none, '', 'no posting description -> empty string (caller keeps the summary)');
});

test('fetchGulfhireOffers: detail pages carry the full posting, summary kept when there is none', async () => {
  const listing = '<html><main>' +
    GH_LIST_CARD('/jobs/a-dubai-aaa', 'Senior Software Engineer - Core', 'Nokia', 'Dubai', GH_SUMMARY_A) +
    GH_LIST_CARD('/jobs/b-abu-dhabi-bbb', 'DevOps Engineer', 'Ericsson', 'Abu Dhabi', GH_SUMMARY_B) +
    GH_LIST_CARD('/jobs/c-dubai-ccc', 'Ground Segment Engineer', 'Thuraya', 'Dubai', GH_SUMMARY_C) +
    '</main></html>';
  const pages = {
    'https://gulfhire.com/jobs/a-dubai-aaa': ghDetailJsonLd('<p>' + GH_PROSE + '</p>'),       // JSON-LD full text
    'https://gulfhire.com/jobs/b-abu-dhabi-bbb': ghDetailProse(),                             // prose fallback (no JSON-LD)
    'https://gulfhire.com/jobs/c-dubai-ccc': '<p class="jd-machine">The original posting has no description.</p>' // nothing to read
  };
  const src = s.JOB_SOURCES.find((x) => x.id === 'gulfhire');
  const offers = await src.fetchOffers(src, { keywords: 'engineer', location: 'Dubai' }, {
    getText: async (u) => (u.includes('/jobs?q=') ? listing : (pages[u] != null ? pages[u] : Promise.reject(new Error('404')))),
    delay: 0
  });
  const byUrl = new Map(offers.map((o) => [o.url, o]));
  assert.strictEqual(byUrl.get('https://gulfhire.com/jobs/a-dubai-aaa').description, s.parseGulfhirePosting(ghDetailJsonLd('<p>' + GH_PROSE + '</p>')), 'JSON-LD detail text');
  assert.ok(byUrl.get('https://gulfhire.com/jobs/b-abu-dhabi-bbb').description.includes('Second paragraph.'), 'prose fallback used when JSON-LD is absent');
  assert.strictEqual(byUrl.get('https://gulfhire.com/jobs/c-dubai-ccc').description, GH_SUMMARY_C, 'summary kept when the posting has no description');
});

test('jobEnrichResults: short GulfHire results get the full posting, rich ones are left alone', async () => {
  const full = s.parseGulfhirePosting(ghDetailJsonLd('<p>' + GH_PROSE + '</p>'));
  const offers = [
    { source: 'gulfhire', url: 'https://gulfhire.com/jobs/a', description: GH_SUMMARY_A },
    { source: 'gulfhire', url: 'https://gulfhire.com/jobs/rich', description: 'x'.repeat(1500) }, // already full -> no fetch
    { source: 'arbeitnow', url: 'https://a.example/j', description: GH_SUMMARY_B },               // other source -> no fetch
    { source: 'gulfhire', url: 'https://gulfhire.com/jobs/dead', description: GH_SUMMARY_C }      // fetch fails -> summary kept
  ];
  let calls = 0;
  await s.jobEnrichResults(offers, 0, async (u) => {
    calls++;
    assert.ok(u === 'https://gulfhire.com/jobs/a' || u === 'https://gulfhire.com/jobs/dead', 'only short gulfhire offers are fetched');
    if (u.includes('dead')) throw new Error('HTTP 500');
    return ghDetailJsonLd('<p>' + GH_PROSE + '</p>');
  });
  assert.strictEqual(calls, 2, 'exactly the two short gulfhire offers were refetched');
  assert.strictEqual(offers[0].description, full, 'summary replaced by the full posting');
  assert.strictEqual(offers[1].description, 'x'.repeat(1500), 'rich description untouched');
  assert.strictEqual(offers[2].description, GH_SUMMARY_B, 'non-gulfhire source untouched');
  assert.strictEqual(offers[3].description, GH_SUMMARY_C, 'failed fetch keeps the summary');
});
