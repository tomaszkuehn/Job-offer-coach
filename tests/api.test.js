// API integration tests for GEM (Job Offer Coach).
// The server is spawned as a child process with GEM_DATA_DIR pointed at a
// throwaway sandbox under the OS temp dir — the real application data is
// NEVER read or modified. All mutating endpoints run against the sandbox.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NODE = process.execPath;
const ROOT = path.join(__dirname, '..');
const PORT = 3179;
const BASE = `http://localhost:${PORT}`;
const SANDBOX = path.join(os.tmpdir(), 'opencode', 'gem-test-sandbox');

let child = null;

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

before(async () => {
  // Fresh sandbox for every run.
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });
  writeJson(path.join(SANDBOX, 'config.json'), {
    models: [{ endpoint: 'http://localhost:11434/api/chat', model: 'test-model', apiKey: '', prompt: '' }],
    activeModel: 0,
    systemPrompt: 'TEST SYSTEM PROMPT',
    selectedFiles: []
  });
  const convId = 'testconv000001';
  writeJson(path.join(SANDBOX, 'conversations', convId, 'conversation.json'), {
    id: convId, name: 'ACME - Dev', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    messages: [
      { role: 'user', content: 'Embedded Engineer\nACME\nBerlin\nhttps://example.com/1\n---\nSome long offer description used for duplicate detection testing purposes. Senior embedded quantum engineer role at our Hamburg quantum computing laboratory with strong embedded systems background.' },
      { role: 'assistant', content: 'ANALIZA\n\nMETRYKA: Szanse na interview: 60% | Szanse na zatrudnienie: 35% | Dopasowanie do roli: 90% | Poziom satysfakcji ze stanowiska: 72% | Porównanie wynagrodzenia: 80% | Rekomendacja czy aplikować: 90%' }
    ],
    selectedFiles: [], modelIndex: 0,
    tags: { matchPct: 60, german: null, status: 'to_apply', satisfactionPct: 72 }
  });
  writeJson(path.join(SANDBOX, 'conversations.json'), [
    { id: convId, name: 'ACME - Dev', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', messageCount: 2, tags: { matchPct: 60, german: null, status: 'to_apply', satisfactionPct: 72 } }
  ]);
  writeJson(path.join(SANDBOX, 'metrics.json'), {
    entries: [{
      convId, convName: 'ACME - Dev', createdAt: '2026-01-01T00:00:00.000Z',
      company: 'ACME', jobTitle: 'Embedded Engineer', location: 'Berlin', url: 'https://example.com/1',
      status: 'to_apply',
      metrics: { interview: 60, employment: 35, role: 90, satisfaction: 72, salary: 80, recommend: 90 },
      raw: 'METRYKA: ...'
    }]
  });
  child = spawn(NODE, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), GEM_DATA_DIR: SANDBOX },
    stdio: 'ignore'
  });
  // Wait until the server answers.
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/api/config');
      if (r.ok) return;
    } catch (_) {}
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error('test server did not start');
});

after(() => {
  if (child) child.kill();
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test('GET /api/config serves the sandbox config', async () => {
  const r = await fetch(BASE + '/api/config');
  assert.strictEqual(r.status, 200);
  const cfg = await r.json();
  assert.strictEqual(cfg.systemPrompt, 'TEST SYSTEM PROMPT');
  assert.strictEqual(cfg.models.length, 1);
});

test('GET /api/conversations lists the sandbox conversation', async () => {
  const r = await fetch(BASE + '/api/conversations');
  const list = await r.json();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, 'ACME - Dev');
});

test('GET /api/conversations/:id returns messages and tags', async () => {
  const r = await fetch(BASE + '/api/conversations/testconv000001');
  const conv = await r.json();
  assert.strictEqual(conv.messages.length, 2);
  assert.strictEqual(conv.tags.matchPct, 60);
});

test('GET /api/conversations/search covers title + first prompt, not assistant replies', async () => {
  const titleHit = await (await fetch(BASE + '/api/conversations/search?q=' + encodeURIComponent('ACME - Dev'))).json();
  assert.strictEqual(titleHit.length, 1);
  assert.strictEqual(titleHit[0].matchType, 'title');
  const promptHit = await (await fetch(BASE + '/api/conversations/search?q=' + encodeURIComponent('quantum engineer'))).json();
  assert.strictEqual(promptHit.length, 1);
  assert.strictEqual(promptHit[0].matchType, 'body');
  assert.ok(promptHit[0].snippet && promptHit[0].snippet.toLowerCase().includes('quantum'));
  const assistantOnly = await (await fetch(BASE + '/api/conversations/search?q=' + encodeURIComponent('ANALIZA'))).json();
  assert.strictEqual(assistantOnly.length, 0, 'assistant-only phrase must not match');
});

test('POST /api/conversations/:id/rename syncs metrics convName', async () => {
  const r = await fetch(BASE + '/api/conversations/testconv000001/rename', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'ACME GmbH - Senior Dev' })
  });
  assert.strictEqual(r.status, 200);
  const m = await (await fetch(BASE + '/api/metrics')).json();
  const entry = m.entries.find((e) => e.convId === 'testconv000001');
  assert.strictEqual(entry.convName, 'ACME GmbH - Senior Dev');
});

