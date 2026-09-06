#!/usr/bin/env node
/*
 * extract-package.js — extract CV / Cover Letter sections from saved
 * application-package chat messages and convert them to ODT via pandoc.
 *
 * Usage:
 *   node extract-package.js                 list conversations with packages
 *   node extract-package.js <convId> [n]    extract package #n (default: last)
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CONV_DIR = path.join(__dirname, '..', 'data', 'conversations');
const OUT_DIR = path.join(__dirname, '..', 'moje_dok', 'odt');
const PANDOC = 'pandoc';

function listPackages() {
  const out = [];
  for (const dir of fs.readdirSync(CONV_DIR)) {
    const file = path.join(CONV_DIR, dir, 'conversation.json');
    if (!fs.existsSync(file)) continue;
    const conv = JSON.parse(fs.readFileSync(file, 'utf8'));
    conv.messages.forEach((m, i) => {
      if (m.role === 'assistant' && m.content.includes('## 4. CV') && /Cover Letter/i.test(m.content)) {
        out.push({ convId: conv.id, convName: conv.name, msgIndex: i, content: m.content });
      }
    });
  }
  return out;
}

// first line of a section = heading, content until next ### or ## heading
function cutSection(md, startMarker, stopRe) {
  const s = md.indexOf(startMarker);
  if (s === -1) return null;
  const rest = md.slice(s + startMarker.length);
  const m = rest.match(stopRe);
  return (m ? rest.slice(0, m.index) : rest).trim();
}

function slug(s) {
  return s.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_').slice(0, 40);
}

function toOdt(md, outFile) {
  const tmp = path.join(OUT_DIR, path.basename(outFile) + '.md');
  fs.writeFileSync(tmp, md, 'utf8');
  execFileSync(PANDOC, [tmp, '--from=gfm', '-o', path.join(OUT_DIR, outFile)], { stdio: 'inherit' });
  fs.unlinkSync(tmp);
}

function main() {
  const packages = listPackages();
  if (packages.length === 0) { console.log('No package messages found.'); return; }

  if (process.argv.length < 3) {
    console.log('Saved application packages:');
    packages.forEach((p, i) =>
      console.log(`  [${i}] conv=${p.convId} msg#${p.msgIndex}  "${p.convName}"`));
    console.log('\nRun: node extract-package.js <convId|index> [n]');
    return;
  }

  const key = process.argv[2];
  let pkg;
  if (/^\d+$/.test(key) && packages[+key]) pkg = packages[+key];
  else {
    const matches = packages.filter(p => p.convId === key);
    if (matches.length === 0) { console.error(`No package for conversation ${key}`); process.exit(1); }
    pkg = matches[matches.length - 1]; // last by default
  }
  if (process.argv[3] !== undefined && packages[+process.argv[3]]) pkg = packages[+process.argv[3]];

  const md = pkg.content;
  const title = (md.match(/^#\s+(?:Pakiet|PAKIET|Package|APPLICATION)[^\n]*/m) || ['Package'])[0]
    .replace(/^#\s+/i, '').replace(/[—–]/g, '-');
  const base = slug(title);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const cv = cutSection(md, '### 4a.', /^###|^## /m);
  const clEn = cutSection(md, '### 4b.', /^###|^## /m);
  const clDe = cutSection(md, '### 4c.', /^###|^## /m);

  const jobs = [
    ['CV', cv], ['CoverLetter_EN', clEn], ['CoverLetter_DE', clDe],
  ];
  for (const [kind, content] of jobs) {
    if (!content) { console.log(`- ${kind}: not found, skipped`); continue; }
    const file = `${base}_${kind}.odt`;
    toOdt(`# ${title}\n\n${content}`, file);
    console.log(`- ${file}  (${content.length} chars)`);
  }
}

main();