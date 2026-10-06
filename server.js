const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pdfParse = require('pdf-parse');
const { execFile } = require('child_process');
const JSZip = require('jszip');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = process.env.GEM_DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const CONVERSATIONS_DIR = path.join(DATA_DIR, 'conversations');
const CONVERSATIONS_INDEX = path.join(DATA_DIR, 'conversations.json');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
migrateToCas();

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, Date.now() + '_' + safe);
  }
});
const upload = multer({ storage });

function sha256(file) {
  const data = fs.readFileSync(file);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '');
      return JSON.parse(raw);
    } catch (e) {
      return {};
    }
  }
  return {};
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function listFiles() {
  return fs.readdirSync(UPLOAD_DIR)
    .filter((f) => fs.statSync(path.join(UPLOAD_DIR, f)).isFile())
    .map((f) => {
      const full = path.join(UPLOAD_DIR, f);
      return {
        name: f,
        size: fs.statSync(full).size,
        path: full
      };
    });
}

function loadConversationsIndex() {
  if (fs.existsSync(CONVERSATIONS_INDEX)) {
    try {
      return JSON.parse(fs.readFileSync(CONVERSATIONS_INDEX, 'utf8'));
    } catch (e) {
      return [];
    }
  }
  return [];
}

function saveConversationsIndex(list) {
  fs.writeFileSync(CONVERSATIONS_INDEX, JSON.stringify(list, null, 2));
}

function loadConversation(id) {
  const file = path.join(CONVERSATIONS_DIR, id, 'conversation.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function copyFile(src, dest) {
  fs.copyFileSync(src, dest);
}

async function extractText(filePath, ext) {
  const extLower = ext.toLowerCase();
  if (extLower === '.pdf') {
    const dataBuffer = fs.readFileSync(filePath);
    const parsed = await pdfParse(dataBuffer);
    return parsed.text;
  }
  // txt, md, json, csv, etc.
  return fs.readFileSync(filePath, 'utf8');
}

// ---- Config ----
app.get('/api/config', (req, res) => {
  const cfg = loadConfig();
  res.json({
    ...cfg,
    files: listFiles()
  });
});

app.post('/api/config', (req, res) => {
  const cfg = loadConfig();
  const { models, activeModel, systemPrompt, selectedFiles, ownerName, exportsDir } = req.body;
  if (models !== undefined) cfg.models = models;
  if (activeModel !== undefined) cfg.activeModel = activeModel;
  if (systemPrompt !== undefined) cfg.systemPrompt = systemPrompt;
  if (selectedFiles !== undefined) cfg.selectedFiles = selectedFiles;
  if (ownerName !== undefined) cfg.ownerName = String(ownerName).trim();
  if (exportsDir !== undefined) {
    const v = String(exportsDir).trim();
    if (v) {
      const resolved = path.isAbsolute(v) ? v : path.join(__dirname, v);
      try {
        if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true });
        fs.accessSync(resolved, fs.constants.W_OK);
      } catch (e) {
        return res.status(400).json({ error: `Export directory not usable: ${resolved} (${e.message})` });
      }
    }
    cfg.exportsDir = v;
  }
  saveConfig(cfg);
  res.json({ ok: true });
});

// ---- Folder browser (exports directory picker) ----
app.get('/api/fs/roots', (req, res) => {
  const roots = [];
  const add = (p, label) => {
    try {
      if (p && fs.existsSync(p)) roots.push({ path: path.resolve(p), label: label || path.resolve(p) });
    } catch { /* unreachable drive */
    }
  };
  add(process.env.SystemDrive ? process.env.SystemDrive + '\\' : 'C:\\', 'System disk');
  if (process.env.USERPROFILE) {
    add(process.env.USERPROFILE, 'Home');
    add(path.join(process.env.USERPROFILE, 'Desktop'), 'Desktop');
    add(path.join(process.env.USERPROFILE, 'Documents'), 'Documents');
    add(process.env.USERPROFILE + '\\..\\..', null);
  }
  if (process.env.HOMEDRIVE && process.env.HOMEPATH) add(process.env.HOMEDRIVE + path.sep, 'Home drive');
  // Any additional fixed/removable drives
  for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
    const drive = letter + ':\\';
    try {
      if (fs.existsSync(drive)) roots.push({ path: drive, label: drive });
    } catch { /* skip */ }
  }
  const seen = new Set();
  res.json({ roots: roots.filter((r) => (seen.has(r.path) ? false : (seen.add(r.path), true))) });
});

app.get('/api/fs/list', (req, res) => {
  const dir = String(req.query.path || '').trim();
  if (!dir) return res.status(400).json({ error: 'Missing path' });
  let stat;
  try { stat = fs.statSync(dir); } catch { return res.status(404).json({ error: 'Directory not found: ' + dir }); }
  if (!stat.isDirectory()) return res.status(400).json({ error: 'Not a directory: ' + dir });
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
    return res.status(403).json({ error: 'Cannot read directory: ' + e.message });
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && e.name !== '$RECYCLE.BIN' && e.name !== 'System Volume Information')
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const parent = path.dirname(dir);
  res.json({
    path: path.resolve(dir),
    parent: path.resolve(dir) !== parent ? parent : null,
    dirs
  });
});

// ---- Models (fetch available models from Ollama Cloud) ----
app.get('/api/models', async (req, res) => {
  const cfg = loadConfig();
  const models = cfg.models && cfg.models.length ? cfg.models : [];
  const idx = cfg.activeModel || 0;
  const m = models[idx] || models[0];
  if (!m) return res.json({ models: [] });

  const endpoint = m.endpoint || 'https://ollama.com/api/chat';
  // List-models endpoint is always <origin>/api/tags (Ollama native API)
  let modelsUrl;
  try {
    modelsUrl = new URL(endpoint).origin + '/api/tags';
  } catch (e) {
    return res.status(400).json({ error: 'Invalid endpoint URL' });
  }
  const headers = {};
  if (m.apiKey) headers['Authorization'] = `Bearer ${m.apiKey}`;

  try {
    const upstream = await fetch(modelsUrl, { headers });
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `Model list error (${upstream.status})` });
    }
    const data = await upstream.json();
    const list = (data.models || data.data || [])
      .map((x) => x.name || x.id || x.model)
      .filter(Boolean);
    res.json({ models: list });
  } catch (e) {
    res.status(500).json({ error: 'Could not fetch models: ' + e.message });
  }
});

// ---- Files (content-addressed: name = <sha256[:8]>_<clean-original>) ----
function casName(filePath, originalName) {
  const clean = cleanFileName(originalName.replace(/[^a-zA-Z0-9._-]/g, '_'));
  return sha256(filePath).slice(0, 8) + '_' + clean;
}

// One-time migration: rename legacy timestamp-prefixed uploads to CAS names
// and remap references in config + conversations. Idempotent.
function migrateToCas() {
  if (fs.existsSync(path.join(DATA_DIR, '.cas-migrated'))) return;
  const remap = {};
  // 1. Restore per-conversation snapshot copies (they may hold content
  //    that no longer exists in uploads) as CAS files under hash names
  const index = loadConversationsIndex();
  for (const entry of index) {
    const filesDir = path.join(CONVERSATIONS_DIR, entry.id, 'files');
    if (!fs.existsSync(filesDir)) continue;
    for (const snap of fs.readdirSync(filesDir)) {
      if (!/^[a-f0-9]{8}_.+/.test(snap)) continue;
      const dest = path.join(UPLOAD_DIR, snap);
      if (!fs.existsSync(dest)) {
        try { copyFile(path.join(filesDir, snap), dest); } catch (_) {}
      }
    }
  }
  // 2. Rename all legacy uploads (timestamp or raw names) to CAS names,
  //    building an old->new map
  for (const f of listFiles()) {
    if (/^[a-f0-9]{8}_/.test(f.name)) continue;
    try {
      const newName = casName(f.path, f.name);
      const newPath = path.join(UPLOAD_DIR, newName);
      if (fs.existsSync(newPath)) fs.unlinkSync(f.path); // content already stored
      else fs.renameSync(f.path, newPath);
      remap[f.name] = newName;
    } catch (_) {}
  }
  // 3. Remap global config + conversations
  const cfg = loadConfig();
  if (cfg.selectedFiles) cfg.selectedFiles = cfg.selectedFiles.map((n) => remap[n] || n);
  saveConfig(cfg);
  for (const entry of index) {
    const convFile = path.join(CONVERSATIONS_DIR, entry.id, 'conversation.json');
    if (!fs.existsSync(convFile)) continue;
    try {
      const conv = JSON.parse(fs.readFileSync(convFile, 'utf8'));
      if (conv.selectedFiles) conv.selectedFiles = conv.selectedFiles.map((n) => remap[n] || n);
      delete conv.fileSnapshots; // snapshots are obsolete in the CAS model
      fs.writeFileSync(convFile, JSON.stringify(conv, null, 2));
    } catch (_) {}
  }
  fs.writeFileSync(path.join(DATA_DIR, '.cas-migrated'), new Date().toISOString());
}

app.post('/api/files', upload.array('files'), (req, res) => {
  const accepted = []; // newly stored CAS files
  const reused = [];   // existing CAS files matched by identical content
  // Existing files by content hash (exclude the files from THIS request,
  // which multer has already saved to disk before the handler runs)
  const selfPaths = new Set((req.files || []).map((f) => path.resolve(f.path)));
  const existingByHash = new Map();
  for (const f of listFiles()) {
    if (selfPaths.has(path.resolve(f.path))) continue;
    try { existingByHash.set(sha256(f.path), f.name); } catch (_) {}
  }

  for (const f of req.files) {
    let hash = '';
    try { hash = sha256(f.path); } catch (_) {}
    const existingName = existingByHash.get(hash);
    if (existingName) {
      // Identical content already stored — REUSE the existing CAS file
      // (attaching it is the caller's decision; deleting the temp copy)
      try { fs.unlinkSync(f.path); } catch (_) {}
      const full = path.join(UPLOAD_DIR, existingName);
      reused.push({
        name: existingName,
        originalName: f.originalname,
        size: fs.existsSync(full) ? fs.statSync(full).size : 0,
        path: full
      });
      existingByHash.set(hash, existingName); // later batch copies map here too
      continue;
    }
    // New content — rename to content-addressed name: <hash8>_<clean-original>
    const target = casName(f.path, f.originalname);
    const dest = path.join(UPLOAD_DIR, target);
    if (fs.existsSync(dest)) {
      // Same content+name already on disk (race) — reuse it
      try { fs.unlinkSync(f.path); } catch (_) {}
      reused.push({ name: target, originalName: f.originalname, size: fs.statSync(dest).size, path: dest });
      existingByHash.set(hash, target);
      continue;
    }
    fs.renameSync(f.path, dest);
    existingByHash.set(hash, target);
    accepted.push({
      name: target,
      originalName: f.originalname,
      size: f.size,
      path: dest
    });
  }
  res.json({ ok: true, files: accepted, reused });
});

// Apply one RAG selection EVERYWHERE: config + all existing conversations
// (uniform selection across the whole app).
app.post('/api/rag/apply-all', (req, res) => {
  if (!Array.isArray(req.body.selectedFiles)) {
    return res.status(400).json({ error: 'selectedFiles array required' });
  }
  const files = req.body.selectedFiles.map((n) => path.basename(String(n)));
  const cfg = loadConfig();
  cfg.selectedFiles = files;
  saveConfig(cfg);
  const index = loadConversationsIndex();
  let updated = 0;
  for (const entry of index) {
    const convFile = path.join(CONVERSATIONS_DIR, entry.id, 'conversation.json');
    if (!fs.existsSync(convFile)) continue;
    try {
      const conv = JSON.parse(fs.readFileSync(convFile, 'utf8'));
      conv.selectedFiles = files.slice();
      fs.writeFileSync(convFile, JSON.stringify(conv, null, 2));
      updated++;
    } catch (_) { /* skip malformed conversation */ }
  }
  res.json({ ok: true, updatedConversations: updated });
});

function cleanFileName(name) {
  // Strip upload timestamp/id prefix like "1788546314711_"
  return name.replace(/^\d{10,}_/, '');
}

app.delete('/api/files/:name', (req, res) => {
  const name = path.basename(req.params.name);
  const full = path.join(UPLOAD_DIR, name);
  let removedFromConvs = [];
  if (fs.existsSync(full)) {
    fs.unlinkSync(full);
    const cfg = loadConfig();
    if (cfg.selectedFiles) {
      cfg.selectedFiles = cfg.selectedFiles.filter((f) => f !== name);
      saveConfig(cfg);
    }
    // Remove the file from every conversation that attached it
    const index = loadConversationsIndex();
    for (const entry of index) {
      const convFile = path.join(CONVERSATIONS_DIR, entry.id, 'conversation.json');
      if (!fs.existsSync(convFile)) continue;
      try {
        const conv = JSON.parse(fs.readFileSync(convFile, 'utf8'));
        if ((conv.selectedFiles || []).includes(name)) {
          conv.selectedFiles = conv.selectedFiles.filter((f) => f !== name);
          fs.writeFileSync(convFile, JSON.stringify(conv, null, 2));
          removedFromConvs.push(entry.id);
        }
      } catch (_) { /* skip malformed conversation */ }
    }
  }
  res.json({ ok: true, removedFromConversations: removedFromConvs });
});

