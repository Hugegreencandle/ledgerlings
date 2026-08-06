/* Ledgerlings — provably-fair battle rules (Make Waves #10). PURE + portable (Node + browser), no deps.
 * Outcome = a deterministic function of (pet A state@N, pet B state@N, seed). The seed is derived server-side
 * from a pinned FUTURE ledger hash (see server.js seedFor) that nobody can bias; here we only spread it.
 * SEED-DOMINANT by design: the roll (0..999) outweighs stat power (100..212), so care/form give an edge, not a
 * lock — an underdog can win. HARD RULE (like loadout): stats influence, never determine. Versioned; the version
 * hash is stamped into the battle record so the rules can't be swapped to justify a result.
 *
 * ─── v3, 2026-08-06: THE ROLL WAS NOT INDEPENDENT BETWEEN THE TWO PETS ────────────────────────────
 * v2 computed the roll as fnv1a(seed + ':' + nid), with the seed as a PREFIX. FNV-1a is a streaming
 * hash: after consuming the shared seed prefix both pets sit in an IDENTICAL internal state, and only
 * the handful of trailing bytes where their nids differ ever get mixed. Real XRPL NFTokenIDs from one
 * issuer and one taxon differ ONLY in their low sequence bits, so sibling pets differed in as little
 * as one character and there were far too few mixing rounds left to diffuse that.
 *
 * Measured on the real mainnet pet id shape, 25k seeds per pair over 240 consecutive-serial pairs:
 *
 *   v2:  (rollA - rollB) took as few as 8 DISTINCT VALUES   (independent rolls give ~1999)
 *        smallest achievable |rollA - rollB| was 143, LARGER than the entire 112-point power spread
 *        => a maxed pet beat a neglected one anywhere from 49.3% to 96.2% of the time,
 *           where the intended figure is ~60.5% for every pair.
 *
 * So for many real matchups care/form/stage changed the outcome NOT AT ALL, and for others they were
 * nearly deterministic. Worse, the distortion is a fixed property of the two nids, so anyone could
 * measure it offline and pick opponents their power edge actually beats — with real XRP staked.
 *
 * v3 puts the nid FIRST so the differing bytes get the full mixing chain, then runs a murmur3-style
 * avalanche finalizer over the result. Same measurement: worst-case 1902 distinct values and 59.6%
 * to 61.5% across all 240 pairs, which matches a sha256 reference (1901, 59.8..61.4) while keeping
 * this file dependency-free and portable.
 *
 * v2 IS RETAINED, EXACTLY AS IT WAS. Battle records stamp their ruleset version, so a v2 battle must
 * still re-derive under v2 rules forever or the public verifier would report DIVERGED on history it
 * already attested. Never "fix" v2 — it is a historical record, not code that should be correct. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BattleRules = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const BASE = 100;
  const CURRENT_VERSION = 'v3';

  // bounded power: base + modest care/form/stage edges. range 100..212 (max ~2.1x min).
  function power(s) {
    if (!s) return 0;
    const ratio = s.care_max > 0 ? Math.max(0, Math.min(1, s.care / s.care_max)) : 0;
    const careBonus = Math.round(ratio * 40);                 // 0..40
    const formBonus = Math.max(0, Math.min(4, s.form || 0)) * 10;   // 0..40
    const stageBonus = Math.max(0, Math.min(4, s.stage || 0)) * 8;  // 0..32
    return BASE + careBonus + formBonus + stageBonus;
  }

  function fnv1a(str) {
    let h = 0x811c9dc5 >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  }

  // murmur3 fmix32. Cheap, no deps, and it is what turns FNV's weak tail diffusion into a full
  // avalanche, so a one-character nid difference changes every output bit with ~50% probability.
  function avalanche(h) {
    h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
    h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
    h ^= h >>> 16;
    return h >>> 0;
  }

  // LEGACY. Frozen. Reproduces every battle recorded under ruleset v2, including its correlation
  // defect. Do not repair this function; repairing it would rewrite attested history.
  function rollForV2(seed, nid) { return fnv1a(seed + ':' + nid) % 1000; }

  // v3: nid first so the differing bytes get the whole mixing chain, then a full avalanche.
  function rollForV3(seed, nid) { return avalanche(fnv1a(nid + ':' + seed)) % 1000; }

  function rollForVersion(rv) { return rv === 'v2' ? rollForV2 : rollForV3; }

  // Kept as the current-rules entry point so existing callers keep working.
  function rollFor(seed, nid) { return rollForV3(seed, nid); }

  // resolve: higher score wins; a dead pet forfeits; both dead => draw (winner null); exact tie => lexicographic nid.
  // rv selects the ruleset. Omit it for new battles; pass the RECORDED version when re-deriving an
  // existing battle, or the verifier will contradict a result it already published.
  function resolveBattle(seed, A, B, nidA, nidB, rv) {
    const roll = rollForVersion(rv || CURRENT_VERSION);
    const aliveA = !!A && A.alive !== 0, aliveB = !!B && B.alive !== 0;
    const powerA = power(A), powerB = power(B);
    const rollA = roll(seed, nidA), rollB = roll(seed, nidB);
    const scoreA = aliveA ? rollA + powerA : -1;
    const scoreB = aliveB ? rollB + powerB : -1;
    let winner;
    if (scoreA < 0 && scoreB < 0) winner = null;
    else if (scoreA > scoreB) winner = nidA;
    else if (scoreB > scoreA) winner = nidB;
    else winner = nidA < nidB ? nidA : nidB;
    return { winner, scoreA, scoreB, rollA, rollB, powerA, powerB, aliveA, aliveB, rulesetVersion: rv || CURRENT_VERSION };
  }

  return { BASE, CURRENT_VERSION, power, fnv1a, avalanche, rollFor, rollForV2, rollForV3, rollForVersion, resolveBattle };
}));
