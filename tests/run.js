// Test runner for GEM: unit tests + API integration tests.
// Usage: node tests/run.js
// The UI suite (headed Edge window) is separate: node tests/ui.test.js
'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const suites = ['unit.test.js', 'api.test.js'];
let failed = false;
for (const s of suites) {
  console.log('=== ' + s + ' ===');
  const r = spawnSync(process.execPath, ['--test', path.join(__dirname, s)], { stdio: 'inherit' });
  if (r.status !== 0) failed = true;
}
console.log(failed ? 'FAILURES' : 'ALL SUITES PASSED');
process.exit(failed ? 1 : 0);