async function buildPayload(messages, modelIndex, selectedFileList, conversationId, systemOverride) {
  const cfg = loadConfig();
  const models = cfg.models && cfg.models.length
    ? cfg.models
    : [{ name: 'Model 1', endpoint: cfg.endpoint || 'https://ollama.com/api/chat', apiKey: cfg.apiKey || '', model: cfg.model || 'gpt-oss:20b-cloud' }];
  const idx = (modelIndex !== undefined && modelIndex >= 0 && modelIndex < models.length)
    ? modelIndex
    : (cfg.activeModel || 0);
  const m = models[idx] || models[0];
  const endpoint = m.endpoint || 'https://ollama.com/api/chat';
  const apiKey = m.apiKey || '';
  const model = m.model || 'gpt-oss:20b-cloud';

  let systemContent = cfg.systemPrompt || '';
  // Job-search runs use a self-contained prompt and must not inherit the
  // app's RAG system prompt or attached files.
  if (systemOverride !== undefined && systemOverride !== null) {
    systemContent = String(systemOverride);
  }
  // Per-conversation RAG: client sends the file list; fall back to legacy
  // global config. Files are content-addressed (<hash8>_<name>), so a name
  // uniquely identifies its content across all conversations.
  const requested = Array.isArray(selectedFileList) ? selectedFileList : (cfg.selectedFiles || []);
  const resolvedFiles = [];
  for (const raw of requested) {
    const name = path.basename(String(raw));
    if (fs.existsSync(path.join(UPLOAD_DIR, name))) resolvedFiles.push(name);
  }

  if (resolvedFiles.length > 0) {
    let fileBlock = '\n\n--- ATTACHED FILES (RAG) ---\n';
    for (const f of resolvedFiles) {
      try {
        const text = await extractText(path.join(UPLOAD_DIR, f), path.extname(f));
        fileBlock += `\n===== FILE: ${f} =====\n${text}\n===== END OF FILE =====\n`;
      } catch (e) {
        fileBlock += `\n===== FILE: ${f} (could not be read) =====\n`;
      }
    }
    systemContent += fileBlock;
  }

  const payload = {
    model,
    messages: [
      { role: 'system', content: systemContent },
      ...messages
    ],
    stream: false
  };

  return { endpoint, apiKey, model, payload, modelIndex: idx };
}

// ---- Preview (content preview before sending) ----
// ---- Duplicate-offer detection ----
// Normalizes text into a lowercase word-token set (letters/digits only,
// 3+ chars). Token-based Jaccard similarity across that set.
function offerTokens(text) {
  return new Set(String(text).toLowerCase().match(/[a-z\u00e0-\u017f0-9]{3,}/g) || []);
}
function offerSimilarity(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}
// Sliding word 5-grams catch copies whose beginnings differ (different
// headers/intros from another source): containment = shared sequences
// relative to the smaller text, so a partially copied offer still scores high.
function offerNgrams(text, n) {
  const toks = String(text).toLowerCase().match(/[a-z\u00e0-\u017f0-9]{3,}/g) || [];
  const set = new Set();
  for (let i = 0; i + n <= toks.length; i++) set.add(toks.slice(i, i + n).join(' '));
  return set;
}
function offerContainment(a, b, n) {
  const ga = offerNgrams(a, n), gb = offerNgrams(b, n);
  if (!ga.size || !gb.size) return 0;
  const [small, big] = ga.size <= gb.size ? [ga, gb] : [gb, ga];
  let inter = 0;
  for (const g of small) if (big.has(g)) inter++;
  return inter / small.size;
}
// The "offer" is the last user message of the request (what is being
// submitted now). Compared with the first user message of every stored
// conversation. Matches >= 70% are reported.
// Flag parsed bulk offers that are already analyzed in stored conversations.
function flagStoredOffers(offers) {
  const stored = [];
  for (const entry of loadConversationsIndex()) {
    const conv = loadConversation(entry.id);
    if (!conv || !conv.messages || !conv.messages.length) continue;
    const firstUser = conv.messages.find((m) => m.role === "user");
    if (!firstUser) continue;
    stored.push({ id: entry.id, name: entry.name, tokens: offerTokens(firstUser.content), content: firstUser.content });
  }
  for (const o of offers) {
    o.duplicate = null;
    const text = [o.title, o.company, o.description].filter(Boolean).join("\n");
    const cur = offerTokens(text);
    if (cur.size < 15) continue;
    for (const st of stored) {
      const sim = Math.max(offerSimilarity(cur, st.tokens), offerContainment(text, st.content, 5));
      if (sim >= 0.7) {
        o.duplicate = { id: st.id, name: st.name, similarity: Math.round(sim * 100) };
        break;
      }
    }
  }
  return offers;
}

function findDuplicateOffers(currentMsg, currentConvId) {
  const cur = offerTokens(currentMsg);
  if (cur.size < 15) return []; // too short to judge reliably
  const hits = [];
  for (const entry of loadConversationsIndex()) {
    if (currentConvId && entry.id === currentConvId) continue;
    const conv = loadConversation(entry.id);
    if (!conv || !conv.messages || !conv.messages.length) continue;
    const firstUser = conv.messages.find((m) => m.role === 'user');
    if (!firstUser) continue;
    const stored = firstUser.content;
    const sim = Math.max(
      offerSimilarity(cur, offerTokens(stored)),
      offerContainment(currentMsg, stored, 5)
    );
    if (sim >= 0.7) hits.push({ id: entry.id, name: entry.name, similarity: Math.round(sim * 100) });
  }
  return hits.sort((a, b) => b.similarity - a.similarity).slice(0, 5);
}

app.post('/api/preview', async (req, res) => {
  const { messages, modelIndex, selectedFiles, conversationId } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'No messages' });
  }
  try {
    const { endpoint, apiKey, model, payload, modelIndex: idx } = await buildPayload(messages, modelIndex, selectedFiles, conversationId);
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const duplicates = lastUser ? findDuplicateOffers(lastUser.content, conversationId) : [];
    res.json({ endpoint, apiKey, model, payload, modelIndex: idx, duplicates });
  } catch (e) {
    res.status(500).json({ error: 'Could not prepare preview: ' + e.message });
  }
});

// ---- Conversations ----
app.get('/api/conversations', (req, res) => {
  res.json(loadConversationsIndex());
});

// Search conversations by title or message content. Returns index entries
// extended with a match type and a short snippet for body matches.
app.get('/api/conversations/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  const ql = q.toLowerCase();
  const results = [];
  const index = loadConversationsIndex();
  for (const entry of loadConversationsIndex()) {
    const conv = loadConversation(entry.id);
    if (!conv) continue;

    // Title match
    if (String(conv.name || '').toLowerCase().includes(ql)) {
      results.push({ ...entry, matchType: 'title', snippet: null });
      continue;
    }

    // Body match: first message containing the query (assistant first — the
    // useful documents usually live there)
    let snippet = null;
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      const m = conv.messages[i];
      const idx = String(m.content || '').toLowerCase().indexOf(ql);
      if (idx === -1) continue;
      const from = Math.max(0, idx - 60);
      snippet = (from > 0 ? '…' : '') + m.content.slice(from, idx + q.length + 60).replace(/\s+/g, ' ') + '…';
      break;
    }
    if (snippet) results.push({ ...entry, matchType: 'body', snippet });
  }
  res.json(results);
});

app.get('/api/conversations/:id', (req, res) => {
  const conv = loadConversation(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  res.json(conv);
});

app.post('/api/conversations', (req, res) => {
  const { name, messages, selectedFiles, modelIndex, id } = req.body;
  if (!name || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Missing name or messages' });
  }

  const index = loadConversationsIndex();
  const existingId = (id && fs.existsSync(path.join(CONVERSATIONS_DIR, id, 'conversation.json'))) ? id : null;
  const convId = existingId || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
  const convDir = path.join(CONVERSATIONS_DIR, convId);
  fs.mkdirSync(convDir, { recursive: true });
  const filesDir = path.join(convDir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });

  const prev = existingId ? loadConversation(convId) : null;
  const createdAt = prev ? prev.createdAt : new Date().toISOString();

  // RAG files are content-addressed in the shared upload dir — the
  // conversation only stores the name list (names include content hashes).
  const keptFiles = (selectedFiles || [])
    .map((f) => path.basename(String(f)))
    .filter((f) => fs.existsSync(path.join(UPLOAD_DIR, f)));

  // Bump updatedAt ONLY when content actually changed — a plain re-save
  // (e.g. re-browsing the conversation) must not reorder the list.
  const prevJson = prev ? JSON.stringify({ m: prev.messages, f: prev.selectedFiles, n: prev.name, mi: prev.modelIndex }) : null;
  const newJson = JSON.stringify({ m: messages, f: keptFiles, n: name, mi: (modelIndex !== undefined ? modelIndex : null) });
  const changed = !prev || prevJson !== newJson;
  const updatedAt = changed ? new Date().toISOString() : (prev ? prev.updatedAt : createdAt);

  const conv = {
    id: convId,
    name,
    createdAt,
    updatedAt,
    messages,
    selectedFiles: keptFiles,
    modelIndex: (modelIndex !== undefined ? modelIndex : null),
    tags: (prev && prev.tags) ? prev.tags : { matchPct: null, german: null, status: null, satisfactionPct: null }
  };

  // METRYKA auto-extraction for manually driven chats (mirrors bulk analysis):
  // a FRESH reply (last assistant message) carrying a METRYKA block updates the
  // tags and the stored metrics entry. Older METRYKA blocks never overwrite
  // anything on plain re-saves, and manual tag edits survive normal browsing.
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  if (changed && lastAssistant && /METRYKA/i.test(String(lastAssistant.content || ''))) {
    const met = extractMetryka(lastAssistant.content);
    if (met) {
      if (!conv.tags) conv.tags = { matchPct: null, german: null, status: null, satisfactionPct: null };
      if (met.metrics.interview !== null) conv.tags.matchPct = met.metrics.interview;
      if (met.metrics.satisfaction !== null && met.metrics.satisfaction !== undefined) conv.tags.satisfactionPct = met.metrics.satisfaction;
      const store = loadMetrics();
      const existing = store.entries.find((e) => e.convId === convId);
      const meta = deriveOfferMeta(messages);
      const mEntry = {
        convId,
        convName: name,
        createdAt: existing ? existing.createdAt : updatedAt,
        company: (existing && existing.company) || meta.company || '',
        jobTitle: (existing && existing.jobTitle) || meta.jobTitle || '',
        location: (existing && existing.location) || meta.location || '',
        url: (existing && existing.url) || meta.url || '',
        status: (conv.tags && conv.tags.status) || (existing ? existing.status : '') || '',
        metrics: met.metrics,
        raw: met.raw
      };
      if (existing) store.entries[store.entries.indexOf(existing)] = mEntry;
      else store.entries.push(mEntry);
      saveMetrics(store);
    }
  }

  fs.writeFileSync(path.join(convDir, 'conversation.json'), JSON.stringify(conv, null, 2));

  const entry = {
    id: convId,
    name,
    createdAt,
    updatedAt,
    messageCount: messages.length,
    tags: conv.tags
  };
  const filtered = index.filter((c) => c.id !== convId);
  filtered.unshift(entry); // updated/created conversation jumps to the top
  saveConversationsIndex(filtered);

  res.json({ ok: true, id: convId, updatedAt, updated: changed });
});

// ---- Conversation tags (match %, German requirement, not-applying) ----
// Tags live on the conversation object AND on the index entry (so the list
// can render badges without loading every conversation).

function analyzeConversationTags(conv) {
  const assistantTexts = (conv.messages || [])
    .filter((m) => m.role === 'assistant')
    .map((m) => String(m.content || ''));
  // Newest-first: the latest assessment reflects the current state.
  const allTexts = [...assistantTexts].reverse();
  const joined = allTexts.join('\n');

  const tags = { matchPct: null, german: null, status: null, satisfactionPct: null };

  // Match %: first message (newest first) that states an interview chance.
  for (const text of allTexts) {
    const m = text.match(/(?:interview|rozmow[ęe]|screening)[^\n%]{0,80}?(\d{1,3})\s*%/i)
      || text.match(/(?:szans[ęey][^\n%]{0,60}?(?:interview|rozmow))[^\n%]{0,40}?(\d{1,3})\s*%/i);
    if (m) {
      const pct = parseInt(m[1], 10);
      if (pct >= 0 && pct <= 100) { tags.matchPct = pct; break; }
    }
  }

  // German: not required > required (explicit statements win over generic
  // "chances with German B1" analysis, which appears in most sessions).
  if (/niemiecki\s+nie\s+jest\s+wymagan|German\s+not\s+required|kein\s+Deutsch|nie\s+jest\s+wymagan[^.\n]{0,30}niemieck/i.test(joined)) {
    tags.german = 'not_required';
  } else if (/niemieck\w*[^\n]{0,40}(?:wymagan|B1|B2|C1|erforderlich)|Deutsch(?:kenntnisse)?[^\n]{0,30}(?:erforderlich|wymagan)|Bewerbung[^\n]{0,20}Deutsch/i.test(joined)) {
    tags.german = 'required';
  }

  if (/nie\s+aplikuj|nie\s+warto\s+aplikowa|odradzam\s+aplikow|long\s+shot/i.test(joined)) {
    tags.status = 'not_applying';
  }

  // Applied: explicit statements that an application was sent.
  if (/(?:wys[\wa\u0142]{0,7}\s+aplikacj)|(?:za)?aplikowa[\wa\u0142]{0,4}\s+(?:juz|na\s+ta|na\s+to)|(?:sent|submitted)\s+(?:my|the)\s+application|applied\s+(?:already|today|yesterday|via|on|through)/i.test(joined)) {
    if (tags.status !== 'not_applying') tags.status = 'applied';
  }
  return tags;
}

function normalizeTagsInput(body) {
  const out = {};
  if (body.matchPct === null || body.matchPct === '') out.matchPct = null;
  else if (body.matchPct !== undefined) {
    const pct = parseInt(body.matchPct, 10);
    if (isNaN(pct) || pct < 0 || pct > 100) return null;
    out.matchPct = pct;
  }
  if (body.satisfactionPct === null || body.satisfactionPct === '') out.satisfactionPct = null;
  else if (body.satisfactionPct !== undefined) {
    const pct = parseInt(body.satisfactionPct, 10);
    if (isNaN(pct) || pct < 0 || pct > 100) return null;
    out.satisfactionPct = pct;
  }
  if (body.german !== undefined) {
    if (body.german === null || body.german === '') out.german = null;
    else if (['required', 'not_required'].includes(body.german)) out.german = body.german;
    else return null;
  }
  const STATUS_VALUES = ['to_apply', 'applied', 'not_applying'];
  if (body.status !== undefined) {
    if (body.status === null || body.status === '') out.status = null;
    else if (STATUS_VALUES.includes(body.status)) out.status = body.status;
    else return null;
  } else if (body.applied !== undefined && body.notApplying !== undefined) {
    // legacy boolean payload
    out.status = body.applied ? 'applied' : (body.notApplying ? 'not_applying' : null);
  }
  return out;
}