test('POST /api/conversations/:id/tags syncs metrics status', async () => {
  const r = await fetch(BASE + '/api/conversations/testconv000001/tags', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'applied' })
  });
  assert.strictEqual(r.status, 200);
  const m = await (await fetch(BASE + '/api/metrics')).json();
  const entry = m.entries.find((e) => e.convId === 'testconv000001');
  assert.strictEqual(entry.status, 'applied');
  // Invalid status is rejected.
  const bad = await fetch(BASE + '/api/conversations/testconv000001/tags', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'nope' })
  });
  assert.strictEqual(bad.status, 400);
});

test('POST /api/bulk/refresh re-flags offers against sandbox conversations', async () => {
  const desc = 'Some long offer description used for duplicate detection testing purposes. Senior embedded quantum engineer role at our Hamburg quantum computing laboratory with strong embedded systems background.';
  const r = await fetch(BASE + '/api/bulk/refresh', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ offers: [{ title: 'Embedded Engineer', company: 'ACME', location: 'Berlin', url: 'https://example.com/1', description: desc }] })
  });
  const data = await r.json();
  assert.ok(data.offers, 'refresh should return offers');
  assert.ok(data.offers[0].duplicate, 'near-identical offer should be flagged as duplicate');
  assert.strictEqual(data.offers[0].duplicate.id, 'testconv000001');
});

test('POST /api/bulk/parse accepts CSV and flags nothing in empty sandbox copy', async () => {
  const csv = `jobId,title,company,location,workplaceType,url,status,savedAt,descriptionText\n9,Brand New Role,FreshCo,Bonn,On-site,https://example.com/9,apply,2026-02-02,"Brand new offer text that does not match anything stored in the sandbox conversation at all. Long enough to pass the parser. Definitely unique."`;
  const fd = new FormData();
  fd.append('file', new Blob([csv]), 'linkedin-jobs.csv');
  const r = await fetch(BASE + '/api/bulk/parse', { method: 'POST', body: fd });
  const data = await r.json();
  assert.strictEqual(data.count, 1);
  assert.strictEqual(data.offers[0].duplicate, null);
  assert.strictEqual(data.offers[0].company, 'FreshCo');
});

test('POST /api/config persists exportsDir and GET returns it', async () => {
  const dir = path.join(SANDBOX, 'custom-exports');
  const post = await fetch(BASE + '/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exportsDir: dir })
  });
  assert.strictEqual(post.status, 200);
  const cfg = await (await fetch(BASE + '/api/config')).json();
  assert.strictEqual(cfg.exportsDir, dir);
  assert.ok(fs.existsSync(dir), 'configured export directory is created on save');
  const postRel = await fetch(BASE + '/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exportsDir: 'rel-exports' })
  });
  assert.strictEqual(postRel.status, 200);
  const cfg2 = await (await fetch(BASE + '/api/config')).json();
  assert.strictEqual(cfg2.exportsDir, 'rel-exports');
});

