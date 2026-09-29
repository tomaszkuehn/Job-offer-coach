// UI tests for GEM (Job Offer Coach) — Playwright driving a dedicated
// (headed) Edge window ("special browser window") against a SANDBOX server:
// GEM_DATA_DIR points at a throwaway data dir, so nothing here can touch
// the real application data.
//
// Made SLOW on purpose: slowMo + deliberate pauses between steps so a human
// can observe every action in the window. Tune via GEM_UI_SLOW (ms) or use
// GEM_UI_HEADLESS=1 to run without a window (e.g. in CI).
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
const SLOW = parseInt(process.env.GEM_UI_SLOW || '700', 10); // ms of observation time per action
const HEADLESS = process.env.GEM_UI_HEADLESS === '1';

let child, browser, page;

function pause(ms) { return new Promise((r) => setTimeout(r, ms === undefined ? SLOW : ms)); }

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function assistantReply(marker) {
  return '# Analiza\n\nTo jest **testowa** odpowiedź asystenta z polskimi znakami: ĄĆĘŁŃÓŚŹŻ.\n\nMETRYKA: Szanse na interview: 55% | Szanse na zatrudnienie: 30% | Dopasowanie do roli: 80% | Poziom satysfakcji ze stanowiska: 70% | Porównanie wynagrodzenia: 75% | Rekomendacja czy aplikować: 85%' + (marker ? '\n\n' + marker : '');
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
        { role: 'assistant', content: assistantReply(idx === 0 ? '' : 'OTHER-DISTINGUISHING marker text.') }
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
  browser = await chromium.launch({ channel: 'msedge', headless: HEADLESS, slowMo: SLOW });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  page = await ctx.newPage();
  await page.goto(BASE);
});