app.post('/api/conversations/:id/tags', (req, res) => {
  const id = req.params.id;
  const conv = loadConversation(id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });

  const patch = normalizeTagsInput(req.body);
  if (!patch) return res.status(400).json({ error: 'Invalid tags payload' });

  const tags = {
    matchPct: patch.matchPct !== undefined ? patch.matchPct : (conv.tags && conv.tags.matchPct !== undefined ? conv.tags.matchPct : null),
    german: patch.german !== undefined ? patch.german : (conv.tags && conv.tags.german !== undefined ? conv.tags.german : null),
    status: patch.status !== undefined ? patch.status : (conv.tags ? (conv.tags.status !== undefined ? conv.tags.status : (conv.tags.applied ? 'applied' : (conv.tags.notApplying ? 'not_applying' : null))) : null),
    // auto-filled from METRYKA (bulk analysis); preserved unless explicitly sent
    satisfactionPct: patch.satisfactionPct !== undefined ? patch.satisfactionPct : (conv.tags && conv.tags.satisfactionPct !== undefined ? conv.tags.satisfactionPct : null),
    manual: true
  };
  conv.tags = tags;
  fs.writeFileSync(path.join(CONVERSATIONS_DIR, id, 'conversation.json'), JSON.stringify(conv, null, 2));

  const index = loadConversationsIndex();
  const entry = index.find((c) => c.id === id);
  if (entry) {
    entry.tags = tags;
    saveConversationsIndex(index);
  }
  // Keep the metrics view in sync (it renders entry.status from metrics.json).
  const mstore = loadMetrics();
  const mentry = mstore.entries.find((en) => en.convId === id);
  if (mentry) {
    mentry.status = tags.status || '';
    mentry.tags = tags;
    saveMetrics(mstore);
  }
  res.json({ ok: true, tags });
});

app.post('/api/conversations/:id/tags/analyze', (req, res) => {
  const conv = loadConversation(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  res.json({ ok: true, suggested: analyzeConversationTags(conv) });
});

app.post('/api/conversations/:id/rename', (req, res) => {
  const { name } = req.body;
  const id = req.params.id;
  if (!name) return res.status(400).json({ error: 'Missing name' });
  const conv = loadConversation(id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });

  conv.name = name;
  fs.writeFileSync(path.join(CONVERSATIONS_DIR, id, 'conversation.json'), JSON.stringify(conv, null, 2));

  const index = loadConversationsIndex();
  const entry = index.find((c) => c.id === id);
  if (entry) entry.name = name;
  saveConversationsIndex(index);

  // Keep the metrics view in sync (renamed conversations must not keep the
  // old convName in metrics.json).
  const mstore = loadMetrics();
  const mentry = mstore.entries.find((en) => en.convId === id);
  if (mentry) {
    mentry.convName = name;
    saveMetrics(mstore);
  }

  res.json({ ok: true });
});

app.delete('/api/conversations/:id', (req, res) => {
  const id = req.params.id;
  const dir = path.join(CONVERSATIONS_DIR, id);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const index = loadConversationsIndex().filter((c) => c.id !== id);
  saveConversationsIndex(index);
  // The metric entry belongs to the conversation — remove it too.
  const mstore = loadMetrics();
  const before = mstore.entries.length;
  mstore.entries = mstore.entries.filter((e) => e.convId !== id);
  if (mstore.entries.length !== before) saveMetrics(mstore);
  res.json({ ok: true });
});

// ---- Application-package export (CV / Cover Letter -> ODT via pandoc) ----
// Output directory: config.exportsDir (set in the sidebar). Empty/missing
// value falls back to <app dir>/moje_dok/odt. A relative path is resolved
// against the app directory; an absolute path is used as-is.
function resolveExportsDir() {
  const cfg = loadConfig();
  const v = String(cfg.exportsDir || '').trim();
  if (!v) return path.join(__dirname, 'moje_dok', 'odt');
  return path.isAbsolute(v) ? v : path.join(__dirname, v);
}

app.post('/api/export-package', async (req, res) => {
  const { conversationId } = req.body || {};
  if (!conversationId) return res.status(400).json({ error: 'Missing conversationId' });

  const conv = loadConversation(conversationId);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });

  // A conversation may hold several CV versions over time (full packages,
  // updates, standalone CV regenerations). For each part (CV / CL_EN / CL_DE)
  // export from the LATEST assistant message that contains it.
  const assistants = conv.messages.filter((m) => m.role === 'assistant');

  // Document extraction is MARKER-based, not level-based: documents inside a
  // chat message are delimited by their own headings (CV, Cover Letter, ...)
  // and the next analysis section, regardless of heading level. Level-based
  // parsing broke in three observed ways: emoji-prefixed headings
  // ("### 📄 CV — ...") did not match, inner H3s (job entries inside an H3
  // "### CV") truncated the body, and H1-delimited documents ("# COVER
  // LETTER") swallowed the assistant's trailing commentary.
  function listHeadings(md) {
    const out = [];
    const re = /^(#{1,6})\s+([^\n]*)/gm;
    let m;
    while ((m = re.exec(md)) !== null) {
      // Normalize: drop emoji/symbols/quotes so "📄 CV" and "CV" are equal
      const norm = m[2].replace(/^[^\p{L}\p{N}]+/u, '').trim();
      out.push({ level: m[1].length, raw: m[2].trim(), norm, index: m.index, end: m.index + m[0].length });
    }
    return out;
  }

  const RE_CV_NUM = /^4a[\s.:-]/i;
  const RE_CV_WORD = /^CV\b/i;
  // The CV H1 is the owner's name line ("# JAN KOWALSKI"). The name MUST be
  // configured (config.ownerName, the sidebar "Owner name" field) — without
  // it the export refuses to run instead of guessing a hardcoded name.
  const ownerName = String((loadConfig().ownerName) || '').trim();
  if (!ownerName) {
    return res.status(422).json({ error: 'Owner name not configured — set "Owner name (for CV detection)" in the sidebar configuration and save it' });
  }
  const ownerLast = ownerName.split(/\s+/).pop();
  const RE_CV_H1 = new RegExp('^(?:' + ownerName.split(/\s+/).join('\\s+') + '|' + ownerLast + ')\\b', 'i');
  // "## 4. CV (...)" — numbered package section carrying the CV
  const RE_CV_SECTION = /^\d+\s*[.)][^\n]*\bCV\b/i;
  const RE_CL = /^(?:4b[\s.:-]|4c[\s.:-]|Cover\s*Letter|Anschreiben|Bewerbungsschreiben)/i;
  const RE_NUM_SECTION = /^\d+\s*[.)]/;

  const isCvStart = (h) => RE_CV_NUM.test(h.norm) || RE_CV_WORD.test(h.norm)
    || (h.level <= 3 && RE_CV_SECTION.test(h.norm))
    || (h.level === 1 && RE_CV_H1.test(h.norm));
  const isClStart = (h) => RE_CL.test(h.norm);
  // Language of a cover-letter heading: strong German markers only. Weak
  // stems like "niemieck-" would false-positive on headings such as
  // "Cover Letter (po angielsku, ... wersja niemiecka nie jest wymagana)",
  // so require exact "niemiecki"/"po niemiecku" and drop DE when an explicit
  // English marker is present. German-letter headings (Anschreiben,
  // Bewerbungsschreiben) are DE by definition.
  const RE_CL_DE = /\bDE\b|Deutsch|German\b|po niemiecku|niemiecki\b/i;
  const RE_CL_EN = /\bEN\b|English|angielsku|angielski/i;
  const isLangDe = (h) => (RE_CL_DE.test(h.norm) && !RE_CL_EN.test(h.norm))
    || /^Bewerbungsschreiben|^Anschreiben/i.test(h.norm);
  const isNumberedH2 = (h) => h.level === 2 && RE_NUM_SECTION.test(h.norm);
  // The owner's name line inside a cover letter (sender block at the top,
  // signature at the bottom — often a bold `**NAME**` line promoted to H1 by
  // normalizeDocMarkers) is part of the letter, not a document boundary. It
  // only counts as a boundary when a real sub-headed document follows it
  // (i.e. it titles a CV placed after the letter).
  const isOwnerH1 = (h) => h.level === 1 && RE_CV_H1.test(h.norm);
  const isBareOwnerH1 = (h, i, all) => {
    if (!isOwnerH1(h)) return false;
    const nxt = all[i + 1];
    return !nxt || isClStart(nxt) || isNumberedH2(nxt);
  };

  // Slice a document out of a message: body from the first heading matching
  // `start` until the first later heading matching one of the `stop` rules.
  // An enclosing code fence around the document body (```markdown ... ```)
  // is stripped so pandoc does not render literal fence lines.
  // `refine` optionally moves the start forward to a later heading (e.g. the
  // owner's H1 name line) — used when the CV section heading carries an
  // editorial preamble that must not end up in the exported document.
  function extractDoc(md, start, stops, refine) {
    const heads = listHeadings(md);
    const fromIdx = heads.findIndex(start);
    if (fromIdx === -1) return null;
    let stopIdx = heads.length;
    for (let i = fromIdx + 1; i < heads.length; i++) {
      if (stops.some((s) => s(heads[i], i, heads))) { stopIdx = i; break; }
    }
    let startAt = heads[fromIdx].end;
    if (refine) {
      for (let i = fromIdx + 1; i < stopIdx; i++) {
        if (refine(heads[i])) { startAt = heads[i].index; break; }
      }
    }
    const to = stopIdx < heads.length ? heads[stopIdx].index : md.length;
    let body = md.slice(startAt, to).trim();
    const fence = body.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```?\s*$/i);
    if (fence) body = fence[1].trim();
    return body;
  }

  // CV stops at a cover-letter heading or the next numbered analysis section
  // ("## 5. ..."); inner headings (job entries, H1 name line) belong to the CV.
  const extractCv = (md) => extractDoc(md, isCvStart, [isClStart, isNumberedH2],
    (h) => h.level === 1 && RE_CV_H1.test(h.norm));
  // A cover letter contains no headings of its own, so ANY next heading that
  // is not another cover-letter marker ends it (drops trailing commentary).
  // A cover-letter heading of the OTHER language also ends it, so the EN
  // letter never swallows the DE letter that follows it in the same package.
  const extractCl = (md, wantDe) => extractDoc(
    md,
    (h) => isClStart(h) && (wantDe ? isLangDe(h) : !isLangDe(h)),
    [(h, i, all) => !isClStart(h) && !isBareOwnerH1(h, i, all), (h) => isClStart(h) && (wantDe ? !isLangDe(h) : isLangDe(h))]
  );

  // Models sometimes wrap the whole answer in a ```markdown fence — strip it
  // so headings/H1 detection work on the content itself.
  function unwrapCodeFence(md) {
    const t = md.trim();
    const m = t.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```?\s*$/);
    return m ? m[1] : md;
  }

  // Models also mark document boundaries with BOLD lines instead of headings
  // ("**JAN KOWALSKI**", "**COVER LETTER (English)**"). Promote exactly those
  // lines to headings so the extractors see them; the replacement keeps the
  // original bold text in the body (only the "# "/"## " prefix is inserted).
  const escOwner = ownerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function normalizeDocMarkers(md) {
    return md
      .replace(/^[ \t]*\*\*(Cover\s*Letter\b[^*\n]*)\*\*[ \t]*$/gim, '## **$1**')
      .replace(new RegExp('^[ \\t]*\\*\\*(' + escOwner + ')\\s*\\*\\*[ \\t]*$', 'gim'), '# **$1**');
  }

  const prepMd = (m) => normalizeDocMarkers(unwrapCodeFence(m.content || ''));

  const msgHasCv = (m) => extractCv(prepMd(m)) !== null;
  const msgHasCl = (m, wantDe) => extractCl(prepMd(m), wantDe) !== null;

  const latest = (pred) => [...assistants].reverse().find(pred);

  // Every part is taken from the LATEST assistant message containing it, so
  // the newest version always wins.
  const cvMsg = latest(msgHasCv);
  const clEnMsg = latest((m) => msgHasCl(m, false));
  const clDeMsg = latest((m) => msgHasCl(m, true));
  if (!cvMsg && !clEnMsg && !clDeMsg) {
    return res.status(422).json({
      error: 'No application package (CV + Cover Letter) found in this conversation'
    });
  }

  // Title from the newest message that has one
  const escOwnerLast = ownerLast.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const titleMsg = [cvMsg, clEnMsg, clDeMsg].filter(Boolean)
    .find((m) => /^#\s+(?:Pakiet|PAKIET|AKTUALIZACJA)/im.test(m.content) || new RegExp('^#\\s+.*' + escOwnerLast, 'im').test(m.content));
  const title = ((titleMsg || cvMsg || { content: '' }).content.match(/^#\s+(?:Pakiet|PAKIET|AKTUALIZACJA|Zaktualizowany|Zaktualizowana)[^\n]*/im)
    || (titleMsg || cvMsg || { content: '' }).content.match(new RegExp('^#\\s+.*' + escOwnerLast + '[^\\n]*', 'im'))
    || ['Application package'])[0].replace(/^#\s+/i, '');

  const pandoc = await new Promise((resolve) => {
    execFile('pandoc', ['--version'], (err) => resolve(!err));
  });
  if (!pandoc) {
    return res.status(500).json({ error: 'pandoc not found on this system' });
  }

  // Cover letters end with a signature block (sign-off line + name, possibly
  // contact details). Models often add commentary AFTER the letter but before
  // the next heading — cut the body after the signature block: from the last
  // sign-off line, keep only empty/name/contact lines and drop the rest.
  function trimAfterSignature(body) {
    const lines = body.split('\n');
    let signOff = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      // blockquote letters sign off as "> Mit freundlichen Grüßen"
      if (/^\s*(?:>\s*)*(?:kind|best|warm|with\s+)?\s*regards\b|^\s*(?:>\s*)*sincerely\b|^\s*(?:>\s*)*mit\s+freundlichen\s+grüßen|^\s*(?:>\s*)*z\s+poważaniem|^\s*(?:>\s*)*viele\s+grüße/i.test(lines[i])) {
        signOff = i;
        break;
      }
    }
    if (signOff === -1) return body;
    let cut = lines.length;
    const sigRe = new RegExp(ownerLast.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '|@|\\+49|linkedin|github|hamburg|germany|deutschland|poland', 'i');
    for (let i = signOff + 1; i < Math.min(signOff + 6, lines.length); i++) {
      const l = lines[i].trim();
      if (l === '' || sigRe.test(l)) cut = i + 1;
      else break;
    }
    return lines.slice(0, cut).join('\n').trimEnd();
  }

  // File names start with the conversation name
  const safeName = String(conv.name || 'conversation')
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 60);
  const outDir = resolveExportsDir();
  try {
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.accessSync(outDir, fs.constants.W_OK);
  } catch (e) {
    return res.status(500).json({
      error: `Export directory is not available: ${outDir} — check the path (or clear it for the default) in the sidebar configuration, then retry. (${e.message})`
    });
  }

  // Standalone CV (regenerated outside a package): extractDoc starts at the
  // owner's "# JAN KOWALSKI" H1, so the chatty intro before it is already
  // dropped and no separate slicing is needed.

  // Remove AI-typical em dashes: "word — word" -> "word - word"
  function stripEmDashes(text) {
    return text.replace(/—/g, '-').replace(/–/g, '-');
  }

  const mdOf = (m) => (m ? m.content : '');
  const cvFromPkg = cvMsg ? extractCv(prepMd(cvMsg)) : null;
  const clEnRaw = clEnMsg ? extractCl(prepMd(clEnMsg), false) : null;
  const clDeRaw = clDeMsg ? extractCl(prepMd(clDeMsg), true) : null;
  const parts = [
    ['CV', cvFromPkg, 'CV'],
    ['CoverLetter_EN', clEnRaw == null ? null : trimAfterSignature(clEnRaw), 'cover'],
    ['CoverLetter_DE', clDeRaw == null ? null : trimAfterSignature(clDeRaw), 'Anschreiben'],
  ];
  // A part whose heading exists but whose body is empty is reported, never
  // silently skipped (previously an empty section just vanished from output).
  const emptyPartKinds = [
    ['CV', cvFromPkg],
    ['CoverLetter_EN', clEnRaw],
    ['CoverLetter_DE', clDeRaw],
  ].filter((p) => p[1] !== null && !String(p[1]).trim()).map((p) => p[0]);
  const kindFile = (kind) => { for (const p of parts) if (p[0] === kind) return p[2] || kind; return kind; };

  // Segoe UI reference doc: the 2023/24 Calibri redesign ships a contextual
  // "ti"/"fi" ligature that LibreOffice's PDF export/print path renders with a
  // zero-advance glyph (letters visually fuse). Segoe UI has no such ligature
  // and exports cleanly. Falls back to the Calibri doc if missing.
  const refDoc = path.join(__dirname, 'tools',
    fs.existsSync(path.join(__dirname, 'tools', 'reference-segoui.odt'))
      ? 'reference-segoui.odt' : 'reference-calibri.odt');

  // Re-exporting the SAME content must not create a new indexed version.
  // A per-conversation manifest maps each part to the content hash of its
  // last export; identical content reuses the existing file. The manifest is
  // keyed by the conversation ID (stable across renames), so two different
  // conversations never share export state even when their file names are
  // similar.
  const manifestPath = path.join(outDir, conversationId + '.manifest.json');
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* first export */ }
  const contentHash = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);

  const exported = [];
  const reused = [];
  const tmpFiles = [];

  // Pandoc's ODT writer emits table cells with fo:border="none" — patch
  // content.xml inside the .odt so tables get visible borders.
  async function addTableBorders(odtPath) {
    const zip = await JSZip.loadAsync(fs.readFileSync(odtPath));
    const content = zip.file('content.xml');
    if (!content) return;
    let xml = await content.async('string');
    const patched = xml.replace(
      /(<style:style style:name="(?:TableHeaderRowCell|TableRowCell)" style:family="table-cell">\s*<style:table-cell-properties)\s+fo:border="none"\s*\/>/g,
      '$1 fo:border="0.5pt solid #000000" fo:padding="0.04in" />'
    );
    if (patched !== xml) {
      zip.file('content.xml', patched);
      // Write in memory and overwrite in place — rename() onto a file that
      // pandoc just wrote can hit EPERM on Windows (AV scanner lock).
      const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      fs.writeFileSync(odtPath, buf);
    }
  }

  try {
    let manifestDirty = false;
    const failed = emptyPartKinds.map((k) => `${k}: section heading found but the body is empty`);
    for (const [kind, content] of parts) {
      if (!content) continue;
      const hash = contentHash(stripEmDashes(content));
      if (manifest[kind] && manifest[kind].hash === hash && fs.existsSync(path.join(outDir, manifest[kind].file))) {
        // Same content as last export -> reuse the existing file
        exported.push(manifest[kind].file);
        reused.push(manifest[kind].file);
        continue;
      }
      const base = `${safeName}_${kindFile(kind)}`;
      const mdTmp = path.join(outDir, base + '.md');
      try {
        fs.writeFileSync(mdTmp, `# ${stripEmDashes(title)}\n\n${stripEmDashes(content)}`, 'utf8');
        tmpFiles.push(mdTmp);
        const odt = path.join(outDir, base + '.odt');
        const args = [mdTmp, '--from=gfm'];
        if (fs.existsSync(refDoc)) args.push(`--reference-doc=${refDoc}`);
        args.push('-o', odt);
        await new Promise((resolve, reject) => {
          execFile('pandoc', args, (err) => (err ? reject(err) : resolve()));
        });
        await addTableBorders(odt);
        if (fs.existsSync(odt)) {
          exported.push(path.basename(odt));
          manifest[kind] = { hash, file: path.basename(odt) };
          manifestDirty = true;
        } else {
          failed.push(`${kind}: pandoc produced no output`);
        }
      } catch (eInner) {
        // Write/conversion failure — often a Windows file lock (LibreOffice,
        // antivirus) on the target name. Retry once with a timestamped name.
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        const altBase = `${base}_${stamp}`;
        const mdAlt = path.join(outDir, altBase + '.md');
        const odtAlt = path.join(outDir, altBase + '.odt');
        try {
          fs.writeFileSync(mdAlt, `# ${stripEmDashes(title)}\n\n${stripEmDashes(content)}`, 'utf8');
          tmpFiles.push(mdAlt);
          const args = [mdAlt, '--from=gfm'];
          if (fs.existsSync(refDoc)) args.push(`--reference-doc=${refDoc}`);
          args.push('-o', odtAlt);
          await new Promise((resolve, reject) => {
            execFile('pandoc', args, (err) => (err ? reject(err) : resolve()));
          });
          await addTableBorders(odtAlt);
          if (fs.existsSync(odtAlt)) {
            exported.push(path.basename(odtAlt));
            manifest[kind] = { hash, file: path.basename(odtAlt) };
            manifestDirty = true;
          } else {
            failed.push(`${kind}: ${eInner.message}`);
          }
        } catch (eRetry) {
          failed.push(`${kind}: ${eRetry.message}`);
        }
      }
    }
    if (manifestDirty) fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    if (failed.length) {
      return res.status(207).json({
        ok: true,
        exported,
        reused,
        failed,
        outDir: resolveExportsDir()
      });
    }
  } catch (e) {
    return res.status(500).json({ error: 'Pandoc conversion failed: ' + e.message });
  } finally {
    for (const t of tmpFiles) { try { fs.unlinkSync(t); } catch { /* ignore */ } }
  }

  if (!exported.length) {
    return res.status(422).json({ error: 'No CV/CoverLetter sections found in the package' });
  }
  res.json({ ok: true, exported, reused, outDir: resolveExportsDir() });
});

