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
app.post('/api/preview', async (req, res) => {
  const { messages, modelIndex, selectedFiles, conversationId } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'No messages' });
  }
  try {
    const { endpoint, apiKey, model, payload, modelIndex: idx } = await buildPayload(messages, modelIndex, selectedFiles, conversationId);
    res.json({ endpoint, apiKey, model, payload, modelIndex: idx });
  } catch (e) {
    res.status(500).json({ error: 'Could not prepare preview: ' + e.message });
  }
});

// ---- Conversations ----
app.get('/api/conversations', (req, res) => {
  res.json(loadConversationsIndex());
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
    modelIndex: (modelIndex !== undefined ? modelIndex : null)
  };
  fs.writeFileSync(path.join(convDir, 'conversation.json'), JSON.stringify(conv, null, 2));

  const entry = {
    id: convId,
    name,
    createdAt,
    updatedAt,
    messageCount: messages.length
  };
  const filtered = index.filter((c) => c.id !== convId);
  filtered.unshift(entry); // updated/created conversation jumps to the top
  saveConversationsIndex(filtered);

  res.json({ ok: true, id: convId, updatedAt, updated: changed });
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
  const isCv = (m) => /###\s*4a\./i.test(m.content) || /^#\s+.*KUEHN/m.test(m.content);
  const isClEn = (m) => /###\s*4b\./i.test(m.content) || (/Cover Letter/i.test(m.content) && /\(English\)/i.test(m.content));
  const isClDe = (m) => /###\s*4c\./i.test(m.content) || (/Cover Letter/i.test(m.content) && /Deutsch/i.test(m.content));
  const latest = (pred) => [...assistants].reverse().find(pred);

  const cvMsg = latest(isCv);
  const clEnMsg = latest(isClEn);
  const clDeMsg = latest(isClDe);
  if (!cvMsg && !clEnMsg && !clDeMsg) {
    return res.status(422).json({ error: 'No application package (CV + Cover Letter) found in this conversation' });
  }

  // Title from the newest message that has one
  const titleMsg = [cvMsg, clEnMsg, clDeMsg].filter(Boolean)
    .find((m) => /^#\s+(?:Pakiet|PAKIET|AKTUALIZACJA)/m.test(m.content) || /^#\s+.*KUEHN/m.test(m.content));
  const mdOf = (m) => (m ? m.content : '');
  const titleSrc = mdOf(titleMsg || cvMsg);
  const title = (titleSrc.match(/^#\s+(?:Pakiet|PAKIET|AKTUALIZACJA)[^\n]*/m)
    || titleSrc.match(/^#\s+.*KUEHN[^\n]*/m)
    || ['Application package'])[0].replace(/^#\s+/i, '');

  const pandoc = await new Promise((resolve) => {
    execFile('pandoc', ['--version'], (err) => resolve(!err));
  });
  if (!pandoc) {
    return res.status(500).json({ error: 'pandoc not found on this system' });
  }

  // File names start with the conversation name
  const safeName = String(conv.name || 'conversation')
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 60);
  const outDir = path.join(__dirname, 'moje_dok', 'odt');
  fs.mkdirSync(outDir, { recursive: true });

  // Cut a subsection (e.g. "### 4a.") from a message, up to the next heading
  function cutSection(md, startMarker) {
    const s = md.indexOf(startMarker);
    if (s === -1) return null;
    const rest = md.slice(s + startMarker.length);
    const m = rest.match(/^###|^## /m);
    return (m ? rest.slice(0, m.index) : rest).trim();
  }

  // Standalone CV (regenerated outside a package): whole message is the CV,
  // skip the H1 title line — the document gets the package title anyway.
  function standaloneCv(md) {
    if (/^#\s+.*KUEHN/m.test(md)) {
      return md.replace(/^#.*\n/, '').trim();
    }
    return null;
  }

  // Remove AI-typical em dashes: "word — word" -> "word - word"
  function stripEmDashes(text) {
    return text.replace(/—/g, '-').replace(/–/g, '-');
  }

  const cvFromPkg = cvMsg ? cutSection(mdOf(cvMsg), '### 4a.') : null;
  const parts = [
    ['CV', cvFromPkg || (cvMsg ? standaloneCv(mdOf(cvMsg)) : null)],
    ['CoverLetter_EN', clEnMsg ? cutSection(mdOf(clEnMsg), '### 4b.') : null],
    ['CoverLetter_DE', clDeMsg ? cutSection(mdOf(clDeMsg), '### 4c.') : null],
  ];

  // Each generated document gets an incrementing index: _CV_1.odt,
  // _CoverLetter_EN_2.odt, ... so consecutive exports never overwrite
  // earlier versions.
  function nextIndex(kind) {
    const re = new RegExp(`^${safeName}_${kind}(?:_(\\d+))?\\.odt$`);
    let max = 0;
    for (const f of fs.readdirSync(outDir)) {
      const m = f.match(re);
      if (m) max = Math.max(max, Number(m[1] || 1));
    }
    return max + 1;
  }

  // Re-exporting the SAME content must not create a new indexed version.
  // A per-conversation manifest maps each part to the content hash of its
  // last export; identical content reuses the existing file.
  const manifestPath = path.join(outDir, safeName + '.manifest.json');
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
    for (const [kind, content] of parts) {
      if (!content) continue;
      const hash = contentHash(stripEmDashes(content));
      if (manifest[kind] && manifest[kind].hash === hash && fs.existsSync(path.join(outDir, manifest[kind].file))) {
        // Same content as last export -> reuse the existing file
        exported.push(manifest[kind].file);
        continue;
      }
      const base = `${safeName}_${kind}_${nextIndex(kind)}`;
      const mdTmp = path.join(outDir, base + '.md');
      fs.writeFileSync(mdTmp, `# ${stripEmDashes(title)}\n\n${stripEmDashes(content)}`, 'utf8');
      tmpFiles.push(mdTmp);
      const odt = path.join(outDir, base + '.odt');
      const refDoc = path.join(__dirname, 'tools', 'reference-liberation.odt');
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
      }
    }
    if (manifestDirty) fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
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