after(async () => {
  await pause(1200); // let the observer take a last look
  if (browser) await browser.close();
  if (child) child.kill();
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

async function openConv(name) {
  const item = page.locator('#convList span', { hasText: name }).first();
  await item.click();
  await page.waitForSelector('#chat .msg.assistant .md');
  await pause();
}

test('app title is Job Offer Coach', async () => {
  await assert.doesNotReject(() => page.waitForSelector('h1'));
  const title = await page.textContent('h1');
  assert.match(title, /Job Offer Coach/);
  await pause();
});

test('sandbox conversation appears in the sidebar (not the real data)', async () => {
  const list = await page.textContent('#convList');
  assert.match(list, /ACME - Dev/);
  assert.doesNotMatch(list, /eleQtron|Oryn Group/, 'real data must NOT leak into the test window');
  await pause();
});

test('metrics overlay opens with the sandbox metric', async () => {
  await page.click('#metricsBtn');
  await page.waitForSelector('#metricsOverlay.show .metrics-table');
  const body = await page.textContent('#metricsBody');
  assert.match(body, /ACME/);
  await pause();
  await page.click('#metricsClose');
  await page.waitForFunction(() => !document.querySelector('#metricsOverlay').classList.contains('show'));
});

test('text highlight: selecting chat text shows the floating button and marks it yellow', async () => {
  await openConv('ACME - Dev');
  const md = await page.$('#chat .msg.assistant .md p');
  const box = await md.boundingBox();
  await page.mouse.move(box.x + 8, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 8, { steps: 8 });
  await page.mouse.up();
  const btn = page.locator('#hlBtn');
  await btn.waitFor({ state: 'visible', timeout: 3000 });
  await pause(900); // watch the floating button under the selection
  await btn.click();
  const marks = await page.$$eval('mark.chat-hl', (els) => els.length);
  assert.ok(marks >= 1, 'a yellow highlight should exist after clicking Highlight');
  const bg = await page.$eval('mark.chat-hl', (el) => getComputedStyle(el).backgroundColor);
  assert.match(bg, /255, 241, 118/, 'mark should be the yellow #fff176');
  await pause();
});

test('multiple highlights accumulate', async () => {
  const paragraphs = await page.$$('#chat .msg.assistant .md p');
  assert.ok(paragraphs.length >= 2, 'assistant reply has at least two paragraphs');
  for (const p of paragraphs.slice(0, 2)) {
    const box = await p.boundingBox();
    await page.mouse.move(box.x + 8, box.y + 8);
    await page.mouse.down();
    await page.mouse.move(box.x + 100, box.y + 8, { steps: 6 });
    await page.mouse.up();
    await pause(400);
    const btn = page.locator('#hlBtn');
    try { await btn.click({ timeout: 2500 }); } catch (_) {}
    await pause();
  }
  const marks = await page.$$eval('mark.chat-hl', (els) => els.length);
  assert.ok(marks >= 2, 'second highlight should add another mark');
  await pause();
});

test('highlights disappear after switching conversations', async () => {
  await openConv('Other - Chat');
  await page.waitForSelector('text=OTHER-DISTINGUISHING');
  const inChat = await page.$$eval('#chat mark.chat-hl', (els) => els.length);
  assert.strictEqual(inChat, 0, 'highlight is in-memory only; a re-render drops it');
  await pause();
});

test('conversation search filters the sidebar list', async () => {
  // Search matches titles AND bodies, so use a string unique to the title
  // of the first conversation ("ACME - Dev").
  await page.fill('#convSearch', 'ACME - Dev');
  await pause(900); // debounced server search
  let list = await page.textContent('#convList');
  assert.match(list, /ACME - Dev/);
  assert.doesNotMatch(list, /Other - Chat/, 'non-matching conversation should disappear from the list');
  // A nonsense query shows the empty state.
  await page.fill('#convSearch', 'ZZZ-NO-SUCH-OFFER');
  await pause(900);
  list = await page.textContent('#convList');
  assert.match(list, /No conversations|No saved|match/i, 'empty state message appears for a no-hit search');
  await page.fill('#convSearch', '');
  await pause();
  // Clear (✕) button: appears only when the field has text, restores the full list.
  await page.fill('#convSearch', 'ACME - Dev');
  await pause(900);
  const clearVisible = await page.$eval('#convSearchClear', (b) => b.style.display !== 'none');
  assert.ok(clearVisible, 'clear button becomes visible while a query is set');
  await page.click('#convSearchClear');
  await pause(900);
  list = await page.textContent('#convList');
  assert.match(list, /ACME - Dev/);
  assert.match(list, /Other - Chat/, 'clear (✕) restores the unfiltered list');
});

test('RAG files panel toggles open and closed', async () => {
  const body = page.locator('#filesBody');
  assert.strictEqual(await body.isHidden(), true, 'files panel starts collapsed');
  await page.click('#filesToggle');
  await pause(700);
  assert.strictEqual(await body.isVisible(), true, 'files panel opens on toggle');
  await page.click('#filesToggle');
  await pause(700);
  assert.strictEqual(await body.isHidden(), true, 'files panel closes again');
});

test('model switcher and ctx badge are rendered', async () => {
  const opts = await page.$$eval('#modelSwitcher option', (els) => els.map((e) => e.textContent));
  assert.ok(opts.some((t) => /test-model/.test(t)), 'sandbox model should be in the switcher');
  const ctx = await page.textContent('#ctxSize');
  assert.match(ctx, /ctx:/, 'context-size badge should be present');
  await pause();
});

test('bulk dialog opens, empty state, and closes', async () => {
  await page.click('#bulkBtn');
  await page.waitForSelector('#bulkOverlay.show');
  await pause(700);
  const meta = await page.textContent('#bulkMeta');
  assert.ok(meta.length > 0, 'bulk meta line renders');
  await page.click('#bulkClose');
  await page.waitForFunction(() => !document.querySelector('#bulkOverlay').classList.contains('show'));
  await pause();
});

test('job search overlay: offline sample search produces results and loads to bulk', async () => {
  await page.click('#jobSearchBtn');
  await page.waitForSelector('#jobSearchOverlay.show');
  await pause(700);
  // Use the offline sample source only (deterministic, no network).
  await page.click('#jsBody [data-js-src="arbeitnow"]');
  await page.click('#jsBody [data-js-src="remotive"]');
  await page.click('#jsBody [data-js-src="jobicy"]');
  await page.click('#jsBody [data-js-src="remoteok"]');
  await page.click('#jsBody [data-js-src="sample"]');
  await page.fill('#jsKeywords', 'ai software');
  await page.fill('#jsLocation', 'Hamburg onsite, Poznan onsite, EU remotely');
  await pause(300);
  await page.click('#jsSearch');
  // Step 1 shows the prompt for approval before any AI call.
  await page.waitForSelector('#jsPromptWrap', { state: 'visible', timeout: 20000 });
  const prompt = await page.inputValue('#jsPromptView');
  assert.match(prompt, /Hamburg onsite, Poznan onsite, EU remotely/, 'free-text location is passed verbatim into the prompt');
  await pause(500);
  // Step 2: approve and run the AI (model unreachable in sandbox -> fallback).
  await page.click('#jsApprove');
  await page.waitForFunction(() => document.querySelectorAll('#jsOffers .bulk-offer').length > 0, { timeout: 20000 });
  await pause(900);
  const rows = await page.$$eval('#jsOffers .bulk-offer', (els) => els.length);
  assert.ok(rows > 0, 'sample search should render result rows');
  assert.strictEqual(await page.locator('#jsDownload').isEnabled(), true, 'download button enabled after results');
  // Load into the existing bulk pipeline.
  await page.click('#jsLoadBulk');
  await page.waitForSelector('#bulkOverlay.show');
  await pause(900);
  const bulkRows = await page.$$eval('#bulkOffers .bulk-offer', (els) => els.length);
  assert.ok(bulkRows > 0, 'job results are handed over to the bulk dialog');
  await page.click('#bulkClose');
  await page.waitForFunction(() => !document.querySelector('#bulkOverlay').classList.contains('show'));
  await pause();
});

test('metrics status cell cycles to_apply -> not_applying -> clear', async () => {
  await page.click('#metricsBtn');
  await page.waitForSelector('#metricsOverlay.show .metrics-table');
  const cell = page.locator('.metrics-table td.st-cell').first();
  await cell.click();
  await pause(900);
  let txt = await page.textContent('.metrics-table td.st-cell').then((t) => t);
  assert.match(txt, /not applying/i, 'first cycle: to_apply becomes not applying');
  await cell.click();
  await pause(900);
  txt = await page.textContent('.metrics-table td.st-cell');
  assert.doesNotMatch(txt, /not applying|to apply/i, 'second cycle: status cleared');
  await page.click('#metricsClose');
  await page.waitForFunction(() => !document.querySelector('#metricsOverlay').classList.contains('show'));
  // The cycle must persist into the conversation tags (sandbox).
  const conv = await (await fetch(BASE + '/api/conversations/uitest00000001')).json();
  assert.strictEqual(conv.tags.status, null, 'status cleared in conversation tags as well');
  await pause();
});

test('new conversation button resets the chat view', async () => {
  await page.click('#newConvBtn');
  await pause(900);
  const chat = await page.textContent('#chat');
  assert.ok(chat.length > 0, 'chat shows the empty-state hint');
  assert.doesNotMatch(chat, /testowa/, 'previous conversation content is gone');
  await openConv('ACME - Dev'); // restore for any later expectations
});

test('rename dialog opens prefilled and closes on cancel', async () => {
  await openConv('ACME - Dev');
  const renameBtn = page.locator('#convList .file-item.active .rename').first();
  await renameBtn.click();
  await page.waitForSelector('#renameOverlay.show');
  await pause(700);
  const value = await page.inputValue('#renameOverlay input');
  assert.match(value, /ACME - Dev/, 'rename input is prefilled with the current name');
  await page.click('#renameCancel').catch(async () => { await page.keyboard.press('Escape'); });
  await page.waitForFunction(() => !document.querySelector('#renameOverlay').classList.contains('show'));
  await pause();
});