// ---- Bulk analysis (offer file -> parsed offers -> automated conversations) ----
const METRICS_FILE = path.join(DATA_DIR, 'metrics.json');

function loadMetrics() {
  if (fs.existsSync(METRICS_FILE)) {
    try { return JSON.parse(fs.readFileSync(METRICS_FILE, 'utf8')); } catch (e) { return { entries: [] }; }
  }
  return { entries: [] };
}

function saveMetrics(m) {
  fs.writeFileSync(METRICS_FILE, JSON.stringify(m, null, 2));
}

// Auto-fill satisfactionPct tags from stored METRYKA entries (one pass at boot).
// Repair stale metrics entries: convName captured before a rename keeps the
// default "Conversation" (rename did not sync metrics.json in older versions);
// missing company/jobTitle are derived from the offer text or the conversation
// name; missing status comes from the conversation tags.
function backfillMetricsConvNames() {
  try {
    const store = loadMetrics();
    if (!store.entries || !store.entries.length) return;
    // Drop entries whose conversation no longer exists (deleted chats).
    const alive = store.entries.filter((e) => fs.existsSync(path.join(CONVERSATIONS_DIR, e.convId, 'conversation.json')));
    let changed = false;
    if (alive.length !== store.entries.length) {
      console.log('removed ' + (store.entries.length - alive.length) + ' orphaned metric entries');
      store.entries = alive;
      changed = true;
    }
    const index = loadConversationsIndex();
    for (const e of store.entries) {
      const entry = index.find((c) => c.id === e.convId);
      if (!entry) continue;
      const stale = !e.convName || e.convName === 'Conversation' || /^Conversation \d{1,2}\//.test(e.convName);
      if (stale && entry.name && entry.name !== e.convName) {
        e.convName = entry.name;
        changed = true;
      }
      if (!e.status || !e.company || !e.jobTitle) {
        const conv = loadConversation(e.convId);
        if (!conv) continue;
        if (!e.status && conv.tags && conv.tags.status) {
          e.status = conv.tags.status;
          changed = true;
        }
        if (!e.company || !e.jobTitle) {
          const meta = deriveOfferMeta(conv.messages || []);
          if (!e.jobTitle && meta.jobTitle) { e.jobTitle = meta.jobTitle; changed = true; }
          if (!e.company) {
            const firstText = String(((conv.messages || []).find((m) => m.role === 'user') || {}).content || '');
            // LinkedIn paste ("job requisition id" / "posted on"): the second
            // line is a city, not the company — use the description or name.
            const linkedinPaste = /job requisition id|^posted on$/im.test(firstText);
            let company = linkedinPaste ? '' : meta.company;
            if (!company) {
              const mm = firstText.match(/\b([A-Z][\w&.'\-]*(?:[ \t]+[A-Z][\w&.'\-]*){0,3})[ \t]+(?:is|are)[ \t]+looking to hire/);
              if (mm) company = mm[1].trim();
            }
            if (!company) {
              const head = String(entry.name || '').split(/\s*[-\u2014|]\s*/)[0].trim();
              if (head && head.length <= 40 && /[A-Za-z]/.test(head)) company = head;
            }
            if (company) { e.company = company.slice(0, 120); changed = true; }
          }
        }
      }
    }
    if (changed) { saveMetrics(store); console.log('metrics entries backfilled (convName/company/jobTitle/status)'); }
  } catch (e) {
    console.log('metrics backfill skipped: ' + e.message);
  }
}

function backfillSatisfactionTags() {
  try {
    const store = loadMetrics();
    if (!store.entries || !store.entries.length) return;
    const index = loadConversationsIndex();
    let indexChanged = false;
    for (const e of store.entries) {
      if (!e.metrics || e.metrics.satisfaction === null || e.metrics.satisfaction === undefined) continue;
      const conv = loadConversation(e.convId);
      if (!conv) continue;
      if (!conv.tags) conv.tags = { matchPct: null, german: null, status: null, satisfactionPct: null };
      if (conv.tags.satisfactionPct === undefined) conv.tags.satisfactionPct = null;
      const missing = conv.tags.satisfactionPct === null;
      if (missing) {
        conv.tags.satisfactionPct = e.metrics.satisfaction;
        fs.writeFileSync(path.join(CONVERSATIONS_DIR, e.convId, 'conversation.json'), JSON.stringify(conv, null, 2));
      }
      const entry = index.find((c) => c.id === e.convId);
      if (entry && JSON.stringify(entry.tags) !== JSON.stringify(conv.tags)) {
        entry.tags = conv.tags;
        indexChanged = true;
      }
    }
    if (indexChanged) saveConversationsIndex(index);
    console.log('satisfaction tags backfilled from metrics.json');
  } catch (e) {
    console.log('satisfaction backfill skipped: ' + e.message);
  }
}

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--([\s\S]*?)-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeEntities(t) {
  return String(t).replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
}

// Split a LinkedIn HTML snapshot file into per-offer chunks: each offer
// snapshot contains exactly one "jobs-search__job-details--wrapper" block.
function splitHtmlOffers(text) {
  const marker = 'jobs-search__job-details--wrapper';
  const positions = [];
  let i = text.indexOf(marker);
  while (i !== -1) { positions.push(i); i = text.indexOf(marker, i + marker.length); }
  if (positions.length <= 1) return positions.length === 1 ? [text] : [];
  const chunks = [];
  for (let k = 0; k < positions.length; k++) {
    const start = k === 0 ? 0 : Math.max(0, positions[k] - 200);
    const end = k === positions.length - 1 ? text.length : Math.max(0, positions[k + 1] - 200);
    chunks.push(text.slice(start, end));
  }
  return chunks;
}

// Parse one LinkedIn HTML offer chunk into metadata + description.
function parseHtmlOffer(chunk) {
  let title = '';
  let m = chunk.match(/aria-label="([^"]{3,150})"\s+class="jobs-search__job-details--container/);
  if (m) title = decodeEntities(m[1]);
  if (!title) {
    m = chunk.match(/<h1[^>]*>[\s\S]{0,400}?<a[^>]*>([^<]{3,150})<\/a>[\s\S]{0,40}?<\/h1>/);
    if (m) title = decodeEntities(m[1].trim());
  }
  if (!title) {
    m = chunk.match(/top-card__job-title[\s\S]{0,300}?<a[^>]*>([^<]{3,150})</);
    if (m) title = decodeEntities(m[1].trim());
  }

  let company = '';
  m = chunk.match(/top-card__company-name[\s\S]{0,900}?<a[^>]*>[\s\S]{0,200}?>([\s\S]{2,120}?)<\/a>/);
  if (m) company = decodeEntities(m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());

  let location = '';
  m = chunk.match(/top-card__primary-description[\s\S]{0,600}?tvm__text[^>]*>(?:<!---->)?([^<>]{2,120}?)(?:<!---->)?</);
  if (m) location = decodeEntities(m[1].trim());
  if (!location) {
    m = chunk.match(/top-card__bullet[\s\S]{0,300}?<[^>]*>([\s\S]{2,120}?)</);
    if (m) location = decodeEntities(m[1].replace(/<[^>]+>/g, " ").trim());
  }

  let url = '';
  m = chunk.match(/<a[^>]+href="((?:https:\/\/www\.linkedin\.com)?\/jobs\/view\/[^"#?]+)/);
  if (m) url = m[1].startsWith('http') ? m[1] : ('https://www.linkedin.com' + m[1]);

  // Description: text after the last "About the job" heading (most robust).
  let descHtml = null;
  const idx = chunk.toLowerCase().lastIndexOf("about the job");
  if (idx !== -1) descHtml = chunk.slice(idx);
  let description = descHtml ? htmlToText(descHtml) : "";
  // Cut trailing LinkedIn page chrome that follows the real description
  // (marker search on a whitespace-flattened copy, markers span line breaks).
  const cutMarkers = ['Company photos', 'Report this job', 'Was this job', 'Get AI-powered advice',
    "Don't miss this job", 'Page 1 of', 'Previous Next', 'Show less', 'Interested in working for our company',
    "I'm interested", 'Learn more about', 'Meet your hiring team', 'Learn more', 'Apply now', 'Save job',
    'Report job', 'Show all'];
  const flat = description.replace(/\s+/g, ' ');
  let cutAt = flat.length;
  for (const cut of cutMarkers) {
    const ci = flat.indexOf(cut);
    if (ci > 200 && ci < cutAt) cutAt = ci;
  }
  description = flat.slice(0, cutAt).trim();
  return { title, company, location, url, status: '', workplace: '', salary: '', savedAt: '', description };
}

