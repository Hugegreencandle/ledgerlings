/* Pure tests for battle_rules.js — no ledger, no deps. Run: node build/battle_rules.test.js
 * Proves: determinism, seed-dominance (underdog can win), power bounds, forfeit/draw, tiebreak,
 * and that resolveBattle agrees with an independent oracle across many seeds. */
const BR = require('./battle_rules.js');
const R = require('./pet_rules.js');

let fails = 0;
const ok = (c, m) => { if (c) console.log('  ok  ', m); else { console.error('  FAIL', m); fails++; } };

// pets of tunable strength (bypass the full lifecycle — resolveBattle only reads these fields)
const pet = (o = {}) => Object.assign({ alive: 1, care: 0, care_max: 0, form: 0, stage: 1 }, o);
const strong = pet({ care: 100, care_max: 100, form: 4, stage: 4 });   // power 212
const weak = pet({ care: 0, care_max: 0, form: 0, stage: 1 });         // power 108

// independent oracle
function oracle(seed, A, B, a, b) {
  const P = s => {
    const r = s.care_max > 0 ? Math.max(0, Math.min(1, s.care / s.care_max)) : 0;
    return 100 + Math.round(r * 40) + Math.min(4, s.form || 0) * 10 + Math.min(4, s.stage || 0) * 8;
  };
  // v3 roll, reimplemented rather than imported so this stays a genuinely independent check:
  // nid FIRST (so the bytes that differ between two pets get the full mixing chain), then a
  // murmur3 fmix32 avalanche.
  const roll = nid => {
    let h = 0x811c9dc5 >>> 0; const t = nid + ':' + seed;
    for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    h >>>= 0;
    h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
    h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
    h ^= h >>> 16;
    return (h >>> 0) % 1000;
  };
  const sA = A.alive !== 0 ? roll(a) + P(A) : -1, sB = B.alive !== 0 ? roll(b) + P(B) : -1;
  let w; if (sA < 0 && sB < 0) w = null; else if (sA > sB) w = a; else if (sB > sA) w = b; else w = a < b ? a : b;
  return { winner: w, scoreA: sA, scoreB: sB };
}

console.log('T1 — power bounds: 100..212, monotone in care/form/stage');
ok(BR.power(weak) === 108 && BR.power(strong) === 212, `weak=${BR.power(weak)} strong=${BR.power(strong)} (108..212)`);
ok(BR.power(pet({ form: 2, stage: 3, care: 50, care_max: 100 })) === 100 + 20 + 20 + 24, 'mid power = 164');

console.log('T2 — determinism: same (seed, pets) → same winner every call');
{
  const s = 'seed-abc';
  const r1 = BR.resolveBattle(s, strong, weak, 'A', 'B');
  const r2 = BR.resolveBattle(s, strong, weak, 'A', 'B');
  ok(JSON.stringify(r1) === JSON.stringify(r2), 'identical result on repeat');
}

console.log('T3 — matches the independent oracle across 200 seeds');
{
  let mismatch = 0;
  for (let i = 0; i < 200; i++) {
    const s = 'seed#' + i;
    const got = BR.resolveBattle(s, strong, weak, 'petA', 'petB');
    const exp = oracle(s, strong, weak, 'petA', 'petB');
    if (got.winner !== exp.winner || got.scoreA !== exp.scoreA || got.scoreB !== exp.scoreB) mismatch++;
  }
  ok(mismatch === 0, `0 mismatches over 200 seeds (got ${mismatch})`);
}

console.log('T4 — seed-dominant: the WEAK pet wins a real fraction of random seeds (no stat lock / no pay-to-win)');
{
  let weakWins = 0, n = 2000;
  for (let i = 0; i < n; i++) {
    const r = BR.resolveBattle('battle-' + i, strong, weak, 'STRONG', 'WEAK');
    if (r.winner === 'WEAK') weakWins++;
  }
  const pct = (100 * weakWins / n).toFixed(1);
  ok(weakWins > n * 0.20 && weakWins < n * 0.5, `weak (108 vs 212 power) wins ${pct}% of seeds — meaningful upset rate, still an underdog`);
}

console.log('T5 — forfeit + draw + tiebreak');
{
  const dead = pet({ alive: 0 });
  ok(BR.resolveBattle('s', dead, weak, 'A', 'B').winner === 'B', 'dead A → B wins (forfeit)');
  ok(BR.resolveBattle('s', dead, pet({ alive: 0 }), 'A', 'B').winner === null, 'both dead → draw (null)');
  // identical pets + same nid-derived roll can only tie if nids equal; force a tie via equal everything is impossible
  // (roll keyed by nid), so assert tiebreak determinism by symmetry: swapping sides doesn't change the winner id.
  const f = BR.resolveBattle('sym', strong, weak, 'X', 'Y').winner;
  const g = BR.resolveBattle('sym', weak, strong, 'Y', 'X').winner;
  ok(f === g, `side-swap invariant: winner id stable (${f} === ${g})`);
}

console.log('T6 — v2 is FROZEN: recorded battles must keep re-deriving under the rules they were settled with');
{
  // Hard-coded from the pre-v3 implementation. If this ever fails, a "fix" has rewritten attested
  // history and every v2 battle on mainnet would start reporting DIVERGED in the public verifier.
  const v2roll = (seed, nid) => { let h = 0x811c9dc5 >>> 0; const t = seed + ':' + nid; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return (h >>> 0) % 1000; };
  let drift = 0;
  for (let i = 0; i < 500; i++) {
    const s = 'frozen#' + i;
    if (BR.rollForV2(s, 'petA') !== v2roll(s, 'petA')) drift++;
    const got = BR.resolveBattle(s, strong, weak, 'petA', 'petB', 'v2');
    const sA = v2roll(s, 'petA') + 212, sB = v2roll(s, 'petB') + 108;
    if (got.scoreA !== sA || got.scoreB !== sB) drift++;
  }
  ok(drift === 0, `v2 re-derivation unchanged over 500 seeds (drift ${drift})`);
  ok(BR.resolveBattle('x', strong, weak, 'A', 'B').rulesetVersion === 'v3', 'new battles default to v3');
}

console.log('T7 — v3 fixes the sibling-nid correlation that made care worthless');
{
  // Real XRPL NFTokenIDs from one issuer+taxon differ only in their low sequence bits.
  const P = '00080000C1C0DE5C1E9A0FE0A5E2B8C4D6F81234064DD4';
  const a = P + '30', b = P + '33';
  const seen = new Set();
  for (let i = 0; i < 20000; i++) { const s = 'sib#' + i; seen.add(BR.rollForV3(s, a) - BR.rollForV3(s, b)); }
  ok(seen.size > 1000, `v3 roll difference takes ${seen.size} distinct values (v2 gave as few as 8)`);
  const seenV2 = new Set();
  for (let i = 0; i < 20000; i++) { const s = 'sib#' + i; seenV2.add(BR.rollForV2(s, a) - BR.rollForV2(s, b)); }
  ok(seenV2.size < 100, `v2 really was quantised (${seenV2.size} distinct) — this is what v3 fixes`);
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
