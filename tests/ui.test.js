// UI tests for GEM (Job Offer Coach) — Playwright driving a dedicated
// (headed) Edge window ("special browser window") against a SANDBOX server:
// GEM_DATA_DIR points at a throwaway data dir, so nothing here can touch
// the real application data. The window stays open ~untracked: assertions
// are done programmatically, then it closes.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const PORT = 3188;
const BASE = `http://localhost:${PORT}`;
const SANDBOX = path.join(os.tmpdir(), 'opencode', 'gem-test-ui-sandbox');

let child, browser, page;

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

before(async () => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });
  writeJson(path.join(SANDBOX, 'config.json'), {
    models: [{ endpoint: 'http://localhost:11434/api/chat', model: 'test-model', apiKey: '', prompt: '' }],
    activeModel: 0,
    systemPrompt: 'TEST SYSTEM PROMPT',
    selectedFiles: []
  });
  const convIds = ['uitest00000001', 'uitest00000002'];
  for (const [idx, convId] of convIds.entries()) {
    writeJson(path.join(SANDBOX, 'conversations', convId, 'conversation.json'), {
      id: convId, name: idx === 0 ? 'ACME - Dev' : 'Other - Chat', createdAt: '2026-01-0' + (idx + 1) + 'T00:00:00.000Z', updatedAt: '2026-01-0' + (idx + 1) + 'T00:00:00.000Z',
      messages: [
        { role: 'user', content: 'Embedded Engineer\nACME\nBerlin\nhttps://example.com/1\n---\nOffer description.' },
        { role: 'assistant', content: idx === 0 ? '# Analiza\n\nTo jest **testowa** odpowiedź asystenta z polskimi znakami: ĄĆĘŁŃÓŚŹŻ.\n\nMETRYKA: Szanse na interview: 55% | Szanse na zatrudnienie: 30% | Dopasowanie do roli: 80% | Poziom satysfakcji ze stanowiska: 70% | Porównanie wynagrodzenia: 75% | Rekomendacja czy aplikować: 85%' : '# Other analysis\n\nOTHER-DISTINGUISHING marker text.' }
      ],
      selectedFiles: [], modelIndex: 0,
      tags: { matchPct: 55, german: null, status: 'to_apply', satisfactionPct: 70 }
    });
  }
  writeJson(path.join(SANDBOX, 'conversations.json'), convIds.map((id, idx) => (
    { id, name: idx === 0 ? 'ACME - Dev' : 'Other - Chat', createdAt: '2026-01-0' + (idx + 1) + 'T00:00:00.000Z', updatedAt: '2026-01-0' + (idx + 1) + 'T00:00:00.000Z', messageCount: 2, tags: { matchPct: 55, german: null, status: 'to_apply', satisfactionPct: 70 } }
  )));
  writeJson(path.join(SANDBOX, 'metrics.json'), {
    entries: [{
      convId: 'uitest00000001', convName: 'ACME - Dev', createdAt: '2026-01-01T00:00:00.000Z',
      company: 'ACME', jobTitle: 'Embedded Engineer', location: 'Berlin', url: 'https://example.com/1',
      status: 'to_apply',
      metrics: { interview: 55, employment: 30, role: 80, satisfaction: 70, salary: 75, recommend: 85 },
      raw: 'METRYKA: ...'
    }]
  });
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), GEM_DATA_DIR: SANDBOX },
    stdio: 'ignore'
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/api/config')).ok) break; } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  browser = await chromium.launch({ channel: 'msedge', headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  page = await ctx.newPage();
  await page.goto(BASE);
});

after(async () => {
  if (browser) await browser.close();
  if (child) child.kill();
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test('app title is Job Offer Coach', async () => {
  await assert.doesNotReject(() => page.waitForSelector('h1'));
  const title = await page.textContent('h1');
  assert.match(title, /Job Offer Coach/);
});

test('sandbox conversation appears in the sidebar (not the real data)', async () => {
  const list = await page.textContent('#convList');
  assert.match(list, /ACME - Dev/);
  assert.doesNotMatch(list, /eleQtron|Oryn Group/, 'real data must NOT leak into the test window');
});

test('metrics overlay opens with the sandbox metric', async () => {
  await page.click('#metricsBtn');
  await page.waitForSelector('#metricsOverlay.show .metrics-table');
  const body = await page.textContent('#metricsBody');
  assert.match(body, /ACME/);
  await page.click('#metricsClose');
  await page.waitForSelector('#metricsOverlay.show', { state: 'detached' }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('#metricsOverlay').classList.contains('show'));
});

test('text highlight: selecting chat text shows the floating button and marks it yellow', async () => {
  const item = page.locator('#convList span', { hasText: 'ACME - Dev' }).first();
  await item.click();
  await page.waitForSelector('#chat .msg.assistant .md');
  const md = await page.$('#chat .msg.assistant .md p');
  // Select a slice of the paragraph text via triple-free manual drag.
  const box = await md.boundingBox();
  await page.mouse.move(box.x + 8, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 8, { steps: 8 });
  await page.mouse.up();
  const btn = page.locator('#hlBtn');
  await btn.waitFor({ state: 'visible', timeout: 3000 });
  await btn.click();
  const marks = await page.$$eval('mark.chat-hl', (els) => els.length);
  assert.ok(marks >= 1, 'a yellow highlight should exist after clicking Highlight');
  const bg = await page.$eval('mark.chat-hl', (el) => getComputedStyle(el).backgroundColor);
  assert.match(bg, /255, 241, 118/, 'mark should be the yellow #fff176');
});

test('highlights disappear after switching conversations', async () => {
  // Switch to the OTHER conversation: renderChat rebuilds the DOM, so the
  // in-memory marks must be gone.
  const item = page.locator('#convList span', { hasText: 'Other - Chat' }).first();
  await item.click();
  // Wait until the NEW conversation is actually rendered.
  await page.waitForSelector('text=OTHER-DISTINGUISHING');
  const inChat = await page.$$eval('#chat mark.chat-hl', (els) => els.length);
  assert.strictEqual(inChat, 0, 'highlight is in-memory only; a re-render drops it');
});