// Plain-text offer format produced by the extension "Copy" button:
//   title \n company \n location \n url \n --- \n description
// ---- CSV (LinkedIn extension export) ----
// RFC-4180-ish split: handles "..." quoting with "" escapes.
function parseCsvLines(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === "\u0022") {
        if (text[i + 1] === "\u0022") { field += "\u0022"; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === "\u0022") inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim().length));
}

function parseCsvOffers(text) {
  const clean = String(text).replace(/^\uFEFF/, "");
  const rows = parseCsvLines(clean);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  const col = (name) => head.findIndex((h) => h.toLowerCase() === name);
  const iT = col("title"), iC = col("company"), iL = col("location"),
    iU = col("url"), iD = col("descriptiontext"), iS = col("status"),
    iW = col("workplacetype"), iSA = col("savedat"), iSAL = col("salary");
  if (iT === -1 && iC === -1) return [];
  const offers = [];
  for (const r of rows.slice(1)) {
    const description = (iD >= 0 ? r[iD] || "" : "").trim();
    if (description.length < 100) continue;
    offers.push({
      title: (iT >= 0 ? r[iT] : '') || '',
      company: (iC >= 0 ? r[iC] : '') || '',
      location: (iL >= 0 ? r[iL] : '') || '',
      status: (iS >= 0 ? r[iS] : '') || '',
      workplace: (iW >= 0 ? r[iW] : '') || '',
      salary: (iSAL >= 0 ? r[iSAL] : '') || '',
      savedAt: (iSA >= 0 ? r[iSA] : '') || '',
      url: (iU >= 0 ? r[iU] : '') || '',
      description
    });
  }
  return offers;
}

// LinkedIn extension "Export JSON": { saved: [...], seen: [...] } (or a bare
// array). Job objects carry workplaceType / salary / status / savedAt.
function parseJsonOffers(text) {
  let data;
  try { data = JSON.parse(String(text).replace(/^\uFEFF/, "")); } catch (e) { return []; }
  let jobs = [];
  if (Array.isArray(data)) jobs = data;
  else if (data && Array.isArray(data.saved)) jobs = data.saved;
  else if (data && Array.isArray(data.jobs)) jobs = data.jobs;
  const offers = [];
  for (const j of jobs) {
    const description = String(j.descriptionText || "").trim();
    if (description.length < 100) continue;
    const wt = String(j.workplaceType || "");
    offers.push({
      title: j.title || '',
      company: j.company || '',
      location: j.location || '',
      url: j.url || (j.jobId ? "https://www.linkedin.com/jobs/view/" + j.jobId + "/" : ""),
      status: j.status || '',
      workplace: wt,
      salary: j.salary || '',
      savedAt: j.savedAt || '',
      description
    });
  }
  return offers;
}
function parsePlainOffers(text) {
  const parts = String(text).split(/^\s*-{3,}\s*$/m);
  const offers = [];
  for (let k = 0; k + 1 < parts.length; k += 2) {
    const head = parts[k].trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const description = (parts[k + 1] || "").trim();
    if (!head.length || description.length < 100) continue;
    let url = "";
    for (const l of head) if (/^https?:\/\//.test(l)) { url = l; break; }
    offers.push({ title: head[0] || '', company: head[1] || '', location: head[2] || '', url, status: '', workplace: '', salary: '', savedAt: '', description });
  }
  return offers;
}

// ---- Job search (internet) ----
// Hybrid design: the server fetches real offers from public, keyless job
// APIs/RSS, pre-filters them locally, then the configured AI model selects
// and annotates the matches (language, reason). The AI never invents offers:
// every returned id is cross-checked against the fetched pool.
const JOB_FETCH_TIMEOUT_MS = 15000;
const JOB_HOST_DELAY_MS = 1200;      // pacing between requests to one host
const JOB_SOURCE_GAP_MS = 800;       // pacing between sources
const JOB_MAX_POOL = 150;            // candidates sent to the AI (cap)
const JOB_MAX_RESULTS = 40;          // offers kept in the final file
const JOB_AI_BATCH = 25;             // candidates per AI call
const JOB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Offline sample source: deterministic, used by the UI demo and tests.
const JOB_SAMPLE_OFFERS = [
  { title: 'Team Lead Software (AI)', company: 'Sample Hamburg GmbH', location: 'Hamburg, Germany', workplace: 'onsite', url: 'https://example.com/sample/1', applyUrl: 'https://example.com/sample/1', salary: '€90-110k', savedAt: '2026-09-01', description: 'We are looking for a team lead software engineer to build AI-driven products with a team of eight. English working language, no German required. You will own architecture, coach engineers and ship LLM-based features.' },
  { title: 'Senior Python Engineer, Remote EU', company: 'Sample Remote Ltd', location: 'Europe (Remote)', workplace: 'remote', url: 'https://example.com/sample/2', applyUrl: 'https://example.com/sample/2', salary: '', savedAt: '2026-09-02', description: 'Fully remote Python role for the EU. You will design FastAPI services integrated with local LLMs. German is a plus, not required. Apply through our careers portal with a CV in English.' },
  { title: 'Embedded Software Lead', company: 'Sample Poznan Sp. z o.o.', location: 'Poznan, Poland', workplace: 'hybrid', url: 'https://example.com/sample/3', applyUrl: 'https://example.com/sample/3', salary: '', savedAt: '2026-09-03', description: 'Lead the embedded team in Poznan. C/C++ on Jetson, YOLO pipelines and AI-assisted development. Communication in English; German not required. Send your application via the link.' },
  { title: 'Architekt Systemow Wbudowanych', company: 'Sample Warszawa S.A.', location: 'Warsaw, Poland', workplace: 'onsite', url: 'https://example.com/sample/4', applyUrl: 'https://example.com/sample/4', salary: '', savedAt: '2026-09-04', description: 'Poszukujemy architekta systemow wbudowanych do zespolu 15 osob. Praca z AI, lokalnymi modelami LLM i gateway FastAPI. Jezyk angielski wymagany, niemiecki nie jest wymagany. Aplikuj przez formularz.' },
  { title: 'Machine Learning Engineer', company: 'Sample AI BV', location: 'Amsterdam, Netherlands', workplace: 'hybrid', url: 'https://example.com/sample/5', applyUrl: 'https://example.com/sample/5', salary: '', savedAt: '2026-09-05', description: 'ML engineering role focused on computer vision and edge deployment. Hybrid from Amsterdam, four days remote. English-only workplace, German not needed. Apply with a short motivation letter.' },
  { title: 'Engineering Manager, Platform', company: 'Sample Cloud Inc', location: 'Worldwide (Remote)', workplace: 'remote', url: 'https://example.com/sample/6', applyUrl: 'https://example.com/sample/6', salary: '', savedAt: '2026-09-06', description: 'Remote engineering manager for a platform team. You will mentor 10 engineers, run hiring and set the roadmap. Fully English environment. Apply online, no German required.' },
  { title: 'Senior Backend Developer', company: 'Sample Berlin UG', location: 'Berlin, Germany', workplace: 'hybrid', url: 'https://example.com/sample/7', applyUrl: 'https://example.com/sample/7', salary: '', savedAt: '2026-09-07', description: 'Backend role in Berlin with German required at B2 level for customer communication. Node.js and Postgres. Hybrid, two office days. Please apply in German with a German CV.' },
  { title: 'AI Solutions Consultant', company: 'Sample Muenchen GmbH', location: 'Munich, Germany', workplace: 'onsite', url: 'https://example.com/sample/8', applyUrl: 'https://example.com/sample/8', salary: '', savedAt: '2026-09-08', description: 'Consulting role delivering AI solutions to enterprise clients. Fluent German required. English is the internal language. Onsite in Munich, travel up to 30 percent. Apply by email.' }
];
function normalizeJobSample() { return JOB_SAMPLE_OFFERS.map((o) => Object.assign({ source: 'sample' }, o)); }

const sampleFetcher = async () => ({ ok: true, status: 200, json: async () => ({}) });

// ---- JSON-LD JobPosting extraction (XING / Stepstone / NoFluffJobs) ----
// Those portals have no open API, but every offer detail page embeds a
// schema.org JobPosting in <script type="application/ld+json">. We scrape the
// listing page for links, then read each detail's JSON-LD (throttled).
function parseJsonLdJobPostings(html) {
  const out = [];
  const re = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node['@type'] === 'JobPosting') out.push(node);
    if (Array.isArray(node['@graph'])) node['@graph'].forEach(visit);
  };
  while ((m = re.exec(html))) {
    let data;
    try { data = JSON.parse(m[1]); } catch (_) { continue; }
    visit(data);
  }
  return out;
}

function jsonLdSalary(jp) {
  const b = jp.baseSalary;
  if (!b) return '';
  const v = b.value || {};
  const cur = b.currency || v.currency || '';
  const min = v.minValue, max = v.maxValue, val = v.value;
  const unit = v.unitText ? ' / ' + String(v.unitText).toLowerCase() : '';
  if (min != null && max != null) return min + '-' + max + ' ' + cur + unit;
  if (val != null) return val + ' ' + cur + unit;
  return '';
}

function jsonLdLocation(jp) {
  const locs = Array.isArray(jp.jobLocation) ? jp.jobLocation : (jp.jobLocation ? [jp.jobLocation] : []);
  const parts = [];
  for (const l of locs) {
    const a = (l && l.address) || {};
    const s = [a.addressLocality, a.addressRegion, a.addressCountry].filter(Boolean).join(', ');
    if (s) parts.push(s);
  }
  return parts.join(' | ');
}

function normalizeJsonLdOffer(jp, source, fallbackUrl) {
  if (!jp || !jp.title) return null;
  const description = offerHtmlToText(jp.description);
  if (description.length < 100) return null;
  const locType = String(jp.jobLocationType || '');
  const loc = jsonLdLocation(jp);
  const remote = /telecommute/i.test(locType) || /remote|homeoffice|home office|zdaln/i.test(loc) || /remote/i.test(String(jp.title || ''));
  return {
    source,
    title: offerClean(jp.title, 160),
    company: offerClean((jp.hiringOrganization && jp.hiringOrganization.name) || '', 120),
    location: offerClean(loc || (remote ? 'Remote' : ''), 120),
    workplace: remote ? 'remote' : 'onsite',
    url: offerClean(jp.url || fallbackUrl, 500),
    applyUrl: offerClean(jp.url || fallbackUrl, 500),
    salary: offerClean(jsonLdSalary(jp), 120),
    savedAt: offerClean(jp.datePosted, 20),
    description
  };
}

// Generic "listing -> detail JSON-LD" harness, rate-limited per the user's
// request (sequential detail fetches with a delay to avoid portal blocks).
const JOB_HTML_MAX_DETAILS = 12;
async function jobFetchHtmlSource(src, criteria, ctx) {
  const kw = (criteria.keywords || '').split(/\s+/).filter(Boolean).slice(0, 3).join(' ');
  const listingUrl = src.listing(criteria, kw);
  const html = await ctx.getText(listingUrl);
  const links = [];
  const seen = new Set();
  const re = new RegExp(src.linkRe, 'gi');
  let m;
  while ((m = re.exec(html))) {
    let u = m[1] || m[0];
    if (!/^https?:/i.test(u)) u = src.base + u;
    u = u.split('#')[0].split('?')[0];
    if (seen.has(u)) continue;
    seen.add(u);
    links.push(u);
    if (links.length >= (src.maxDetails || JOB_HTML_MAX_DETAILS)) break;
  }
  const offers = [];
  for (let i = 0; i < links.length; i++) {
    if (i > 0 && ctx.delay > 0) await new Promise((r) => setTimeout(r, ctx.delay));
    try {
      const detail = await ctx.getText(links[i]);
      for (const jp of parseJsonLdJobPostings(detail)) {
        const o = normalizeJsonLdOffer(jp, src.id, links[i]);
        if (o) offers.push(o);
      }
    } catch (_) { /* one bad detail must not kill the source */ }
  }
  return offers;
}

