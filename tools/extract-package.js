#!/usr/bin/env node
/*
 * extract-package.js — extract CV / Cover Letter sections from saved
 * application-package chat messages and convert them to ODT via pandoc.
 * Uses the same marker-based extraction + plausibility gate + latest-wins
 * selection as the app export (POST /api/export-package).
 *
 * Usage:
 *   node extract-package.js                 list conversations with packages
 *   node extract-package.js <convId> [n]    extract package #n (default: last)
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { pickPackageParts } = require('../server.js');

const CONV_DIR = path.join(__dirname, '..', 'data', 'conversations');
const OUT_DIR = path.join(__dirname, '..', 'moje_dok', 'odt');
const PANDOC = 'pandoc';

// The owner's name is the CV document identity (H1 name line) — loaded from
// data/config.json exactly like the server export does (loadConfig strips
// the BOM; PowerShell pipelines must not re-add it).
function ownerNameFromConfig() {
  const cfg = path.join(__dirname, '..', 'data', 'config.json');
  try {
    let raw = fs.readFileSync(cfg, 'utf8');
    raw = raw.replace(/^\uFEFF/, '');
    return String((JSON.parse(raw).ownerName) || '').trim();
  } catch (_) {
    return '';
  }
}

function slug(s) {
  return s.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_').slice(0, 40);
}

function toOdt(md, outFile) {
  const tmp = path.join(OUT_DIR, path.basename(outFile) + '.md');
  fs.writeFileSync(tmp, md, 'utf8');
  const refDoc = path.join(__dirname, fs.existsSync(path.join(__dirname, 'reference-segoui.odt')) ? 'reference-segoui.odt' : 'reference-calibri.odt');
  const args = [tmp, '--from=gfm'];
  if (fs.existsSync(refDoc)) args.push(`--reference-doc=${refDoc}`);
  execFileSync(PANDOC, [...args, '-o', path.join(OUT_DIR, outFile)], { stdio: 'inherit' });
  fs.unlinkSync(tmp);
}

const stripEmDashes = (t) => String(t || '').replace(/—/g, '-').replace(/–/g, '-');

function main() {
  const ownerName = ownerNameFromConfig();
  if (!ownerName) {
    console.error('Owner name not configured — set "ownerName" in data/config.json (the sidebar "Owner name" field in the app).');
    process.exit(1);
  }

  if (process.argv.length < 3) {
    console.log('Saved application packages:');
    let n = 0;
    for (const dir of fs.readdirSync(CONV_DIR)) {
      const file = path.join(CONV_DIR, dir, 'conversation.json');
      if (!fs.existsSync(file)) continue;
      const conv = JSON.parse(fs.readFileSync(file, 'utf8'));
      const pick = pickPackageParts(conv.messages || [], ownerName);
      if (!pick.cv && !pick.clEn && !pick.clDe) continue;
      const kinds = [
        pick.cv ? 'CV' : null,
        pick.clEn ? 'CL_EN' : null,
        pick.clDe ? 'CL_DE' : null
      ].filter(Boolean).join('/');
      console.log(`  [${n++}] conv=${conv.id}  "${conv.name}"  (${kinds})`);
    }
    console.log('\nRun: node extract-package.js <convId|index>');
    return;
  }

  const key = process.argv[2];
  const convs = fs.readdirSync(CONV_DIR).filter((d) => fs.existsSync(path.join(CONV_DIR, d, 'conversation.json')));
  const convDir = /^\d+$/.test(key) && convs.length ? convs[Math.min(+key, convs.length - 1)] : convs.find((d) => d === key);
  if (!convDir) { console.error(`No conversation ${key}`); process.exit(1); }
  const conv = JSON.parse(fs.readFileSync(path.join(CONV_DIR, convDir, 'conversation.json'), 'utf8'));

  const pick = pickPackageParts(conv.messages || [], ownerName);
  if (!pick.cv && !pick.clEn && !pick.clDe) {
    console.log('No package for this conversation.'); return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const base = slug(stripEmDashes(pick.title)) || conv.id;
  const jobs = [
    ['CV', pick.cv], ['CoverLetter_EN', pick.clEn], ['CoverLetter_DE', pick.clDe],
  ];
  for (const [kind, content] of jobs) {
    if (!content) { console.log(`- ${kind}: not found, skipped`); continue; }
    if (!content.trim()) { console.log(`- ${kind}: heading found but the body is empty, skipped`); continue; }
    const file = `${base}_${kind}.odt`;
    toOdt(`# ${stripEmDashes(pick.title)}\n\n${stripEmDashes(content)}`, file);
    console.log(`- ${file}  (${content.length} chars)`);
  }
}

main();