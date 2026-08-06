#!/usr/bin/env node
/* Does the PvP seed derivation actually close the hole?
 *
 * The exploit: the challenge memo pins an absolute ledger N. BATTLE_LEDGER_MARGIN is small, so N
 * closes shortly after the challenge lands. The ACCEPTOR chooses when to accept. Accept after N has
 * closed and its hash is public, so the winner can be computed before committing real staked XRP.
 *
 * Fixed rule: seed ledger = accept.lseq + BATTLE_LEDGER_MARGIN, i.e. after the LAST commitment.
 *
 * This is a pure unit test of the derivation. It needs no network: it asserts the property that
 * matters (is the seed ledger strictly after the last commitment?) for both rules, over the timing
 * the exploit relies on.
 */
'use strict';
const MARGIN = 20;                       // BATTLE_LEDGER_MARGIN in server.js

// old rule: whatever the challenger wrote in the memo
const oldRule = ({ claimedN }) => claimedN;
// new rule: counted from the ledger the ACCEPT landed in
const newRule = ({ acceptLseq }) => acceptLseq + MARGIN;

// An acceptor is safe only if the seed ledger had NOT closed when they signed.
const seedUnknowableAtAccept = (seedLedger, acceptLseq) => seedLedger > acceptLseq;

const cases = [
  { name: 'accept lands promptly (30 ledgers after challenge)', challengeLseq: 1000, claimedN: 1020, acceptLseq: 1030 },
  { name: 'accept after a coffee (5 min ~ 75 ledgers)',          challengeLseq: 1000, claimedN: 1020, acceptLseq: 1075 },
  { name: 'accept next day',                                     challengeLseq: 1000, claimedN: 1020, acceptLseq: 22000 },
  { name: 'challenger pins far future, accept before it closes', challengeLseq: 1000, claimedN: 9000, acceptLseq: 1030 },
];

let failures = 0;
console.log('  case                                            old rule     new rule');
for (const c of cases) {
  const o = oldRule(c), n = newRule(c);
  const oSafe = seedUnknowableAtAccept(o, c.acceptLseq);
  const nSafe = seedUnknowableAtAccept(n, c.acceptLseq);
  console.log(`  ${c.name.padEnd(46)} ${(oSafe ? 'safe' : 'EXPLOITABLE').padEnd(12)} ${nSafe ? 'safe' : 'EXPLOITABLE'}`);
  // The new rule must be safe in EVERY case — that is the whole point.
  if (!nSafe) { console.error(`    ✗ new rule unsafe for: ${c.name}`); failures++; }
}

// And the fix must actually change something: at least one realistic case the old rule got wrong.
const oldBroken = cases.filter(c => !seedUnknowableAtAccept(oldRule(c), c.acceptLseq));
console.log(`\n  old rule exploitable in ${oldBroken.length}/${cases.length} cases; new rule in 0/${cases.length}`);
if (!oldBroken.length) { console.error('  ✗ old rule was never exploitable in these cases — the test proves nothing'); failures++; }

// ── the accept is not a scalar ───────────────────────────────────────────────────────────────────
// Everything above models the accept as ONE number, which is the assumption that hid the real hole:
// an accept is a memo on an ordinary Payment, anyone can send one, and loadBattle used to keep the
// LAST. Since the seed ledger is a function of it, a loser who read the outcome after ledger N closed
// could send a second accept memo and get fresh dice, for a drop, as often as they liked.
//
// Rule: the seed ledger is a function of the FIRST valid accept, so later ones cannot move it. (The
// on-ledger half — who may send one, whose pet it may name — is exercised against the real
// loadBattle/pickAccept in battle_authority_test.cjs; this is the arithmetic half.)
const oldPick = accepts => accepts[accepts.length - 1];      // last write wins
const newPick = accepts => accepts[0];                       // first commitment wins
const seedLedgerOf = a => a.lseq + MARGIN;

const grind = [
  { name: 'honest fight, one accept',                accepts: [{ lseq: 1030 }] },
  { name: 'loser re-accepts after the seed closed',  accepts: [{ lseq: 1030 }, { lseq: 1051 }] },
  { name: 'and again, and again',                    accepts: [{ lseq: 1030 }, { lseq: 1051 }, { lseq: 1200 }, { lseq: 9000 }] },
];
console.log('\n  multiple accept memos            first-accept seed   last-accept seed   re-rollable?');
for (const g of grind) {
  const nSeed = seedLedgerOf(newPick(g.accepts)), oSeed = seedLedgerOf(oldPick(g.accepts));
  const baseline = seedLedgerOf(g.accepts[0]);
  const rerollable = oSeed !== baseline;
  console.log(`  ${g.name.padEnd(32)} ${String(nSeed).padEnd(19)} ${String(oSeed).padEnd(18)} ${rerollable ? 'YES — dice re-rolled' : 'no'}`);
  // The property: no set of later accepts may change the seed ledger.
  if (nSeed !== baseline) { console.error(`    ✗ the seed ledger moved under the new rule: ${g.name}`); failures++; }
}
if (!grind.some(g => seedLedgerOf(oldPick(g.accepts)) !== seedLedgerOf(g.accepts[0]))) {
  console.error('  ✗ no case here re-rolls under last-write-wins — the test proves nothing'); failures++;
}

// Stale detection: a memo N that had already closed by accept time must be flagged.
const stale = ({ claimedN, acceptLseq }) => Number.isInteger(claimedN) && claimedN > 1000000 && claimedN <= acceptLseq;
const s1 = stale({ claimedN: 105955044, acceptLseq: 105955051 });   // the real 07-30 shape
const s2 = stale({ claimedN: 105955099, acceptLseq: 105955051 });
console.log(`  stale flag: closed-before-accept=${s1} (want true), still-future=${s2} (want false)`);
if (!s1 || s2) { console.error('  ✗ stale detection wrong'); failures++; }

if (failures) { console.error(`\nFAILED (${failures})`); process.exit(1); }
console.log('\nPASS: seed ledger is strictly after the last commitment under the new rule, in every case.');
