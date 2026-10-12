/**
 * Snap Flow Studio - real-browser verification.
 *
 *   node run-all.js                 full suite at DPR 1, core checks at 1.25 / 1.5 / 2
 *   node run-all.js --dpr=1         one device pixel ratio only
 *   node run-all.js --only=region   one suite (full | region | dynamic | exports | studio | tools | storage)
 *
 * Output images, PDFs and report.json are written to e2e/output/.
 */

const fs = require('fs');
const path = require('path');
const { launch, OUTPUT_DIR } = require('./lib/harness');
const { summary } = require('./lib/runner');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);

const SUITES = {
  full: require('./tests/full-page'),
  region: require('./tests/region'),
  dynamic: require('./tests/dynamic'),
  exports: require('./tests/exports'),
  studio: require('./tests/studio-layout'),
  tools: require('./tests/studio-tools'),
  storage: require('./tests/storage')
};

/** Suites whose result does not depend on the device pixel ratio run once, at ratio 1. */
const RATIO_INDEPENDENT = new Set(['exports', 'studio', 'tools', 'storage']);

(async () => {
  const ratios = args.dpr ? String(args.dpr).split(',').map(Number) : [1, 1.25, 1.5, 2];
  const only = args.only ? String(args.only).split(',') : Object.keys(SUITES);

  for (const dpr of ratios) {
    const ctx = await launch({ dpr });
    // DPR 1 is pixel-exact and runs everything; other ratios re-run the geometry-sensitive cases.
    const quick = dpr !== 1 && !args.all;
    try {
      for (const name of only) {
        if (RATIO_INDEPENDENT.has(name) && quick) continue;
        await SUITES[name](ctx, { quick });
      }
    } catch (err) {
      console.error('Suite aborted:', err);
      process.exitCode = 1;
    } finally {
      await ctx.close();
    }
  }

  const report = summary();
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log('\n============================================================');
  console.log(`REAL-BROWSER RESULT: ${report.passed} of ${report.total} checks passed, ${report.failed} failed.`);
  console.log(`Artifacts: ${OUTPUT_DIR}`);
  console.log('============================================================\n');
  if (report.failed) process.exitCode = 1;
})();
