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

const DATA_DIR = path.join(__dirname, 'data');
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
  const { models, activeModel, systemPrompt, selectedFiles } = req.body;
  if (models !== undefined) cfg.models = models;
  if (activeModel !== undefined) cfg.activeModel = activeModel;
  if (systemPrompt !== undefined) cfg.systemPrompt = systemPrompt;
  if (selectedFiles !== undefined) cfg.selectedFiles = selectedFiles;
  saveConfig(cfg);
  res.json({ ok: true });
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

async function buildPayload(messages, modelIndex, selectedFileList, conversationId) {
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
    tags: (prev && prev.tags) ? prev.tags : { matchPct: null, german: null, status: null }
  };
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

  const tags = { matchPct: null, german: null, status: null };

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
  res.json({ ok: true });
});

// ---- Application-package export (CV / Cover Letter -> ODT via pandoc) ----
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
  const RE_CV_H1 = /^(?:TOMASZ\s+KUEHN|KUEHN)\b/i;
  const RE_CL = /^(?:4b[\s.:-]|4c[\s.:-]|Cover\s*Letter|Anschreiben|Bewerbungsschreiben)/i;
  const RE_NUM_SECTION = /^\d+\s*[.)]/;

  const isCvStart = (h) => RE_CV_NUM.test(h.norm) || RE_CV_WORD.test(h.norm)
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

  // Slice a document out of a message: body from the first heading matching
  // `start` until the first later heading matching one of the `stop` rules.
  // An enclosing code fence around the document body (```markdown ... ```)
  // is stripped so pandoc does not render literal fence lines.
  function extractDoc(md, start, stops) {
    const heads = listHeadings(md);
    const from = heads.find(start);
    if (!from) return null;
    let end = heads.length;
    for (let i = heads.indexOf(from) + 1; i < heads.length; i++) {
      if (stops.some((s) => s(heads[i]))) { end = i; break; }
    }
    const to = end < heads.length ? heads[end].index : md.length;
    let body = md.slice(from.end, to).trim();
    const fence = body.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```?\s*$/i);
    if (fence) body = fence[1].trim();
    return body;
  }

  // CV stops at a cover-letter heading or the next numbered analysis section
  // ("## 5. ..."); inner headings (job entries, H1 name line) belong to the CV.
  const extractCv = (md) => extractDoc(md, isCvStart, [isClStart, isNumberedH2]);
  // A cover letter contains no headings of its own, so ANY next heading that
  // is not another cover-letter marker ends it (drops trailing commentary).
  // A cover-letter heading of the OTHER language also ends it, so the EN
  // letter never swallows the DE letter that follows it in the same package.
  const extractCl = (md, wantDe) => extractDoc(
    md,
    (h) => isClStart(h) && (wantDe ? isLangDe(h) : !isLangDe(h)),
    [(h) => !isClStart(h), (h) => isClStart(h) && (wantDe ? !isLangDe(h) : isLangDe(h))]
  );

  // Models sometimes wrap the whole answer in a ```markdown fence — strip it
  // so headings/H1 detection work on the content itself.
  function unwrapCodeFence(md) {
    const t = md.trim();
    const m = t.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```?\s*$/);
    return m ? m[1] : md;
  }

  const msgHasCv = (m) => extractCv(unwrapCodeFence(m.content)) !== null;
  const msgHasCl = (m, wantDe) => extractCl(unwrapCodeFence(m.content), wantDe) !== null;

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
  const titleMsg = [cvMsg, clEnMsg, clDeMsg].filter(Boolean)
    .find((m) => /^#\s+(?:Pakiet|PAKIET|AKTUALIZACJA)/im.test(m.content) || /^#\s+.*Kuehn/im.test(m.content));
  const title = ((titleMsg || cvMsg || { content: '' }).content.match(/^#\s+(?:Pakiet|PAKIET|AKTUALIZACJA|Zaktualizowany|Zaktualizowana)[^\n]*/im)
    || (titleMsg || cvMsg || { content: '' }).content.match(/^#\s+.*Kuehn[^\n]*/im)
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
    for (let i = signOff + 1; i < Math.min(signOff + 6, lines.length); i++) {
      const l = lines[i].trim();
      if (l === '' || /kuehn|@|\+49|linkedin|github|hamburg|germany|deutschland|poland/i.test(l)) cut = i + 1;
      else break;
    }
    return lines.slice(0, cut).join('\n').trimEnd();
  }

  // File names start with the conversation name
  const safeName = String(conv.name || 'conversation')
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 60);
  const outDir = path.join(__dirname, 'moje_dok', 'odt');
  fs.mkdirSync(outDir, { recursive: true });

  // Standalone CV (regenerated outside a package): extractDoc starts at the
  // "# TOMASZ KUEHN" H1, so the chatty intro before it is already dropped and
  // no separate slicing is needed.

  // Remove AI-typical em dashes: "word — word" -> "word - word"
  function stripEmDashes(text) {
    return text.replace(/—/g, '-').replace(/–/g, '-');
  }

  const mdOf = (m) => (m ? m.content : '');
  const cvFromPkg = cvMsg ? extractCv(unwrapCodeFence(mdOf(cvMsg))) : null;
  const parts = [
    ['CV', cvFromPkg, 'CV'],
    ['CoverLetter_EN', clEnMsg ? trimAfterSignature(extractCl(unwrapCodeFence(mdOf(clEnMsg)), false)) : null, 'cover'],
    ['CoverLetter_DE', clDeMsg ? trimAfterSignature(extractCl(unwrapCodeFence(mdOf(clDeMsg)), true)) : null, 'Anschreiben'],
  ];
  const kindFile = (kind) => { for (const p of parts) if (p[0] === kind) return p[2] || kind; return kind; };

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
    const failed = [];
    for (const [kind, content] of parts) {
      if (!content) continue;
      const hash = contentHash(stripEmDashes(content));
      if (manifest[kind] && manifest[kind].hash === hash && fs.existsSync(path.join(outDir, manifest[kind].file))) {
        // Same content as last export -> reuse the existing file
        exported.push(manifest[kind].file);
        continue;
      }
      const base = `${safeName}_${kindFile(kind)}`;
      const mdTmp = path.join(outDir, base + '.md');
      try {
        fs.writeFileSync(mdTmp, `# ${stripEmDashes(title)}\n\n${stripEmDashes(content)}`, 'utf8');
        tmpFiles.push(mdTmp);
        const odt = path.join(outDir, base + '.odt');
        const refDoc = path.join(__dirname, 'tools', 'reference-calibri.odt');
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
          const refDoc = path.join(__dirname, 'tools', 'reference-calibri.odt');
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
        failed,
        outDir: 'moje_dok/odt'
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
  res.json({ ok: true, exported, outDir: 'moje_dok/odt' });
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

// Extract the METRYKA block from an assistant reply.
function extractMetryka(text) {
  if (!text) return null;
  const up = String(text).toUpperCase();
  const idx = up.indexOf("METRYKA");
  if (idx === -1) return null;
  const tail = String(text).slice(idx, idx + 1500);
  // Prefer the line containing METRYKA, else the whole tail.
  const lineMatch = tail.split("\n").find((l) => l.toUpperCase().includes("METRYKA"));
  const line = lineMatch || tail;
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
        tags: { matchPct: null, german: null, status: null }
      }, null, 2));
      const index0 = loadConversationsIndex();
      index0.unshift({ id: convIdNew, name: "Bulk analysis...", createdAt: now0, updatedAt: now0,
        messageCount: 0, tags: { matchPct: null, german: null, status: null } });
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
      fs.writeFileSync(path.join(convDir, "conversation.json"), JSON.stringify(full, null, 2));
      const index = loadConversationsIndex();
      const entry = index.find((c) => c.id === convId);
      if (entry) { entry.name = name; entry.updatedAt = now; entry.messageCount = messages.length;
        if (met && met.metrics.interview !== null) entry.tags.matchPct = met.metrics.interview;
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
  // RAG files from the most recently updated conversation.
  const index = loadConversationsIndex();
  const latest = index.slice().sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0];
  let ragFiles = [];
  if (latest) {
    const conv = loadConversation(latest.id);
    if (conv && Array.isArray(conv.selectedFiles)) ragFiles = conv.selectedFiles;
  }
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();
  const send = (obj) => { try { res.write(JSON.stringify(obj) + "\n"); } catch (_) {} };
  send({ event: "start", total: offers.length, ragFiles: ragFiles.length });
  for (const offer of offers) {
    send({ event: "offer-start", title: offer.title || "", company: offer.company || "" });
    const r = await runBulkOffer(offer, ragFiles, modelIndex);
    if (r.ok) send({ event: "offer-done", convId: r.convId, name: r.name, metrics: r.metrics });
    else send({ event: "offer-failed", error: r.error, title: offer.title || "", company: offer.company || "" });
  }
  send({ event: "done" });
  res.end();
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

app.listen(PORT, () => {
  console.log(`App running at http://localhost:${PORT}`);
});