const JOB_SOURCES = [
  {
    id: 'arbeitnow', parseAs: 'json', normalize: normalizeArbeitnow,
    urls: ['https://www.arbeitnow.com/api/job-board-api'],
    searchUrl: (kw) => 'https://www.arbeitnow.com/api/job-board-api?search=' + kw
  },
  {
    id: 'remotive', parseAs: 'json', normalize: normalizeRemotive,
    urls: ['https://remotive.com/api/remote-jobs?limit=60'],
    searchUrl: (kw) => 'https://remotive.com/api/remote-jobs?limit=60&search=' + kw
  },
  {
    id: 'jobicy', parseAs: 'json', normalize: normalizeJobicy,
    urls: ['https://jobicy.com/api/v2/remote-jobs?count=50&industry=engineering'],
    searchUrl: null
  },
  {
    id: 'remoteok', parseAs: 'json', normalize: normalizeRemoteok,
    urls: ['https://remoteok.com/api'], searchUrl: null
  },
  {
    id: 'weworkremotely', parseAs: 'text', normalize: normalizeWwrRss, slow: 1500,
    urls: ['https://weworkremotely.com/categories/remote-programming-jobs.rss'], searchUrl: null
  },
  {
    id: 'themuse', parseAs: 'json', normalize: normalizeThemuse,
    urls: ['https://www.themuse.com/api/public/jobs?page=1'],
    searchUrl: (kw) => 'https://www.themuse.com/api/public/jobs?page=1&category=Software+Engineering'
  },
  {
    // XING (DACH): listing -> detail JSON-LD. No open API.
    id: 'xing', kind: 'html', base: 'https://www.xing.com', slow: 1500, maxDetails: 10,
    linkRe: '/jobs/[a-z0-9][a-z0-9-]*-\\d{6,}',
    listing: (criteria, kw) => 'https://www.xing.com/jobs/search?keywords=' +
      encodeURIComponent([kw, criteria.location.split(/[,;]/)[0]].filter(Boolean).join(' '))
  },
  {
    // Stepstone (DE): listing -> detail JSON-LD. No open API.
    id: 'stepstone', kind: 'html', base: 'https://www.stepstone.de', slow: 2000, maxDetails: 10,
    linkRe: '/stellenangebote--[^"\'#?]+?\\.html',
    listing: (criteria, kw) => 'https://www.stepstone.de/jobs/' +
      encodeURIComponent(String(kw || 'software').replace(/\s+/g, '-'))
  },
  {
    // NoFluffJobs (PL/remote): listing -> detail JSON-LD (public, but scraper).
    id: 'nofluffjobs', kind: 'html', base: 'https://nofluffjobs.com', slow: 1500, maxDetails: 10,
    linkRe: '/pl/job/[a-z0-9][a-z0-9-]+',
    listing: (criteria, kw) => 'https://nofluffjobs.com/pl/backend?criteria=keyword%3D%22' +
      encodeURIComponent(kw || 'software') + '%22'
  },
  {
    // pracuj.pl (PL). NOTE: currently behind a Cloudflare JS challenge — the
    // server-side fetch is rejected with 403, so this source reports a clear
    // "blocked" error instead of silently returning nothing.
    id: 'pracuj', kind: 'html', base: 'https://it.pracuj.pl', slow: 2000, maxDetails: 10,
    linkRe: '/praca/[a-z0-9][a-z0-9-]*,[a-z0-9]+;kw',
    listing: (criteria, kw) => 'https://it.pracuj.pl/praca/' + encodeURIComponent((kw || 'software').replace(/\s+/g, '-')) + ';kw'
  },
  {
    id: 'sample', parseAs: 'json', normalize: normalizeJobSample,
    urls: [], searchUrl: null, fetcher: sampleFetcher
  }
];

// Strip HTML into readable plain text (keeps paragraph breaks). Some feeds
// deliver entity-escaped HTML ("&lt;p&gt;..."), so decode first; then strip
// tags; then decode once more to catch double-encoded entities.
function offerHtmlToText(html) {
  let t = decodeEntities(String(html || ''));
  t = t.replace(/<\s*(script|style)[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ');
  t = t.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  t = t.replace(/<\s*\/\s*(p|div|li|tr|h[1-6])\s*>/gi, '\n');
  t = t.replace(/<[^>]+>/g, ' ');
  t = decodeEntities(t);
  t = t.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

function offerClean(v, max) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max || 400);
}

// Normalizers: source payload -> one common offer shape.
function normalizeArbeitnow(json) {
  const out = [];
  for (const j of (json && json.data) || []) {
    if (!j || !j.title) continue;
    const description = offerHtmlToText(j.description);
    if (description.length < 100) continue;
    out.push({
      source: 'arbeitnow', title: offerClean(j.title, 160), company: offerClean(j.company_name, 120),
      location: offerClean(j.location, 120), workplace: j.remote ? 'remote' : 'onsite',
      url: offerClean(j.url, 500), applyUrl: offerClean(j.url, 500),
      salary: '', savedAt: offerClean(j.created_at, 20), description
    });
  }
  return out;
}
function normalizeRemotive(json) {
  const out = [];
  for (const j of (json && json.jobs) || []) {
    if (!j || !j.title) continue;
    const description = offerHtmlToText(j.description);
    if (description.length < 100) continue;
    out.push({
      source: 'remotive', title: offerClean(j.title, 160), company: offerClean(j.company_name, 120),
      location: offerClean(j.candidate_required_location || 'Remote', 120), workplace: 'remote',
      url: offerClean(j.url, 500), applyUrl: offerClean(j.apply_url || j.url, 500),
      salary: offerClean(j.salary, 120), savedAt: offerClean(j.publication_date, 20), description
    });
  }
  return out;
}
function normalizeJobicy(json) {
  const out = [];
  for (const j of (json && json.jobs) || []) {
    if (!j || !j.jobTitle) continue;
    const description = offerHtmlToText(j.jobDescription);
    if (description.length < 100) continue;
    const wl = String(j.jobGeo || '');
    out.push({
      source: 'jobicy', title: offerClean(j.jobTitle, 160), company: offerClean(j.companyName, 120),
      location: offerClean(wl || 'Remote', 120), workplace: 'remote',
      url: offerClean(j.url, 500), applyUrl: offerClean(j.url, 500),
      salary: offerClean(j.annualSalaryMin && j.annualSalaryMax ? (j.annualSalaryMin + '-' + j.annualSalaryMax + ' ' + (j.salaryCurrency || '')) : '', 120),
      savedAt: offerClean(j.pubDate, 20), description
    });
  }
  return out;
}
function normalizeRemoteok(json) {
  const out = [];
  for (const j of Array.isArray(json) ? json : []) {
    if (!j || !j.position) continue;
    const description = offerHtmlToText(j.description);
    if (description.length < 100) continue;
    out.push({
      source: 'remoteok', title: offerClean(j.position, 160), company: offerClean(j.company, 120),
      location: offerClean(j.location || 'Remote', 120), workplace: 'remote',
      url: offerClean(j.url, 500), applyUrl: offerClean(j.apply_url || j.url, 500),
      salary: offerClean(j.salary, 120), savedAt: offerClean(j.date, 20), description
    });
  }
  return out;
}
function normalizeWwrRss(xml) {
  const out = [];
  const items = String(xml || '').split(/<item[\s>]/i).slice(1);
  for (const it of items) {
    const pick = (tag) => {
      const m = it.match(new RegExp('<' + tag + '>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/' + tag + '>', 'i'));
      return m ? decodeEntities(m[1]) : '';
    };
    const rawTitle = offerClean(pick('title'), 200);
    if (!rawTitle) continue;
    const idx = rawTitle.indexOf(':');
    const company = idx > 0 ? offerClean(rawTitle.slice(0, idx), 120) : '';
    const title = offerClean(idx > 0 ? rawTitle.slice(idx + 1) : rawTitle, 160);
    const description = offerHtmlToText(pick('description'));
    if (description.length < 100) continue;
    out.push({
      source: 'weworkremotely', title, company, location: 'Remote', workplace: 'remote',
      url: offerClean(pick('link'), 500), applyUrl: offerClean(pick('link'), 500),
      salary: '', savedAt: offerClean(pick('pubDate'), 20), description
    });
  }
  return out;
}
function normalizeThemuse(json) {
  const out = [];
  for (const j of (json && json.results) || []) {
    if (!j || !j.name) continue;
    const description = offerHtmlToText(j.contents);
    if (description.length < 100) continue;
    const locs = (j.locations || []).map((l) => l && l.name).filter(Boolean).join(', ');
    const remote = /remote|flexible/i.test(locs);
    out.push({
      source: 'themuse', title: offerClean(j.name, 160),
      company: offerClean((j.company && j.company.name) || '', 120),
      location: offerClean(locs || 'Unknown', 120), workplace: remote ? 'remote' : 'onsite',
      url: offerClean((j.refs && j.refs.landing_page) || '', 500),
      applyUrl: offerClean((j.refs && j.refs.landing_page) || '', 500),
      salary: '', savedAt: offerClean(j.publication_date, 20), description
    });
  }
  return out;
}

// Fetch one source with timeout. `fetcher` is the real network call; tests
// replace it with an offline stub.
function jobSourceFetch(fetcher, url, parseAs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JOB_FETCH_TIMEOUT_MS);
  return fetcher(url, {
    headers: { 'User-Agent': JOB_UA, 'Accept': parseAs === 'text' ? 'application/rss+xml, text/xml, */*' : 'application/json' },
    signal: controller.signal
  }).then(async (r) => {
    if (!r || !r.ok) throw new Error('HTTP ' + ((r && r.status) || '?'));
    const body = parseAs === 'text' ? await r.text() : await r.json();
    return body;
  }).finally(() => clearTimeout(timer));
}

