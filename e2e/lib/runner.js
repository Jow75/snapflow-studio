/**
 * Minimal sequential test runner for the real-browser suites.
 */

const results = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log(`\n${name}`);
}

async function test(title, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - started;
    results.push({ group: currentGroup, title, ok: true, ms, detail: detail || '' });
    console.log(`  [PASS] ${title}${detail ? ' — ' + detail : ''} (${ms}ms)`);
  } catch (err) {
    const ms = Date.now() - started;
    results.push({ group: currentGroup, title, ok: false, ms, detail: err.message });
    console.log(`  [FAIL] ${title}\n         ${String(err.stack || err).split('\n').slice(0, 6).join('\n         ')}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

function assertClose(actual, expected, tolerance, message) {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`${message}: expected ${expected} ± ${tolerance}, got ${actual}`);
  }
}

function summary() {
  const passed = results.filter((r) => r.ok).length;
  return { passed, failed: results.length - passed, total: results.length, results };
}

module.exports = { group, test, assert, assertEqual, assertClose, summary };