test('GET /api/fs/roots and /api/fs/list browse the filesystem', async () => {
  const r = await fetch(BASE + '/api/fs/roots');
  const { roots } = await r.json();
  assert.ok(Array.isArray(roots) && roots.length >= 1, 'at least one root');
  assert.ok(roots.every((x) => path.isAbsolute(x.path)), 'roots are absolute');
  const r2 = await fetch(BASE + '/api/fs/list?path=' + encodeURIComponent(roots[0].path));
  const data = await r2.json();
  assert.strictEqual(r2.status, 200);
  assert.ok(Array.isArray(data.dirs), 'dirs array');
  assert.ok(!data.dirs.some((d) => d === '$RECYCLE.BIN' || d === 'System Volume Information'), 'system entries hidden');
  const bad = await fetch(BASE + '/api/fs/list?path=' + encodeURIComponent(path.join(SANDBOX, 'nope-nodir')));
  assert.strictEqual(bad.status, 404);
  const fileAsDir = await fetch(BASE + '/api/fs/list?path=' + encodeURIComponent(path.join(SANDBOX, 'config.json')));
  assert.strictEqual(fileAsDir.status, 400);
});

test('POST /api/context-size computes chars/tokens', async () => {
  const r = await fetch(BASE + '/api/context-size', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello world offer' }], modelIndex: 0, selectedFiles: [] })
  });
  const data = await r.json();
  assert.ok(data.chars > 0);
  assert.ok(data.tokens > 0);
});

test('POST /api/job-search streams NDJSON and builds bulk offers (offline sample)', async () => {
  const r = await fetch(BASE + '/api/job-search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      keywords: 'ai software', location: '', languages: 'english only',
      workplace: ['remote', 'onsite', 'hybrid'], sources: ['sample'], modelIndex: 0
    })
  });
  assert.strictEqual(r.status, 200);
  const text = await r.text();
  const events = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const kinds = events.map((e) => e.event);
  assert.ok(kinds.includes('start'), 'start event');
  assert.ok(kinds.includes('source-done'), 'source-done event');
  assert.ok(kinds.includes('prefilter'), 'prefilter event');
  assert.ok(kinds.includes('done'), 'done event');
  const done = events.find((e) => e.event === 'done');
  assert.ok(Array.isArray(done.offers) && done.offers.length > 0, 'offers returned');
  for (const o of done.offers) {
    assert.ok(o.description && o.description.length >= 100, 'description >= 100 chars (bulk requirement)');
    assert.ok(o.url, 'apply url present');
    assert.ok(o.company && o.location, 'company + location present');
    assert.strictEqual(o.source, 'sample');
  }
  // Model endpoint is unreachable in the sandbox -> unfiltered fallback, still valid.
  assert.strictEqual(done.aiChecked, false);
});

test('POST /api/job-search/preview builds prompts without calling the model', async () => {
  const r = await fetch(BASE + '/api/job-search/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      keywords: 'ai software', location: 'Hamburg onsite, Poznan onsite, EU remotely', languages: 'english only',
      workplace: ['remote', 'onsite', 'hybrid'], sources: ['sample'], modelIndex: 0
    })
  });
  assert.strictEqual(r.status, 200);
  const events = (await r.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const preview = events.find((e) => e.event === 'preview');
  assert.ok(preview && preview.searchId, 'preview carries a searchId');
  assert.ok(preview.batches.length >= 1, 'at least one batch');
  assert.match(preview.batches[0].prompt, /Hamburg onsite, Poznan onsite, EU remotely/, 'location text is verbatim in the prompt');
  assert.ok(!events.some((e) => e.event === 'ai-progress'), 'no model call during preview');
  // Step 2: run the approved prompt (model unreachable -> fallback offers).
  const run = await fetch(BASE + '/api/job-search/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ searchId: preview.searchId, prompts: preview.batches.map((b) => b.prompt), modelIndex: 0 })
  });
  const runEvents = (await run.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const done = runEvents.find((e) => e.event === 'done');
  assert.ok(done && Array.isArray(done.offers), 'run returns offers');
  for (const o of done.offers) assert.ok(o.description && o.description.length >= 100, 'bulk-ready description');
});

test('DELETE /api/conversations/:id removes it (sandbox only)', async () => {
  const r = await fetch(BASE + '/api/conversations/testconv000001', { method: 'DELETE' });
  assert.strictEqual(r.status, 200);
  const list = await (await fetch(BASE + '/api/conversations')).json();
  assert.strictEqual(list.length, 0);
  const m = await (await fetch(BASE + '/api/metrics')).json();
  assert.strictEqual(m.entries.length, 0, 'orphaned metrics entry is cleaned up');
});