// Fetch a raw HTML/text page with the scraper UA (used by the HTML portals).
async function jobGetText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JOB_FETCH_TIMEOUT_MS);
  try {
    const r = await (globalThis.fetch)(url, {
      headers: { 'User-Agent': JOB_UA, 'Accept-Language': 'en,de;q=0.8,pl;q=0.7', 'Accept': 'text/html,application/xhtml+xml' },
      signal: controller.signal
    });
    if (!r || !r.ok) throw new Error('HTTP ' + ((r && r.status) || '?'));
    return await r.text();
  } catch (e) {
    if (/\b(403|521|429)\b/.test(String(e && e.message))) {
      throw new Error('blocked by anti-bot protection (Cloudflare) — this site needs a real browser to scrape');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function jobFetchSource(src, criteria, ctx) {
  // HTML portals (XING / Stepstone / NoFluffJobs): scrape listing + details.
  if (src.kind === 'html') {
    return jobFetchHtmlSource(src, criteria, ctx || { getText: (u) => jobGetText(u), delay: (src.slow || JOB_HOST_DELAY_MS) });
  }
  const kw = encodeURIComponent((criteria.keywords || '').split(/\s+/).filter(Boolean).slice(0, 4).join(' '));
  const base = src.urls[0];
  const url = kw && src.searchUrl ? src.searchUrl(kw) : base;
  const json = await jobSourceFetch(src.fetcher || globalThis.fetch, url, src.parseAs);
  return src.normalize(json);
}

// Pre-filter: workplace is a hard filter. Keywords and location drive RANKING
// (title hits weigh most). Offers with no relevance at all are dropped: when
// keywords are given, an offer must hit a keyword somewhere OR match the
// location text, otherwise the AI drowns in unrelated listings.
function jobPrefilter(pool, criteria) {
  const kws = String(criteria.keywords || '').toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
  const locWords = String(criteria.location || '').toLowerCase().split(/[^a-z0-9]+/i).filter((w) => w.length >= 3 && !/^(onsite|remote|hybrid|and|the|for)$/.test(w));
  const places = (criteria.workplace && criteria.workplace.length) ? criteria.workplace : ['remote', 'onsite', 'hybrid'];
  const scored = [];
  for (const o of pool) {
    const wp = (o.workplace || 'remote').toLowerCase();
    if (wp !== 'hybrid' && !places.includes(wp)) continue;
    const title = String(o.title || '').toLowerCase();
    const desc = String(o.description || '').toLowerCase();
    let score = 0;
    for (const w of kws) { if (title.includes(w)) score += 3; else if (desc.includes(w)) score += 1; }
    const locHay = ((o.location || '') + ' ' + (o.workplace || '')).toLowerCase();
    let locHit = false;
    for (const w of locWords) if (locHay.includes(w)) { score += 4; locHit = true; }
    if (kws.length && score === 0) continue;               // zero relevance -> drop
    if (!kws.length && locWords.length && !locHit) continue;
    scored.push({ o, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, JOB_MAX_POOL).map((x) => x.o);
}

// Build the strict-JSON instruction sent to the model for one batch.
// The user's criteria — INCLUDING the free-text location field — are passed
// through verbatim; the model is the one doing the matching.
function jobAiPrompt(criteria, batch) {
  const lines = batch.map((o, i) => (i + 1) + '. ' + [
    o.title, o.company, o.location, o.workplace, (o.description || '').slice(0, 300)
  ].join(' | '));
  return [
    'You are matching job offers to a candidate. You make the final decision; the offers below were only pre-ranked by keywords.',
    '',
    'Search criteria (verbatim from the user):',
    '- Desired role / keywords: ' + (criteria.keywords || '(any)'),
    '- Location / workplace (free text): ' + (criteria.location || '(any)'),
    '- Allowed workplace types: ' + ((criteria.workplace && criteria.workplace.join(', ')) || 'any'),
    '- Language requirements: ' + (criteria.languages || 'any'),
    '',
    'IMPORTANT about the "Location / workplace" field: it is free text and may list several alternatives combined with their workplace type, e.g. "Hamburg onsite, Poznan onsite, EU remotely". Interpret it as a list of OR-conditions: an offer matches if it satisfies ANY one of them, honouring the workplace word attached to each (onsite / remote / hybrid). Do not require all alternatives at once.',
    '',
    'Decision rules — be INCLUSIVE (prefer recall over precision):',
    '- Include an offer when it is in the SAME role family as the desired role (e.g. team lead / engineering manager / staff or senior engineer in software or AI) AND satisfies at least ONE location alternative.',
    '- A partial match is still a match: if the role fits but one detail differs (e.g. a different seniority label), include it and note the difference briefly in "reason".',
    '- Only exclude offers that are clearly a different job family (sales, marketing, recruiting, finance, design, clinical, etc.) or fit no location alternative.',
    '',
    'For EACH offer decide if it matches. Answer ONLY with JSON, no prose:',
    '{"matches":[{"id":<offer number>,"language":"<required workplace language(s) or \'undetermined\'>","reason":"<max 12 words>"}]}',
    'Use the offer numbers below as ids. If several offers match, list them all.',
    '',
    'Offers:',
    ...lines
  ].join('\n');
}

// Parse the model reply defensively; keep only ids that exist in the batch.
function parseJobAiReply(text, batchLen) {
  const t = String(text || '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return [];
  let data;
  try { data = JSON.parse(t.slice(start, end + 1)); } catch (e) { return []; }
  const arr = Array.isArray(data) ? data : data.matches;
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const m of arr) {
    const id = parseInt(m && m.id, 10);
    if (id >= 1 && id <= batchLen) {
      out.push({ id, language: offerClean(m.language, 80), reason: offerClean(m.reason, 200) });
    }
  }
  return out;
}

const JOB_AI_SYSTEM = 'You are a precise job-matching assistant. Answer with strict JSON only.';

// Fetch all selected sources (throttled) and pre-rank the pool. Emits NDJSON
// progress via `send`. Returns the ranked candidate list.
async function jobHarvest(criteria, sources, delayMs, send) {
  const pool = [];
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    send({ event: 'source-start', source: src.id });
    try {
      const offers = await jobFetchSource(src, criteria);
      for (const o of offers) pool.push(o);
      send({ event: 'source-done', source: src.id, count: offers.length });
    } catch (e) {
      send({ event: 'source-failed', source: src.id, error: String((e && e.message) || e) });
    }
    const last = i === sources.length - 1;
    if (!last) {
      const gap = (src.slow || delayMs) + JOB_SOURCE_GAP_MS;
      if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    }
  }
  const candidates = jobPrefilter(pool, criteria);
  send({ event: 'prefilter', kept: candidates.length, fetched: pool.length });
  return candidates;
}

// Split candidates into AI batches; each carries the exact prompt to send.
function jobBuildBatches(candidates, criteria) {
  const batches = [];
  for (let i = 0; i < candidates.length; i += JOB_AI_BATCH) {
    const slice = candidates.slice(i, i + JOB_AI_BATCH);
    batches.push({ prompt: jobAiPrompt(criteria, slice), candidates: slice });
  }
  return batches;
}

// Send the batches to the model. `batches` may carry user-edited prompts.
// Returns { aiById, anyAi, anyOk } where aiById is keyed per batch index.
async function jobRunAiBatches(batches, modelIndex, delayMs, send) {
  const aiByBatch = [];
  let anyAi = false;
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const candidates = Array.isArray(batch.candidates) ? batch.candidates : [];
    const prompt = String(batch.prompt || '');
    send({ event: 'ai-progress', done: b, total: batches.length });
    const hits = [];
    try {
      const built = await buildPayload([{ role: 'user', content: prompt }], modelIndex, [], null, JOB_AI_SYSTEM);
      const headers = { 'Content-Type': 'application/json' };
      if (built.apiKey) headers['Authorization'] = 'Bearer ' + built.apiKey;
      const upstream = await fetch(built.endpoint, { method: 'POST', headers, body: JSON.stringify(built.payload) });
      if (!upstream.ok) throw new Error('model HTTP ' + upstream.status);
      const data = await upstream.json();
      const content = (data.message && data.message.content) ||
        ((data.choices && data.choices[0] && data.choices[0].message) ? data.choices[0].message.content : '');
      for (const m of parseJobAiReply(content, candidates.length)) {
        const o = candidates[m.id - 1];
        if (o) hits.push({ idx: m.id - 1, language: m.language, reason: m.reason });
      }
      anyAi = true;
    } catch (e) {
      send({ event: 'ai-error', error: String((e && e.message) || e) });
    }
    aiByBatch.push(hits);
    if (b < batches.length - 1 && delayMs > 0) await new Promise((r) => setTimeout(r, Math.min(delayMs, 400)));
  }
  send({ event: 'ai-progress', done: batches.length, total: batches.length });
  return { aiByBatch, anyAi };
}

// Compose the final bulk offers from the batches + per-batch AI hits. When the
// AI produced nothing, fall back to the pre-ranked candidates (still useful).
function jobComposeOffers(batches, aiByBatch, anyAi) {
  const all = [];
  for (let b = 0; b < batches.length; b++) {
    const candidates = batches[b].candidates || [];
    const hits = aiByBatch[b] || [];
    for (const h of hits) {
      const o = candidates[h.idx];
      if (o) all.push({ o, meta: { language: h.language, reason: h.reason } });
    }
  }
  // Fallback when the AI produced nothing usable: if there were no matches at
  // all (or no AI answer), surface the top pre-ranked candidates so the user
  // still gets a reviewable list instead of an empty panel.
  if (!all.length) {
    const ranked = [];
    for (const batch of batches) for (const o of (batch.candidates || [])) ranked.push(o);
    for (const o of ranked.slice(0, JOB_MAX_RESULTS)) all.push({ o, meta: null });
  }
  return all.slice(0, JOB_MAX_RESULTS).map(({ o, meta }) => ({
    title: o.title, company: o.company, location: o.location, url: o.applyUrl || o.url,
    status: '', workplace: o.workplace, workplaceType: o.workplace, salary: o.salary,
    savedAt: o.savedAt, source: o.source,
    language: meta ? meta.language : '',
    aiReason: meta ? meta.reason : '',
    aiChecked: !!meta,
    description: o.description
  }));
}

function jobSourcesFrom(criteria) {
  const sel = Array.isArray(criteria.sources) ? criteria.sources : [];
  return JOB_SOURCES.filter((s) => sel.includes(s.id));
}

// Short-lived in-memory cache of harvested candidates, keyed by a search id, so
// the approval round-trip only carries the prompts (not the full descriptions).
const JOB_CACHE_MAX = 8;
const jobSearchCache = new Map(); // id -> { createdAt, batches: [{ prompt, candidates }] }
function jobCachePut(batches) {
  const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  jobSearchCache.set(id, { createdAt: Date.now(), batches });
  while (jobSearchCache.size > JOB_CACHE_MAX) jobSearchCache.delete(jobSearchCache.keys().next().value);
  return id;
}
function jobCacheGet(id) {
  const e = jobSearchCache.get(String(id || ''));
  if (!e) return null;
  if (Date.now() - e.createdAt > 30 * 60 * 1000) { jobSearchCache.delete(id); return null; }
  return e;
}

// Step 1: fetch + pre-rank + build the prompts. NO model call — the client
// shows the prompts for approval first.
app.post('/api/job-search/preview', async (req, res) => {
  const criteria = req.body || {};
  const sources = jobSourcesFrom(criteria);
  const delayMs = (criteria.delayMs !== undefined) ? Number(criteria.delayMs) : JOB_HOST_DELAY_MS;
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  const send = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch (_) {} };
  send({ event: 'start', sources: sources.map((s) => s.id), phase: 'preview' });
  const candidates = await jobHarvest(criteria, sources, delayMs, send);
  const batches = jobBuildBatches(candidates, criteria);
  const searchId = jobCachePut(batches);
  send({
    event: 'preview', searchId, candidates: candidates.length,
    modelIndex: (criteria.modelIndex != null ? criteria.modelIndex : null),
    batches: batches.map((b, i) => ({
      index: i, count: b.candidates.length, prompt: b.prompt,
      offers: b.candidates.map((o) => ({ title: o.title, company: o.company, location: o.location, workplace: o.workplace }))
    }))
  });
  send({ event: 'done', phase: 'preview' });
  res.end();
});

// Step 2: send the approved (possibly user-edited) prompts to the model and
// compose the bulk offers. Identified by searchId; prompts are index-aligned.
app.post('/api/job-search/run', async (req, res) => {
  const body = req.body || {};
  const cached = jobCacheGet(body.searchId);
  const modelIndex = (body.modelIndex !== undefined && body.modelIndex !== null) ? body.modelIndex : undefined;
  const delayMs = (body.delayMs !== undefined) ? Number(body.delayMs) : JOB_HOST_DELAY_MS;
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  const send = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch (_) {} };

  let batches;
  if (cached) {
    // Client-side overrides: prompts (strings) and/or per-batch offer removal.
    const prompts = Array.isArray(body.prompts) ? body.prompts : [];
    const skip = Array.isArray(body.skip) ? body.skip : [];
    batches = cached.batches
      .map((b, i) => ({ candidates: b.candidates, prompt: (typeof prompts[i] === 'string' ? prompts[i] : b.prompt) }))
      .filter((b, i) => !skip.includes(i));
  } else if (Array.isArray(body.batches) && body.batches.length) {
    // Stateless fallback (programmatic callers / tests).
    batches = body.batches.map((b) => ({ candidates: Array.isArray(b.candidates) ? b.candidates : [], prompt: String(b.prompt || '') }));
  } else {
    return res.status(400).json({ error: 'Unknown searchId and no batches supplied' });
  }
  if (!batches.length) return res.status(400).json({ error: 'No batches' });

  send({ event: 'start', phase: 'run', batches: batches.length });
  const { aiByBatch, anyAi } = await jobRunAiBatches(batches, modelIndex, delayMs, send);
  const offers = jobComposeOffers(batches, aiByBatch, anyAi);
  flagStoredOffers(offers);
  send({ event: 'done', offers, aiChecked: anyAi, total: offers.length });
  res.end();
});

// Convenience one-shot path (no approval step): fetch -> AI -> offers.
// Kept for programmatic callers and the API test suite.
app.post('/api/job-search', async (req, res) => {
  const criteria = req.body || {};
  const sources = jobSourcesFrom(criteria);
  const modelIndex = (criteria.modelIndex !== undefined && criteria.modelIndex !== null) ? criteria.modelIndex : undefined;
  const delayMs = (criteria.delayMs !== undefined) ? Number(criteria.delayMs) : JOB_HOST_DELAY_MS;
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  const send = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch (_) {} };
  send({ event: 'start', sources: sources.map((s) => s.id) });
  const candidates = await jobHarvest(criteria, sources, delayMs, send);
  const batches = jobBuildBatches(candidates, criteria);
  const { aiByBatch, anyAi } = await jobRunAiBatches(batches, modelIndex, delayMs, send);
  const offers = jobComposeOffers(batches, aiByBatch, anyAi);
  flagStoredOffers(offers);
  send({ event: 'done', offers, aiChecked: anyAi, total: offers.length });
  res.end();
});

function parseOfferFile(text) {
  const all = [];
  for (const chunk of splitHtmlOffers(text)) {
    const o = parseHtmlOffer(chunk);
    if ((o.title || o.company) && o.description && o.description.length > 100) all.push(o);
  }
  if (!all.length) {
    // LinkedIn extension "Export JSON" ({saved:[...]} or bare array).
    const trimmed = String(text).replace(/^\uFEFF/, '').trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      for (const o of parseJsonOffers(trimmed)) all.push(o);
    }
  }
  if (!all.length) {
    // LinkedIn extension CSV export (header row: jobId,title,company,...).
    const first = String(text).replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] || '';
    if (/\bjobid\b/i.test(first) && /\btitle\b/i.test(first) && /\bdescriptiontext\b/i.test(first)) {
      for (const o of parseCsvOffers(text)) all.push(o);
    }
  }
  if (!all.length) {
    for (const o of parsePlainOffers(text)) all.push(o);
  }
  return all;
}

// Best-effort company/job title/location/url from a manual chat's first user
// message (bulk flow stores these from the parsed offer; manual chats have no
// offer object, so we infer from the message text).
const OFFER_NOISE_RE = /^(apply|locations?|time type|posted on|show more|save|insights|report this job|close|done|job requisition id.*|posted \d.*|full time|part time)\.?$/i;

