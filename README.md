# Job Offer Coach

A web application for preparing job offers with the help of an AI model in the cloud (Ollama Cloud). Runs in the browser; the backend is Node.js + Express.

<img width="1334" height="856" alt="job-offer" src="https://github.com/user-attachments/assets/d81f5365-9139-4a17-92d5-70e5ad56a560" />


## License

Attribution-Required **Non-Commercial No-Derivatives** (`AN-NC-ND`, custom, CC BY-NC-ND-inspired — see `LICENSE`):

- ✅ Free to **use** and **redistribute verbatim** for non-commercial purposes
- ✋ **Attribution always required** — visible credit: *Tomasz Kuehn, "AI Chat — Job Offers"*
- 🚫 **No modifications** — redistribution of the original, unmodified code only
- 🚫 **No commercial use** — commercial licensing on request: tomasz.kuehn@gmail.com

## Features

- **Chat with an AI model** — enter a job offer description and get tailored interview prep, positioning advice, and answers grounded in your documents. Context grows with each exchange (full history is sent to the model).
- **Streaming responses** — answers appear live, token-by-token, with incremental markdown rendering (marked.js) and a model badge on each response.
- **Model configuration** — multiple named model slots (endpoint, API key, model id, per-model prompt); the model catalogue can be fetched live from the provider (`/api/tags`), so switching models is a config change, not a code change.
- **RAG files (no embeddings)** — TXT/MD/PDF files attached as text to every request. Files are **content-addressed** (see below) and attached **per conversation**.
- **Preview before sending** — an overlay showing the full payload (system prompt + RAG files + history), with the option to block the request.
- **Conversations** — save, rename, and restore from history. A new conversation keeps the RAG selection and model; the current conversation is highlighted in green on the list, and browsing archives does not reorder the list (ordering is by last *content* change, not last access).
- **Text highlights** — select any text in the chat; a floating **Highlight** button appears just below the selection (Esc hides it). Clicking it wraps the exact selection in a yellow `<mark>` — non-destructively (only text nodes are split, element structure is never moved), so multi-paragraph selections keep their formatting and text. Multiple highlights are allowed; they are in-memory only and disappear when the chat is re-rendered (switching conversations, new chat, sending a message). The RAG selection is seeded from the global config on a fresh page load, so the RAG panel is never empty after a refresh.
- **Bulk analysis** — pick one or more offer files (the **CSV export** from the LinkedIn extension options page — `linkedin-jobs.csv` with `jobId,title,company,location,workplaceType,url,status,savedAt,descriptionText` headers, or the legacy `job.txt`: full LinkedIn HTML snapshots, one or many offers per file, or the plain-text "copy" format `title / company / location / url / --- / description`), tick the offers to process, and GEM automatically creates a conversation per offer with the **RAG file set of the latest conversation**, sends the offer, waits for the full reply, renames the conversation to `Company — Position`, and extracts the **METRYKA** block (interview / employment / role fit / satisfaction / salary / recommend %) into `data/metrics.json`. A failed offer deletes its conversation and is retried once; a second failure skips it. Progress is streamed per offer (NDJSON) and shown as status chips in the dialog. Offers already analyzed in stored conversations (≥ 70 % similarity, same algorithm as the preview warning) are **highlighted in yellow and unchecked by default**, with a "Already analyzed in: …" badge. Each row shows the CSV `Status` value as a chip (apply / applied / to-consider / german / ignored); clicking the row body opens a **full offer preview** (Esc / ✕ / backdrop closes).
- **Metrics view** — a "Metrics" button lists all saved metrics sorted by the *Recommend* score (best first); each row shows company, position, application status (to apply / applied / not applying), all six METRYKA percentages and the date; clicking a row opens the conversation the metric came from. The status cell is a shortcut tag editor: clicking it cycles `to apply` → `not applying` → clear (and saves via the tags endpoint, so the conversation tags and the `metrics.json` entry stay in sync). Manual chats also get metrics automatically: when a saved conversation's **fresh** reply contains a METRYKA block, it is extracted on save — tags (I/S %) are updated and a `metrics.json` entry is upserted (re-analysis replaces the old values; manual tag edits during ordinary browsing are never overwritten). Company/position for manual chats are inferred from the first user message (`title`, `Employers: …` or `title / company / location / url` layout).
- **Backup & restore** — a "Backup & restore" button downloads a ZIP of the whole `data/` directory (config incl. API keys, conversations, RAG files, metrics); restoring from a ZIP (with confirmation) wipes and replaces the current data.
- **Live context-size indicator** — a badge next to the model switcher shows the estimated context size in tokens (green / yellow / red thresholds) so cost and limit pressure are visible before sending.
- **Job search (internet)** — a "Job search (internet)" button opens an overlay that fetches **real offers** from public job APIs and portals, pre-filters them locally against your criteria (keywords, location alternatives like `Hamburg, Poznan, remote`, language, workplace chips remote/onsite/hybrid, selectable sources), then lets **your configured AI model** do the final ranking/matching (the AI never invents offers — ids are cross-checked against the fetched pool). Two-step flow: **Search** fetches and builds the prompt (no model call), the prompt is shown **per batch for review/editing** (Alt+↑/↓, skip batch), then **Approve & run AI**. Results can be **Download**ed as a bulk-import JSON (`gem-job-search-YYYYMMDD-HHMM.json`) or **loaded straight into Bulk analysis**. Sources fetched + parsed server-side (scraped portals read the listing page, then each offer's detail page `schema.org JobPosting` JSON-LD, throttled ~1.2–2 s per request): arbeitnow, remotive, jobicy, remoteok, weworkremotely RSS, themuse, **XING** (DACH), **Stepstone** (DE), **NoFluffJobs** (PL); **pracuj.pl** is wired but currently **blocked by Cloudflare** (needs a real browser) and reports that error instead of silently returning nothing. An offline **sample** source (8 built-in offers) makes the whole flow demo-able and testable with no network.

## Content-addressed RAG files

Every uploaded file is stored under a name derived from its content:
`<first 8 chars of SHA-256>_<clean original name>`, e.g.
`ba15a635_CV_Jan_Kowalski_extracted.txt`.

Consequences:

- **No duplicates** — uploading the same content again (even under a different filename) does not store a second copy; the existing file is attached ("reused") to the current conversation instead.
- **Immutable versions** — a changed document gets a new hash, so it becomes a new file; older conversations keep referencing the exact version they were created with. Their context never changes retroactively.
- **Shared storage** — files live in a single `data/uploads/` pool; conversations store only the list of file names.

The RAG list in the UI shows **only the files attached to the current conversation**.

## Requirements

- Node.js 18+ (uses the global `fetch`)
- [pandoc](https://pandoc.dev) on PATH — only for the ODT export feature

## Running the app

No commands needed for daily use:

1. The app **starts automatically at Windows logon** — look for the **GEM tray icon** next to the clock.
2. **Left-click the tray icon** (or right-click → **Open GEM**, or double-click the **Job Offer Coach** desktop shortcut) — the app opens in your browser at http://localhost:3000. If the server happens to be down, opening it starts the server first.
3. **Green icon = running, red = stopped.** If the server crashes, the tray **restarts it automatically** and shows a notification. After 3 failed restart attempts it stays stopped: right-click the icon → **Start / Restart server** (details in `%TEMP%\GEM-tray.log`). **Stop server** switches the auto-restart off until the next manual start.

### Developer run (from source)

```bash
npm install
npm start
```

Open in your browser: http://localhost:3000

### Installer (Windows)

Build a distributable package with:

```bash
powershell -ExecutionPolicy Bypass -File tools\make-installer.ps1
```

This produces `dist\GEM-Setup-<version>.zip` (app files + installer, no `node_modules`/`data`). The `dist/` directory is not committed — build the zip locally and distribute it separately. To install, unzip it and double-click `install.cmd`, or run:

```bash
powershell -ExecutionPolicy Bypass -File tools\install.ps1 [-InstallDir <path>] [-NoStartup] [-NoStart]
```

Default install dir is `%LOCALAPPDATA%\GEM`. The installer detects Node.js (same nvm-aware logic as the tray; offers `winget` install of Node LTS if missing), runs `npm ci --omit=dev`, writes an `uninstall.ps1` (stops server + tray, removes the startup shortcut and install dir), creates the logon autostart shortcut (`shell:startup\GEM Tray.lnk`, hidden window, single instance via a mutex) and starts the tray. `data/` is never touched on reinstall/upgrade. Diagnostics are logged to `%TEMP%\GEM-tray.log`.

## Configuration

In the sidebar:

1. **Model configuration**
   - **Endpoint** — defaults to `https://ollama.com/api/chat` (Ollama Cloud API)
   - **API key** — your Ollama Cloud key (from https://ollama.com/settings/keys)
   - **Model** — e.g. `deepseek-v4-flash:0731` (or use **Fetch models** to pick from the live catalogue)
2. **Expected response (prompt)** — instructions for the model on how to phrase the response.
   - **Owner name** — **required** for the ODT export: your full name (e.g. `Jan Kowalski`); the export uses it to recognize the CV heading (`# JAN KOWALSKI`) and the signature block in cover letters. Without it the export refuses to run (HTTP 422 with a hint); nothing is guessed.
   - **Export directory for ODT files** — where the CV / cover letter documents land. Empty = default `moje_dok/odt` inside the app folder; a relative path is resolved against the app folder, an absolute path is used as-is. Use **Browse…** to pick it from a filesystem explorer (drives first, then subdirectories, parent navigation). Saving validates the directory: it is created when missing and write access is checked (an unusable path is rejected with a clear error instead of being stored).
3. **Files (RAG)** — upload files to attach them to the current conversation.

Click **Save configuration** (the button pulses red when there are unsaved changes).

## Usage

1. Enter a job offer description in the chat field and click **Send**.
2. A **preview** of the full content that will be sent to the model appears.
   - **Send to model** — continues.
   - **Cancel / ✕** — blocks the request (the message stays in history; you can edit and resend it).
3. The model's response **streams in live** with markdown rendering. Continue the conversation — the context grows.

### Conversations

- **+ New conversation** — asks for a name for the conversation being closed, but **only when it still carries the default `Conversation` name** (already-renamed conversations keep their name untouched and the new one starts immediately). The new one starts with the default `Conversation` name (the creation date/time shown on the list is generated separately), keeping the RAG selection and model.
- Clicking a name in the list **restores** the conversation together with its RAG files. The browsed conversation stays in place on the list and is highlighted in green.
- The list is **scrollable** (fixed height) and has a **search box**: matching
  covers conversation **titles** and the **first user prompt** only — assistant
  replies (generated CVs / cover letters) are excluded, so a phrase from a
  document does not match every conversation. Prompt matches show
  a snippet under the name. **Esc** clears the search; a subtle **✕ inside
  the field** (same style as the model-slot remove buttons) appears while a
  query is set and click-restores the unfiltered list.
- **✎** renames, **✕** deletes a conversation. Renaming opens an in-app dialog:
  you edit only the name — the creation date and time shown below the name on
  the list are managed by the app and are never part of the editable name.
  Each list entry displays the conversation's **creation date and time**
  (`dd/mm/yyyy, hh:mm`) under the name.
- **🏷 tags** — each conversation can carry optional tags shown as badges on
  the list: **match probability** — interview chance, badge prefixed **I** (`I 35%`),
  **job satisfaction** — % auto-filled from the METRYKA metric of bulk analysis,
  badge prefixed **S** (`S 70%`), **German requirement**
  (`DE required` / `no DE`), and the application status (**to apply** /
  **applied** / **not applying**). Open the tag editor with the 🏛 button and
  either fill the fields manually or press **Suggest from content** — the server
  scans the conversation for the newest interview-chance percentage, German
  requirement statements, and "applied" / "don't apply" verdicts (satisfaction
  comes from metrics.json and is backfilled at server start; the search box
  also has an **to apply ▾** filter chip that narrows the list to conversations
  tagged `to_apply`).
- A model response keeps **streaming in the background** when you switch to another conversation (or start a new one) — when the stream finishes, the reply is appended to the conversation it belongs to and saved automatically.
- The **preview overlay** is keyboard-driven: **Enter** sends, **Esc** cancels.
- **Duplicate-offer warning** — when the submitted message resembles the first message of an already-analyzed conversation (≥ 70 % similarity), the preview shows a warning listing those conversations with their match percentages. The send itself is never blocked. Similarity takes the **max** of whole-text token overlap (Jaccard) and **5-word-sequence containment**, so offers with a different header/intro (same body from another source) are still caught.

### Exporting CV & Cover Letters (ODT)

When the model produces an application package (CV + cover letter sections),
the sidebar button **"Export CV & Cover Letter (ODT)"** extracts the sections
and converts them to OpenDocument Text with **pandoc** (requires `pandoc`
on PATH).

- **Section detection is format-tolerant**: numbered headings (`### 4a.`, `4b.`, `4c.`),
  natural-language headings on H2–H4 (`## CV (English…)`, `### Cover Letter (EN)`,
  `## Anschreiben (Deutsch…)`), and standalone CV regeneration messages
  (`# Jan Kowalski …`, also inside a ```markdown fence) are all recognized.
- Each part is taken from the **latest** assistant message containing it —
  a full package, a partial package update, or a standalone CV regeneration
  all count, so the newest version always wins.
- **File names** follow `<conversation>_<CV | cover | Anschreiben>.odt` —
  e.g. `RWE_CV.odt`, `RWE_cover.odt` (English letter), `RWE_Anschreiben.odt`
  (German letter).
  Re-exporting **unchanged** content reuses the existing file (content-hash
  manifest keyed by conversation ID — stable across renames). Export always
  reads **only the current conversation**.
- **Partial-failure handling**: if a document cannot be written (e.g. the file
  is open in LibreOffice), the export retries once under a timestamped
  alternative name; the UI reports which parts succeeded, which failed, and
  suggests closing the file and re-exporting.
- Output goes to the configured export directory (sidebar field / **Browse…**; default `moje_dok/odt/` inside the app folder — "moje dokumenty" = *my documents*, Polish folder name kept for local continuity); styling comes from a bundled reference
  document (`tools/reference-segoui.odt`): Segoe UI body font with Segoe UI
  Semibold headings, 10.5 pt base size, compact paragraph spacing, table borders (pandoc emits
  borderless tables — the server patches them in), single-line horizontal
  rules, **no page numbers** (empty footer), and `—`/`–` converted to plain `-`.
  (Segoe UI replaced Calibri in Sept 2026: the 2023/24 Calibri redesign ships a
  contextual `ti`/`fi` ligature that LibreOffice's PDF export renders with a
  zero-advance glyph, visually fusing letters.)
- **Unavailable export directory**: if the configured directory cannot be
  created or written to at export time (unplugged drive, removed folder,
  permissions), the export fails early with a clear message naming the path
  and suggesting to re-check it (Browse…) — no partial state is left behind.

## Project structure

```
.
├── server.js                      # Express backend: config, CAS files, conversations, streaming proxy, ODT export
├── package.json
├── tests/
│   ├── run.js                     # Test runner: unit + API suites (npm test)
│   ├── unit.test.js               # Pure-function tests (extractMetryka, offer parsing, tags, similarity, job sources/JSON-LD)
│   ├── api.test.js                # API integration tests — child server on a sandbox GEM_DATA_DIR
│   └── ui.test.js                 # UI tests — headed Edge window driven by Playwright (npm run test:ui)
├── tools/
│   ├── extract-package.js         # CLI version of the package export (pandoc)
│   ├── reference-segoui.odt       # Pandoc reference doc: Segoe UI fonts, sizes, spacing, HR style
│   └── reference-calibri.odt      # Legacy Calibri reference doc (fallback)
├── public/
│   └── index.html                 # Frontend (single file: config panel + chat UI)
├── moje_dok/                      # Local output ("my documents", git-ignored)
│   └── odt/                       # Exported CV / cover letter files + per-conversation manifests
└── data/                          # Created automatically
    ├── config.json                # Model slots, active model, system prompt, exportsDir
    ├── uploads/                   # Content-addressed RAG file pool
    ├── conversations.json         # Conversations index (ordered by last content change)
    ├── conversations/<id>/        # Saved conversations (messages + selectedFiles)
    └── .cas-migrated              # One-time legacy→CAS migration flag
```

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/config` | Get configuration and file list |
| POST | `/api/config` | Save configuration (`exportsDir` is validated: created if missing, write access checked) |
| POST | `/api/files` | Upload files (multipart); identical content is deduplicated and returned as `reused` |
| DELETE | `/api/files/:name` | Delete a file (detaches it from all conversations) |
| GET | `/api/fs/roots` | Drives / known folders for the exports-directory picker (`{ roots: [{ path, label }] }`) |
| GET | `/api/fs/list?path=` | List subdirectories of a folder for the picker (`{ path, parent, dirs }`; 404 on missing, 400 on a file, 403 on unreadable) |
| POST | `/api/preview` | Build the payload for preview (without sending) |
| POST | `/api/chat` | Send messages to the model (non-streaming) |
| POST | `/api/chat/stream` | Streaming chat: proxies upstream NDJSON, emits plain-text chunks, model name in the `X-Model` header |
| POST | `/api/context-size` | Estimate context size (chars + tokens) for the current selection |
| GET | `/api/conversations` | List conversations |
| GET | `/api/conversations/search?q=` | Search conversations by title or first user prompt (returns index entries with `matchType` and `snippet` for prompt matches; assistant replies are not searched) |
| GET | `/api/conversations/:id` | Get a conversation (read-only; does not touch global config) |
| POST | `/api/conversations` | Create or update a conversation (`id` optional); bumps `updatedAt` only when content changes |
| POST | `/api/conversations/:id/rename` | Rename a conversation |
| POST | `/api/conversations/:id/tags` | Set conversation tags (`{ matchPct, satisfactionPct, german, status }`; `matchPct` / `satisfactionPct` 0–100 or `null` (satisfaction is auto-filled from METRYKA and backfilled at server start), `german` = `required` / `not_required` / `null`, `status` = `to_apply` / `applied` / `not_applying` / `null`) |
| POST | `/api/conversations/:id/tags/analyze` | Suggest tags from conversation content (does not save) |
| DELETE | `/api/conversations/:id` | Delete a conversation |
| POST | `/api/export-package` | Extract CV + cover letters from the latest package in a conversation and convert them to ODT (`{ conversationId }`); returns `207` with a `failed` list on partial success, `500` when the export directory is unavailable |
| POST | `/api/bulk/parse` | Parse an uploaded offer file (multipart `file`; CSV export / HTML snapshots / plain text); returns `{ offers: [{ title, company, location, url, description }] }` |
| POST | `/api/bulk/run` | Run bulk analysis (`{ offers, modelIndex }`); NDJSON progress events `start` / `offer-start` / `offer-done` / `offer-failed` / `done` |
| POST | `/api/job-search/preview` | Fetch offers from the internet and build AI prompts — no model call; NDJSON (`source-start` / `source-done` / `source-failed` / `prefilter` / `preview`), `searchId` caches the pool 30 min |
| POST | `/api/job-search/run` | Run the AI over approved/edited prompts (`{ searchId, batches, modelIndex }`); streams per-batch results and composes bulk-format offers |
| POST | `/api/job-search` | One-shot job search (fetch + AI matching) for programmatic callers/tests |
| GET | `/api/metrics` | All saved METRYKA entries, sorted by `recommend` (desc); each entry carries `company` / `jobTitle` / `location` / `url` / `status` (`to_apply` / `applied` / `not_applying`) |
| DELETE | `/api/metrics/:convId` | Delete the metric entry of a conversation |
| GET | `/api/backup` | Download a ZIP of the whole `data/` directory (config incl. API keys, conversations, RAG files, metrics) with a `gem-backup.json` manifest |
| POST | `/api/restore` | Restore from a backup ZIP (multipart `file`); requires the `gem-backup.json` manifest, wipes and replaces all current data |

Chat requests (`preview`, `chat`, `chat/stream`, `context-size`) accept
`{ messages, modelIndex, selectedFiles, conversationId }` — the RAG file
selection travels with each request, so the server stays stateless.

## Testing

The test suite never touches the real application data — API and UI tests spawn the server with `GEM_DATA_DIR` pointed at a throwaway sandbox under the OS temp dir.

| Command | What it does |
| --- | --- |
| `npm test` | Unit tests (pure functions: `extractMetryka`, offer parsing, tag normalization, duplicate similarity, job sources/JSON-LD) + API integration tests (config/conversations/tags/rename sync, exportsDir persist, fs browser endpoints, bulk parse/refresh, context size, delete cleanup, job-search preview/run offline flow) via `node --test` |
| `npm run test:ui` | UI tests in a **dedicated headed Edge window** driven by Playwright (`playwright-core`, `channel: msedge`, no browser download needed): title render, sandbox-only conversation list isolation, metrics overlay, text highlight flow, highlight reset on conversation switch, conversation search (incl. the in-field ✕ clear), job-search overlay with the offline sample |

Regression coverage includes the bare `METRYKA` heading case (values on a separate line) that previously swallowed bulk metrics.

## Notes

- RAG files are attached as plain text to the prompt (no embeddings/vectors) — the right trade-off when the corpus is a handful of personal documents.
- The API key is stored locally in `data/config.json` — do not share this file. Keys are never rendered in plain text in the UI (password fields) and are not needed by any third party; the frontend fetches the config (incl. the key for the config panel) and the model calls are proxied through the backend. All requests stay on the local machine (`server.js` listens on `127.0.0.1`).
- The app runs locally; it is not intended for public deployment without security measures.
