#!/usr/bin/env node
/**
 * Load the published pages in a real browser and fail if anything threw or nothing rendered.
 *
 *   node build/page_smoke.cjs http://localhost:8080        # a PR branch, served in CI
 *   node build/page_smoke.cjs https://hugegreencandle.github.io/ledgerlings   # the live site
 *
 * WHY. On 2026-08-05 the live site rendered nothing for about three hours, spanning the launch
 * post going out. A `let` was declared near the bottom of app.html and read by the render loop near
 * the top, so the first frame threw:
 *
 *     ReferenceError: Cannot access 'shakeUntil' before initialization
 *
 * Because tick() is invoked during script evaluation, that throw also aborted the rest of the
 * script, so the mode banner, the keyless adopt box and the share button never initialised either.
 * One mistake, several dead surfaces, and it was found by a screenshot from a human.
 *
 * Every gate in this repo passed the whole time. `node --check` validates syntax, not temporal dead
 * zone. check_docs_sync compares files. diff_rules tests the rules engine over 123,000 states.
 * NONE of them load the page. A frontend change can be green everywhere and still be a blank screen.
 *
 * So this checks the two things a user would notice:
 *   1. nothing threw (console errors AND uncaught page errors — TDZ shows up as the latter)
 *   2. the canvas actually painted, and #mode has text
 *
 * (2) matters on its own. A render that silently draws nothing throws no error, and would look
 * identical to a visitor. An empty #mode was the visible tell during the outage.
 */
'use strict';

const BASE = (process.argv[2] || '').replace(/\/$/, '');
if (!BASE) {
  console.error('usage: node build/page_smoke.cjs <base-url>');
  process.exit(2);
}

// Pages to check, and what each must show. canvas.html is the collaborator drawing tool: it has no
// pet canvas and no mode banner, so it is checked for errors only rather than skipped entirely.
const PAGES = [
  { path: '/index.html',   needsCanvas: true,  needsMode: true  },
  { path: '/testnet.html', needsCanvas: true,  needsMode: true  },
  { path: '/canvas.html',  needsCanvas: false, needsMode: false },
];

// Kept deliberately short and explicit. A broad ignore list is how a gate quietly stops working;
// anything added here must be something we have decided is genuinely not ours.
const IGNORE = [
  /favicon\.ico/i,                       // no favicon is served; harmless and unrelated
  /net::ERR_/i,                          // network reachability, not a code fault
  /Failed to load resource.*\b(429|503)\b/i,
];

// The backend locks CORS to the Pages origin ON PURPOSE, so a page served from localhost in CI can
// never reach it and will always log a CORS error. That is a property of the test rig, not of the
// code, and ignoring it lets the PR job test what it is actually for.
//
// Scoped to local runs ONLY. On the live site the origin is correct, so a CORS error there is a
// REAL regression (the allowed origin changed, or the backend config drifted) and must still fail.
// Without this narrowing, one convenient exception would blind the live check too.
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(BASE);
const LOCAL_ONLY_IGNORE = [/blocked by CORS policy/i, /Access-Control-Allow-Origin/i];

const ignored = m =>
  IGNORE.some(re => re.test(m)) || (LOCAL && LOCAL_ONLY_IGNORE.some(re => re.test(m)));

(async () => {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { console.error('needs playwright: npm i -D playwright && npx playwright install chromium'); process.exit(2); }

  console.log(`page-smoke: ${BASE}  (${LOCAL ? 'LOCAL rig — CORS errors ignored' : 'LIVE — CORS errors are failures'})`);
  const browser = await chromium.launch();
  const failures = [];

  for (const page of PAGES) {
    const url = BASE + page.path;
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    const errors = [];

    p.on('console', m => { if (m.type() === 'error' && !ignored(m.text())) errors.push('console: ' + m.text()); });
    // Uncaught exceptions never reach console listeners in some cases. TDZ lands here.
    p.on('pageerror', e => { const t = String(e); if (!ignored(t)) errors.push('pageerror: ' + t); });

    let loaded = true;
    try { await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
    catch (e) { loaded = false; failures.push(`${page.path}: navigation failed — ${e.message}`); }

    if (loaded) {
      // Let the render loop run a few frames before asking whether it drew anything.
      await p.waitForTimeout(2500);

      const state = await p.evaluate(() => {
        const out = { contentType: document.contentType, scripts: typeof window.LEDGERLINGS_BACKEND !== 'undefined' };
        const c = document.getElementById('c');
        if (c) {
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let painted = 0;
          for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted++;
          out.painted = painted;
        }
        const m = document.getElementById('mode');
        out.modeText = m ? (m.textContent || '').trim() : null;
        return out;
      });

      // A raw CDN once served these as text/plain, so nothing executed and the run reported a
      // meaningless zero errors. Assert the browser actually parsed a document.
      if (state.contentType !== 'text/html')
        failures.push(`${page.path}: served as ${state.contentType}, not text/html — nothing executed`);

      if (page.needsCanvas && !(state.painted > 0))
        failures.push(`${page.path}: canvas painted ${state.painted ?? 'no canvas'} pixels — blank stage`);

      if (page.needsMode && !state.modeText)
        failures.push(`${page.path}: #mode is empty — page init did not complete`);

      // A render-loop throw repeats every frame; 153 identical lines buries the two lines that
      // actually diagnose it. Collapse duplicates and show the count instead.
      const seen = new Map();
      for (const e of errors) seen.set(e, (seen.get(e) || 0) + 1);
      for (const [e, n] of seen) failures.push(`${page.path}: ${e}${n > 1 ? `  (x${n})` : ''}`);

      const bits = [`content-type ok`];
      if (page.needsCanvas) bits.push(`${state.painted} px painted`);
      if (page.needsMode) bits.push(`mode "${(state.modeText || '').slice(0, 32)}"`);
      bits.push(`${errors.length} error(s)`);
      console.log(`  ${page.path.padEnd(15)} ${bits.join(' · ')}`);
    }
    await ctx.close();
  }

  await browser.close();

  if (failures.length) {
    console.error('\nPAGE SMOKE FAILED:');
    for (const f of failures) console.error('  ✗ ' + f);
    process.exit(1);
  }
  console.log('\nPASS: every page parsed, executed, rendered and threw nothing.');
})().catch(e => { console.error('page_smoke crashed:', e); process.exit(2); });