function deriveOfferMeta(messages) {
  const first = messages.find((m) => m.role === 'user');
  const text = String((first && first.content) || '');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { company: '', jobTitle: '', location: '', url: '' };
  const jobTitle = lines[0].slice(0, 160);
  const rest = lines.slice(1).filter((l) => !OFFER_NOISE_RE.test(l) && !/^https?:/i.test(l));
  let company = '';
  let location = '';
  let url = '';
  const emp = lines.find((l) => /^employers?\s*:/i.test(l));
  if (emp) company = emp.replace(/^employers?\s*:\s*/i, '').slice(0, 120);
  else if (rest.length && rest[0].length <= 120) company = rest[0].slice(0, 120);
  if (rest.length > 1 && rest[1].length <= 120) location = rest[1].slice(0, 120);
  const ul = lines.find((l) => /^https?:\/\//i.test(l));
  if (ul) url = ul;
  return { company, jobTitle, location, url };
}

// Extract the METRYKA block from an assistant reply.
function extractMetryka(text) {
  if (!text) return null;
  const up = String(text).toUpperCase();
  const idx = up.indexOf("METRYKA");
  if (idx === -1) return null;
  const tail = String(text).slice(idx, idx + 1500);
  // Prefer a line containing METRYKA AND the percentages (the model often
  // renders a bare "METRYKA" heading on its own line, values 1-2 lines
  // below); else the first METRYKA line, else the whole tail.
  const candLines = tail.split("\n").filter((l) => l.toUpperCase().includes("METRYKA"));
  const line = candLines.find((l) => /\d{1,3}\s*%/.test(l)) || candLines[0] || tail;
  const grab = (re) => {
    const m = line.match(re);
    if (!m) return null;
    const v = parseInt(m[1], 10);
    return (v >= 0 && v <= 100) ? v : null;
  };
  const metrics = {
    interview: grab(/(?:interview|rozmow\w*)[^|\n]{0,30}?(\d{1,3})\s*%/i),
    employment: grab(/zatrudnien\w*[^|\n]{0,30}?(\d{1,3})\s*%/i),
    role: grab(/dopasowan\w*[^|\n]{0,30}?(\d{1,3})\s*%/i),
    satisfaction: grab(/satysfakcj\w*[^|\n]{0,30}?(\d{1,3})\s*%/i),
    salary: grab(/wynagrodzen\w*[^|\n]{0,30}?(\d{1,3})\s*%/i),
    recommend: grab(/(?:rekomendacj\w*[^|\n]{0,30}?(\d{1,3})\s*%)/i)
  };
  // Fallback: pipe-separated values in order.
  if (metrics.recommend === null) {
    const vals = (line.match(/\d{1,3}\s*%/g) || []).map((v) => parseInt(v, 10)).filter((v) => v >= 0 && v <= 100);
    if (vals.length >= 6) {
      const keys = ["interview", "employment", "role", "satisfaction", "salary", "recommend"];
      for (let i = 0; i < 6; i++) if (metrics[keys[i]] === null) metrics[keys[i]] = vals[i];
    }
  }
  if (metrics.recommend === null) return null;
  return { metrics, raw: line.trim().slice(0, 600) };
}

// Title for the conversation created from an offer.
function bulkOfferTitle(offer) {
  const t = (offer.company && offer.title) ? (offer.company + ' - ' + offer.title) : (offer.company || offer.title);
  return t ? t.slice(0, 80) : "Job offer";
}

// Run one offer: create the conversation (latest RAG set), call the model,
// extract METRYKA. 2 attempts; on failure the conversation is deleted.
async function runBulkOffer(offer, ragFiles, modelIndex) {
  const userMsg = [offer.title, offer.company, offer.location, offer.url, "---", offer.description]
    .filter((x) => String(x || "").trim().length).join("\n");
  let convId = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    // Create a fresh conversation carrying the RAG selection.
    convId = null;
    try {
      const convIdNew = (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
      const convDirNew = path.join(CONVERSATIONS_DIR, convIdNew);
      fs.mkdirSync(convDirNew, { recursive: true });
      fs.mkdirSync(path.join(convDirNew, "files"), { recursive: true });
      const now0 = new Date().toISOString();
      const ragFilesKept = (ragFiles || []).map((f) => path.basename(String(f)))
        .filter((f) => fs.existsSync(path.join(UPLOAD_DIR, f)));
      fs.writeFileSync(path.join(convDirNew, "conversation.json"), JSON.stringify({
        id: convIdNew, name: "Bulk analysis...", createdAt: now0, updatedAt: now0,
        messages: [], selectedFiles: ragFilesKept,
        modelIndex: (modelIndex !== undefined ? modelIndex : null),
        tags: { matchPct: null, german: null, status: null, satisfactionPct: null }
      }, null, 2));
      const index0 = loadConversationsIndex();
      index0.unshift({ id: convIdNew, name: "Bulk analysis...", createdAt: now0, updatedAt: now0,
        messageCount: 0, tags: { matchPct: null, german: null, status: null, satisfactionPct: null } });
      saveConversationsIndex(index0);
      convId = convIdNew;
      // Ask the model (non-stream; full reply in one response).
      const built = await buildPayload([{ role: "user", content: userMsg }], modelIndex, ragFilesKept, convId);
      const headers = { "Content-Type": "application/json" };
      if (built.apiKey) headers["Authorization"] = "Bearer " + built.apiKey;
      const upstream = await fetch(built.endpoint, { method: "POST", headers, body: JSON.stringify(built.payload) });
      if (!upstream.ok) throw new Error("Model error (" + upstream.status + ")");
      const data = await upstream.json();
      const content = (data.message && data.message.content) ||
        ((data.choices && data.choices[0] && data.choices[0].message) ? data.choices[0].message.content : "");
      if (!content || String(content).trim().length < 50) throw new Error("Empty model reply");
      // Success: store messages, rename, extract METRYKA.
      const name = bulkOfferTitle(offer);
      const messages = [
        { role: "user", content: userMsg },
        { role: "assistant", content: String(content) }
      ];
      const convDir = path.join(CONVERSATIONS_DIR, convId);
      const now = new Date().toISOString();
      const full = loadConversation(convId);
      full.name = name;
      full.messages = messages;
      full.updatedAt = now;
      const met = extractMetryka(content);
      if (met && met.metrics.interview !== null) {
        full.tags = { ...full.tags, matchPct: met.metrics.interview };
      }
      if (met && met.metrics.satisfaction !== null && met.metrics.satisfaction !== undefined) {
        full.tags = { ...full.tags, satisfactionPct: met.metrics.satisfaction };
      }
      // Sync the CSV status into the conversation tags so the conversation
      // list shows the same badge the bulk row carried.
      const csvStatus = String(offer.status || "").trim().toLowerCase();
      if (csvStatus === "apply") full.tags.status = "to_apply";
      else if (csvStatus === "applied") full.tags.status = "applied";
      else if (csvStatus === "ignored") full.tags.status = "not_applying";
      if (csvStatus === "german") full.tags.german = "required";
      fs.writeFileSync(path.join(convDir, "conversation.json"), JSON.stringify(full, null, 2));
      const index = loadConversationsIndex();
      const entry = index.find((c) => c.id === convId);
      if (entry) { entry.name = name; entry.updatedAt = now; entry.messageCount = messages.length;
        entry.tags = { ...full.tags };
        saveConversationsIndex(index);
      }
      // Record the metric.
      if (met) {
        const store = loadMetrics();
        store.entries.push({
          convId,
          convName: name,
          createdAt: now,
          company: offer.company || "",
          jobTitle: offer.title || "",
          location: offer.location || "",
          url: offer.url || "",
          status: offer.status || "",
          metrics: met.metrics,
          raw: met.raw
        });
        saveMetrics(store);
      }
      return { ok: true, convId, name, metrics: met ? met.metrics : null };
    } catch (e) {
      lastError = e.message;
      // Remove the failed conversation before retrying / giving up.
      if (convId) {
        try {
          const dir = path.join(CONVERSATIONS_DIR, convId);
          if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
          saveConversationsIndex(loadConversationsIndex().filter((c) => c.id !== convId));
        } catch (_) {}
        convId = null;
      }
    }
  }
  return { ok: false, error: lastError || "unknown error" };
}

// Parse an uploaded offer file (no side effects).
app.post("/api/bulk/parse", upload.single("file"), (req, res) => {
  try {
    const p = req.file ? req.file.path : null;
    if (!p) return res.status(400).json({ error: "No file" });
    const text = fs.readFileSync(p, "utf8");
    fs.unlinkSync(p);
    const offers = parseOfferFile(text);
    flagStoredOffers(offers);
    res.json({ ok: true, offers, count: offers.length });
  } catch (e) {
    res.status(500).json({ error: "Parse failed: " + e.message });
  }
});

// Run bulk analysis over the selected offers. Progress is streamed as
// NDJSON lines: {"event":"offer-start"|"offer-done"|"offer-failed", ...}.
app.post("/api/bulk/run", async (req, res) => {
  const { offers, modelIndex } = req.body;
  if (!Array.isArray(offers) || !offers.length) return res.status(400).json({ error: "No offers" });
  // Client cancel: the offer currently being processed finishes, then the
  // loop stops (checked between offers). Listen on the RESPONSE - in modern
  // Node, req 'close' fires as soon as the request body is fully received,
  // which would abort the run right after the first offer.
  let stopRequested = false;
  res.on("close", () => { stopRequested = true; });
  // RAG files: the CURRENT global selection (config.selectedFiles) — the
  // same set every new conversation gets. Falls back to the most recently
  // updated conversation when the config carries no selection.
  const cfgForRag = loadConfig();
  let ragFiles = Array.isArray(cfgForRag.selectedFiles) ? cfgForRag.selectedFiles.slice() : [];
  if (!ragFiles.length) {
    const index = loadConversationsIndex();
    const latest = index.slice().sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0];
    if (latest) {
      const conv = loadConversation(latest.id);
      if (conv && Array.isArray(conv.selectedFiles)) ragFiles = conv.selectedFiles;
    }
  }
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();
  const send = (obj) => { try { res.write(JSON.stringify(obj) + "\n"); } catch (_) {} };
  send({ event: "start", total: offers.length, ragFiles: ragFiles.length });
  for (const offer of offers) {
    if (stopRequested) break;
    send({ event: "offer-start", title: offer.title || "", company: offer.company || "" });
    const r = await runBulkOffer(offer, ragFiles, modelIndex);
    if (r.ok) send({ event: "offer-done", convId: r.convId, name: r.name, metrics: r.metrics });
    else send({ event: "offer-failed", error: r.error, title: offer.title || "", company: offer.company || "" });
  }
  send({ event: "done", stopped: stopRequested });
  res.end();
});

// Re-flag parsed offers against ALL stored conversations. The bulk dialog
// calls this while a run is in progress so conversations created by the run
// are detected as duplicates (and their CSV tags synced) immediately.
app.post("/api/bulk/refresh", (req, res) => {
  const { offers } = req.body;
  if (!Array.isArray(offers)) return res.status(400).json({ error: "No offers" });
  flagStoredOffers(offers);
  res.json({ ok: true, offers });
});

// Metrics list sorted by "recommend" (desc), newest first as tiebreak.
app.get("/api/metrics", (req, res) => {
  const store = loadMetrics();
  const entries = store.entries.slice().sort((a, b) => {
    const ra = (a.metrics && a.metrics.recommend) || -1;
    const rb = (b.metrics && b.metrics.recommend) || -1;
    if (rb !== ra) return rb - ra;
    return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  });
  res.json({ entries });
});

app.delete("/api/metrics/:convId", (req, res) => {
  const store = loadMetrics();
  store.entries = store.entries.filter((e) => e.convId !== req.params.convId);
  saveMetrics(store);
  res.json({ ok: true });
});
// ---- Full backup / restore (zip of data/: config, conversations, uploads, metrics) ----
const BACKUP_MANIFEST = "gem-backup.json";

function listDataFiles(dir, base) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = base ? base + "/" + e.name : e.name;
    if (e.isDirectory()) out.push(...listDataFiles(full, rel));
    else out.push(rel);
  }
  return out;
}

app.get("/api/backup", async (req, res) => {
  try {
    const zip = new JSZip();
    const rels = listDataFiles(DATA_DIR, "").filter((f) => f !== BACKUP_MANIFEST);
    for (const rel of rels) {
      zip.file(rel, fs.readFileSync(path.join(DATA_DIR, rel)));
    }
    zip.file(BACKUP_MANIFEST, JSON.stringify({
      app: "job-offer-ai-chat",
      createdAt: new Date().toISOString(),
      files: rels.length
    }, null, 2));
    const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", "attachment; filename=\"gem-backup-" + stamp + ".zip\"");
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: "Backup failed: " + e.message });
  }
});

app.post("/api/restore", upload.single("file"), (req, res) => {
  (async () => {
    try {
    const p = req.file ? req.file.path : null;
    if (!p) return res.status(400).json({ error: "No file" });
    const zip = await JSZip.loadAsync(fs.readFileSync(p));
    fs.unlinkSync(p);
    // Validate: manifest must exist.
    if (!zip.file(BACKUP_MANIFEST)) {
      return res.status(400).json({ error: "Not a GEM backup (missing " + BACKUP_MANIFEST + ")" });
    }
    const entries = [];
    zip.forEach((relPath, entry) => {
      if (entry.dir) return;
      if (relPath === BACKUP_MANIFEST) return;
      // Path traversal guard: only allow paths within data/ tree.
      const norm = path.posix.normalize(relPath);
      if (norm.startsWith("..") || path.isAbsolute(norm)) return;
      entries.push({ rel: norm });
    });
    if (!entries.length) return res.status(400).json({ error: "Backup is empty" });
    // Wipe current data (keep the data dir itself).
    for (const e of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
      const full = path.join(DATA_DIR, e.name);
      if (e.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
      else fs.unlinkSync(full);
    }
    let written = 0;
    for (const e of entries) {
      const dest = path.join(DATA_DIR, e.rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const content = await zip.file(e.rel).async("nodebuffer");
      fs.writeFileSync(dest, content);
      written++;
    }
    res.json({ ok: true, restored: written });
    } catch (e) {
      res.status(500).json({ error: "Restore failed: " + e.message });
    }
  })();
});
// ---- Chat ----
app.post('/api/chat', async (req, res) => {
  const { messages, modelIndex, selectedFiles, conversationId } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'No messages' });
  }

  let built;
  try {
    built = await buildPayload(messages, modelIndex, selectedFiles, conversationId);
  } catch (e) {
    return res.status(500).json({ error: 'Could not prepare request: ' + e.message });
  }
  const { endpoint, apiKey, payload, model } = built;

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  try {
    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      return res.status(upstream.status).json({ error: `Model error (${upstream.status}): ${errText}` });
    }

    const data = await upstream.json();
    const content = data.message && data.message.content
      ? data.message.content
      : (data.choices && data.choices[0] && data.choices[0].message
          ? data.choices[0].message.content
          : JSON.stringify(data));

    res.json({ content, model });
  } catch (e) {
    res.status(500).json({ error: 'Could not connect to the model: ' + e.message });
  }
});

// ---- Streaming chat (NDJSON upstream -> plain text chunks) ----
app.post('/api/chat/stream', async (req, res) => {
  const { messages, modelIndex, selectedFiles, conversationId } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'No messages' });
  }

  let built;
  try {
    built = await buildPayload(messages, modelIndex, selectedFiles, conversationId);
  } catch (e) {
    return res.status(500).json({ error: 'Could not prepare request: ' + e.message });
  }
  const { endpoint, apiKey, payload, model } = built;

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  try {
    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...payload, stream: true })
    });

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => '');
      return res.status(upstream.status || 502).json({ error: `Model error (${upstream.status}): ${errText}` });
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Model', model);
    res.flushHeaders();

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          const obj = JSON.parse(t);
          if (obj.error) {
            res.write('\n[ERROR] ' + (obj.error.message || JSON.stringify(obj.error)));
            continue;
          }
          if (obj.message && obj.message.content) res.write(obj.message.content);
        } catch (_) { /* ignore partial lines */ }
      }
    }
    res.end();
  } catch (e) {
    if (res.headersSent) {
      try { res.write('\n[ERROR] ' + e.message); } catch (_) {}
      res.end();
    } else {
      res.status(500).json({ error: 'Could not connect to the model: ' + e.message });
    }
  }
});

// ---- Context size estimate (system prompt + RAG + messages) ----
app.post('/api/context-size', async (req, res) => {
  const { messages, modelIndex, selectedFiles, conversationId } = req.body;
  try {
    const { payload } = await buildPayload(messages || [], modelIndex, selectedFiles, conversationId);
    let chars = 0;
    for (const m of payload.messages) chars += (m.content || '').length;
    res.json({ chars, tokens: Math.round(chars / 4) });
  } catch (e) {
    res.status(500).json({ error: 'Could not compute context size: ' + e.message });
  }
});

// Export internals for the test suite (tests/sandbox uses a separate
// GEM_DATA_DIR, so requiring this module never touches the real data).
if (require.main !== module) {
  module.exports = {
    app,
    PORT,
    DATA_DIR,
    extractMetryka,
    parseOfferFile,
    normalizeTagsInput,
    deriveOfferMeta,
    bulkOfferTitle,
    findDuplicateOffers,
    offerSimilarity,
    offerTokens,
    extractText,
    cleanFileName,
    offerHtmlToText,
    normalizeArbeitnow,
    normalizeRemotive,
    normalizeJobicy,
    normalizeRemoteok,
    normalizeWwrRss,
    normalizeThemuse,
    normalizeJobSample,
    parseJsonLdJobPostings,
    normalizeJsonLdOffer,
    jsonLdSalary,
    jsonLdLocation,
    jobPrefilter,
    jobAiPrompt,
    parseJobAiReply,
    JOB_SOURCES
  };
} else {
  app.listen(PORT, () => {
    backfillSatisfactionTags();
    backfillMetricsConvNames();
    console.log(`App running at http://localhost:${PORT}`);
  });
}
