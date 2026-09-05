# AI Chat — Job Offers

A web application for preparing job offers with the help of an AI model in the cloud (Ollama Cloud). Runs in the browser; the backend is Node.js + Express.

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
- **Live context-size indicator** — a badge next to the model switcher shows the estimated context size in kB (green / yellow / red thresholds) so cost and limit pressure are visible before sending.

## Content-addressed RAG files

Every uploaded file is stored under a name derived from its content:
`<first 8 chars of SHA-256>_<clean original name>`, e.g.
`ba15a635_CV_Tomasz_Kuehn_extracted.txt`.

Consequences:

- **No duplicates** — uploading the same content again (even under a different filename) does not store a second copy; the existing file is attached ("reused") to the current conversation instead.
- **Immutable versions** — a changed document gets a new hash, so it becomes a new file; older conversations keep referencing the exact version they were created with. Their context never changes retroactively.
- **Shared storage** — files live in a single `data/uploads/` pool; conversations store only the list of file names.

The RAG list in the UI shows **only the files attached to the current conversation**.

## Requirements

- Node.js 18+ (uses the global `fetch`)
- [pandoc](https://pandoc.dev) on PATH — only for the ODT export feature

## Installation and running

```bash
npm install
npm start
```

Open in your browser: http://localhost:3000

## Configuration

In the sidebar:

1. **Model configuration**
   - **Endpoint** — defaults to `https://ollama.com/api/chat` (Ollama Cloud API)
   - **API key** — your Ollama Cloud key (from https://ollama.com/settings/keys)
   - **Model** — e.g. `deepseek-v4-flash:0731` (or use **Fetch models** to pick from the live catalogue)
2. **Expected response (prompt)** — instructions for the model on how to phrase the response.
3. **Files (RAG)** — upload files to attach them to the current conversation.

Click **Save configuration** (the button pulses red when there are unsaved changes).

## Usage

1. Enter a job offer description in the chat field and click **Send**.
2. A **preview** of the full content that will be sent to the model appears.
   - **Send to model** — continues.
   - **Cancel / ✕** — blocks the request (the message stays in history; you can edit and resend it).
3. The model's response **streams in live** with markdown rendering. Continue the conversation — the context grows.

### Conversations

- **+ New conversation** — asks for a name; the typed name is applied to the conversation being closed, and the new one starts with a default timestamped name, keeping the RAG selection and model.
- Clicking a name in the list **restores** the conversation together with its RAG files. The browsed conversation stays in place on the list and is highlighted in green.
- The list is **scrollable** (fixed height) and has a **search box**: matching
  covers conversation **titles** and **message contents** — body matches show
  a snippet under the name. **Esc** clears the search.
- **✎** renames, **✕** deletes a conversation.
- While a model response is **streaming**, switching conversations (or starting a new one) asks for confirmation — the in-flight reply would be lost.
- The **preview overlay** is keyboard-driven: **Enter** sends, **Esc** cancels.

### Exporting CV & Cover Letters (ODT)

When the model produces an application package (CV + cover letter sections),
the sidebar button **"Export CV & Cover Letter (ODT)"** extracts the sections
and converts them to OpenDocument Text with **pandoc** (requires `pandoc`
on PATH).

- **Section detection is format-tolerant**: numbered headings (`### 4a.`, `4b.`, `4c.`),
  natural-language headings on H2–H4 (`## CV (English…)`, `### Cover Letter (EN)`,
  `## Anschreiben (Deutsch…)`), and standalone CV regeneration messages
  (`# Tomasz Kuehn …`, also inside a ```markdown fence) are all recognized.
- Each part is taken from the **latest** assistant message containing it —
  a full package, a partial package update, or a standalone CV regeneration
  all count, so the newest version always wins.
- **Manual source pin**: if auto-detection fails, click the **⚐** button on any
  assistant message to pin it as the export source (📌 *export source* label,
  one per conversation, survives saves); click again to unpin and return to
  automatic detection.
- **Indexed file names**: every export creates new files, never overwrites:
  `<conversation>_CV_1.odt`, `..._CV_2.odt`, `..._CoverLetter_EN_3.odt`, …
  Re-exporting **unchanged** content reuses the existing file (content-hash
  manifest keyed by conversation ID — stable across renames) instead of
  bumping the index. Export always reads **only the current conversation**.
- **Partial-failure handling**: if a document cannot be written (e.g. the file
  is open in LibreOffice), the export retries once under a timestamped
  alternative name; the UI reports which parts succeeded, which failed, and
  suggests closing the file and re-exporting.
- Output goes to `moje_dok/odt/`; styling comes from a bundled reference
  document (`tools/reference-liberation.odt`): Liberation Sans/Serif fonts,
  10.5 pt base size, compact paragraph spacing, table borders (pandoc emits
  borderless tables — the server patches them in), single-line horizontal
  rules, **no page numbers** (empty footer), and `—`/`–` converted to plain `-`.

## Project structure

```
.
├── server.js                      # Express backend: config, CAS files, conversations, streaming proxy, ODT export
├── package.json
├── tools/
│   ├── extract-package.js         # CLI version of the package export (pandoc)
│   └── reference-liberation.odt   # Pandoc reference doc: fonts, sizes, spacing, HR style
├── public/
│   └── index.html                 # Frontend (single file: config panel + chat UI)
├── moje_dok/                      # Local output (git-ignored)
│   └── odt/                       # Exported CV / cover letter files + per-conversation manifests
└── data/                          # Created automatically
    ├── config.json                # Model slots, active model, system prompt
    ├── uploads/                   # Content-addressed RAG file pool
    ├── conversations.json         # Conversations index (ordered by last content change)
    ├── conversations/<id>/        # Saved conversations (messages + selectedFiles)
    └── .cas-migrated              # One-time legacy→CAS migration flag
```

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/config` | Get configuration and file list |
| POST | `/api/config` | Save configuration |
| POST | `/api/files` | Upload files (multipart); identical content is deduplicated and returned as `reused` |
| DELETE | `/api/files/:name` | Delete a file (detaches it from all conversations) |
| POST | `/api/preview` | Build the payload for preview (without sending) |
| POST | `/api/chat` | Send messages to the model (non-streaming) |
| POST | `/api/chat/stream` | Streaming chat: proxies upstream NDJSON, emits plain-text chunks, model name in the `X-Model` header |
| POST | `/api/context-size` | Estimate context size (chars + tokens) for the current selection |
| GET | `/api/conversations` | List conversations |
| GET | `/api/conversations/search?q=` | Search conversations by title or message content (returns index entries with `matchType` and `snippet` for body matches) |
| GET | `/api/conversations/:id` | Get a conversation (read-only; does not touch global config) |
| POST | `/api/conversations` | Create or update a conversation (`id` optional); bumps `updatedAt` only when content changes |
| POST | `/api/conversations/:id/rename` | Rename a conversation |
| POST | `/api/conversations/:id/export-marker` | Pin / unpin the manual export-source message (`{ msgIndex: number|null }`) |
| DELETE | `/api/conversations/:id` | Delete a conversation |
| POST | `/api/export-package` | Extract CV + cover letters from the latest package (or the pinned message) in a conversation and convert them to ODT (`{ conversationId }`); returns `207` with a `failed` list on partial success |

Chat requests (`preview`, `chat`, `chat/stream`, `context-size`) accept
`{ messages, modelIndex, selectedFiles, conversationId }` — the RAG file
selection travels with each request, so the server stays stateless.

## Notes

- RAG files are attached as plain text to the prompt (no embeddings/vectors) — the right trade-off when the corpus is a handful of personal documents.
- The API key is stored locally in `data/config.json` — do not share this file. Keys are never exposed to the frontend; all provider calls are proxied through the backend.
- The app runs locally; it is not intended for public deployment without security measures.