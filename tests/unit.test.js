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
