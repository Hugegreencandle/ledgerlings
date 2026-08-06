#!/usr/bin/env node
/* Who is allowed to write a battle's history?
 *
 * Every fact a battle is made of lives in a memo on an ordinary Payment to the issuer. The format is
 * public and documented in this repo, so ANY account can emit ANY of those memos for one drop —
 * without touching /battle/accept or /sign, whose guards only shape the payloads WE build.
 *
 * That made five things possible against the code as shipped on 2026-08-06, all of them confirmed
 * against the real functions, not a model of them:
 *
 *   1. the seed ledger is accept.lseq + margin, and loadBattle took the LAST accept memo, so a loser
 *      who read the outcome after the seed ledger closed could send another accept and RE-ROLL the
 *      dice — repeatedly, for a drop each time
 *   2. a `result` memo from any account froze the pot: resolveBattleTx short-circuits ALREADY_RESOLVED
 *      before it pays anyone, and /verify-battle then reported FAIL on an honest fight
 *   3. a 1-drop accept sent AFTER an honest one replaced ownerB, tripped the underpayment guard and
 *      had the issuer refund the ATTACKER while the honest acceptor's stake stayed behind
 *   4. an accept naming a pet the sender does not own conscripted a stranger's pet into a fight
 *   5. an accept naming the challenger's own pet was a guaranteed, deterministic win (identical state
 *      ⇒ identical score ⇒ the lexicographic tiebreak) that the board then counted twice
 *
 * This drives the REAL loadBattle / pickAccept / resolveBattleTx / verifyBattle out of server.js
 * against a stubbed XRPL client, so it fails if the rules move.
 */
'use strict';

const S = require('./server.js');
const { enc, hex, R, replay, loadBattle, pickAccept, resolveBattleTx, verifyBattle,
        noteLadderChallenge, pendingPvp, BATTLE_LEDGER_MARGIN, BATTLE_MEMO } = S;

const ISSUER = 'rISSUER', ALICE = 'rALICE', BOB = 'rBOB', MAL = 'rMALLORY';
const NID_A = 'A'.repeat(64), NID_B = 'B'.repeat(64), NID_M = 'C'.repeat(64), NID_GHOST = 'D'.repeat(64);

let failures = 0, checks = 0;
const ok = (cond, label, detail) => {
  checks++;
  if (cond) console.log(`  ok   ${label}`);
  else { console.log(`  XX   ${label}${detail === undefined ? '' : '  -> ' + JSON.stringify(detail)}`); failures++; }
};

// ── a fake ledger ────────────────────────────────────────────────────────────────────────────────
function world() {
  const w = { txs: [], nfts: [], hashes: {}, current: 100000, submitted: [] };
  w.mint = (nid, owner, birth) => {
    const g = R.genesis(birth, owner);
    w.nfts.push({ NFTokenID: nid, NFTokenTaxon: 7777, URI: enc(g) });
    w.txs.push({ tx: { TransactionType: 'NFTokenMint', Account: ISSUER, URI: enc(g), ledger_index: birth },
      meta: { nftoken_id: nid, TransactionResult: 'tesSUCCESS' }, hash: 'MINT' + nid.slice(0, 4) });
    return g;
  };
  w.pay = (from, to, drops, memo, lseq, hash, result) => {
    w.txs.push({
      tx: { TransactionType: 'Payment', Account: from, Destination: to, Amount: String(drops), ledger_index: lseq, hash,
        Memos: memo ? [{ Memo: { MemoType: hex(BATTLE_MEMO), MemoData: hex(memo) } }] : undefined },
      meta: { TransactionResult: result || 'tesSUCCESS', delivered_amount: String(drops) }, hash });
    return hash;
  };
  w.client = {
    async request(r) {
      if (r.command === 'account_tx') {
        const min = r.ledger_index_min == null || r.ledger_index_min < 0 ? -Infinity : r.ledger_index_min;
        return { result: { transactions: w.txs.filter(t => (t.tx.ledger_index || 0) >= min) } };
      }
      if (r.command === 'account_nfts') return { result: { account_nfts: w.nfts } };
      if (r.command === 'ledger') {
        if (r.ledger_index === 'validated') return { result: { ledger_index: w.current } };
        const n = Number(r.ledger_index);
        return { result: { ledger: n <= w.current ? { ledger_hash: 'HASH_' + n } : null } };
      }
      throw new Error('unstubbed request ' + r.command);
    },
    async autofill(tx) { return tx; },
    async submitAndWait(blob) {
      w.submitted.push(blob);
      return { result: { meta: { TransactionResult: 'tesSUCCESS', nftoken_id: 'CARD' + w.submitted.length } } };
    },
  };
  w.wallet = { classicAddress: ISSUER, sign: tx => ({ tx_blob: tx }) };
  // replay what the issuer just emitted back into the ledger, so a second resolve sees it
  w.settle = () => {
    for (const tx of w.submitted) {
      if (tx.TransactionType !== 'Payment') continue;
      w.txs.push({ tx: { ...tx, ledger_index: ++w.current, hash: 'ISS' + w.txs.length },
        meta: { TransactionResult: 'tesSUCCESS', delivered_amount: String(tx.Amount) }, hash: 'ISS' + w.txs.length });
    }
    w.submitted = [];
  };
  return w;
}
const memoOf = tx => {
  const m = (tx.Memos || [])[0];
  return m ? Buffer.from(m.Memo.MemoData, 'hex').toString('utf8') : null;
};
const payments = w => w.submitted.filter(t => t.TransactionType === 'Payment')
  .map(t => ({ to: t.Destination, drops: Number(t.Amount), memo: memoOf(t) }));

// a standard PvP setup: A challenges at 1000 with `stake`, both pets exist
function pvpWorld(stake = 1) {
  const w = world();
  w.mint(NID_A, ALICE, 10); w.mint(NID_B, BOB, 20); w.mint(NID_M, MAL, 30);
  const BID = 'F'.repeat(64);
  w.pay(ALICE, ISSUER, stake, ['challenge', NID_A, String(stake), '1900'].join('|'), 1000, BID);
  w.current = 5000;
  return { w, BID };
}

// ── 1. a second accept memo must not move the seed ledger (the re-roll) ─────────────────────────
async function testReRoll() {
  console.log('\n1. re-roll: a later accept memo is INERT');
  const { w, BID } = pvpWorld();
  w.pay(BOB, ISSUER, 1, ['accept', BID, NID_B].join('|'), 1030, 'ACC1');
  const before = await loadBattle(w.client, ISSUER, BID);
  const p1 = await pickAccept(w.client, ISSUER, before);
  ok(p1 && p1.accept.lseq === 1030, 'first accept selected', p1 && p1.accept.lseq);
  const seed1 = p1.accept.lseq + BATTLE_LEDGER_MARGIN;

  // the loser reads the outcome after ledger 1050 closed and tries to buy new dice
  w.pay(BOB, ISSUER, 1, ['accept', BID, NID_B].join('|'), 1200, 'ACC2');
  w.pay(MAL, ISSUER, 1, ['accept', BID, NID_M].join('|'), 1400, 'ACC3');
  const after = await loadBattle(w.client, ISSUER, BID);
  ok(after.accepts.length === 3, 'all three accept memos are read', after.accepts.length);
  const p2 = await pickAccept(w.client, ISSUER, after);
  const seed2 = p2.accept.lseq + BATTLE_LEDGER_MARGIN;
  ok(seed1 === seed2, `seed ledger did not move (${seed1} -> ${seed2})`, { seed1, seed2 });
  ok(p2.accept.ownerB === BOB && p2.accept.bNid === NID_B, 'the first committer is still the opponent', p2.accept);
}

// ── 2. only the ISSUER can declare a result ─────────────────────────────────────────────────────
async function testForgedResult() {
  console.log('\n2. forged result memo: ignored, fight still settles');
  const { w, BID } = pvpWorld();
  w.pay(BOB, ISSUER, 1, ['accept', BID, NID_B].join('|'), 1030, 'ACC1');
  w.pay(MAL, ISSUER, 1, ['result', BID, NID_M, '99', '0', 'v2'].join('|'), 1060, 'FORGE');
  const b = await loadBattle(w.client, ISSUER, BID);
  ok(b.result === null, 'a non-issuer result memo is not a result', b.result);
  const r = await resolveBattleTx(w.client, w.wallet, BID);
  ok(r.status !== 'ALREADY_RESOLVED', 'resolution is not frozen by the forgery', r.status);
  ok(r.payout && r.payout.paidDrops, 'the winner was actually paid', r.payout);
  const v = await verifyBattle(w.client, ISSUER, BID);
  ok(v.verdict === 'UNRESOLVED' || v.verdict === 'PASS', 'verify does not FAIL on the forgery', v.verdict);

  // and an ISSUER result IS honoured — idempotence must survive the fix
  w.settle();
  const r2 = await resolveBattleTx(w.client, w.wallet, BID);
  ok(r2.status === 'ALREADY_RESOLVED', 'a real issuer result makes it idempotent', r2.status);
  const v2 = await verifyBattle(w.client, ISSUER, BID);
  ok(v2.verdict === 'PASS' && v2.ok, 'and the settled fight verifies PASS', { verdict: v2.verdict, reason: v2.reason });
}

// ── 3. a 1-drop accept after an honest one must not steal the refund ────────────────────────────
async function testRefundTheft() {
  console.log('\n3. underpaid late accept: cannot displace the honest acceptor');
  const STAKE = 10000000;
  const { w, BID } = pvpWorld(STAKE);
  w.pay(BOB, ISSUER, STAKE, ['accept', BID, NID_B].join('|'), 1030, 'ACC1');
  w.pay(MAL, ISSUER, 1, ['accept', BID, NID_M].join('|'), 1200, 'ACC2');   // the theft
  const r = await resolveBattleTx(w.client, w.wallet, BID);
  ok(r.status !== 'VOID' && r.status !== 'REFUND_FAILED', 'the fight is not voided', r.status);
  const paid = payments(w);
  ok(!paid.some(p => p.to === MAL), 'nothing was paid to the attacker', paid);
  ok(paid.some(p => p.drops === 2 * STAKE - Math.floor(2 * STAKE * 500 / 10000)), 'the pot went to a real player', paid);
}

// ── 4. a pet cannot fight itself ────────────────────────────────────────────────────────────────
async function testSelfBattle() {
  console.log('\n4. self-battle: never settles, so it can never be farmed');
  const { w, BID } = pvpWorld();
  w.pay(ALICE, ISSUER, 1, ['accept', BID, NID_A].join('|'), 1030, 'ACC1');
  const b = await loadBattle(w.client, ISSUER, BID);
  ok(b.accept === null, 'the self-accept is not well formed', b.accept);
  const r = await resolveBattleTx(w.client, w.wallet, BID);
  ok(r.status === 'OPEN', 'resolution refuses it', r);
  ok(payments(w).length === 0, 'no money moved', payments(w));
}

// ── 5. you cannot enter someone else's pet ──────────────────────────────────────────────────────
async function testConscription() {
  console.log("5. conscription: an accept naming a pet the sender does not own is ignored");
  const { w, BID } = pvpWorld();
  w.pay(MAL, ISSUER, 1, ['accept', BID, NID_B].join('|'), 1030, 'ACC1');    // Mallory enters Bob's pet
  const p = await pickAccept(w.client, ISSUER, await loadBattle(w.client, ISSUER, BID));
  ok(p === null, 'rejected', p && p.accept);
  // ... and the real owner can still accept afterwards
  w.pay(BOB, ISSUER, 1, ['accept', BID, NID_B].join('|'), 1100, 'ACC2');
  const p2 = await pickAccept(w.client, ISSUER, await loadBattle(w.client, ISSUER, BID));
  ok(p2 && p2.accept.ownerB === BOB && p2.accept.lseq === 1100, 'the honest accept still works', p2 && p2.accept);
}

// ── 6. an accept naming a pet that does not exist must not strand the stakes ────────────────────
async function testGhostPet() {
  console.log('6. ghost pet: an accept for a nonexistent nid cannot strand the challenge');
  const { w, BID } = pvpWorld();
  w.pay(MAL, ISSUER, 1, ['accept', BID, NID_GHOST].join('|'), 1030, 'ACC1');
  w.pay(BOB, ISSUER, 1, ['accept', BID, NID_B].join('|'), 1100, 'ACC2');
  const r = await resolveBattleTx(w.client, w.wallet, BID);
  ok(!r.error, 'the battle still settles', r.error || r.winner);
  ok(r.acceptLedger === 1100, 'against the real acceptor', r.acceptLedger);
}

// ── 7. a tec'd payment is in the ledger but is not a commitment or a settlement ─────────────────
async function testTecIsNotSuccess() {
  console.log("7. tec: a failed payment's memos are not facts");
  const { w, BID } = pvpWorld();
  w.pay(BOB, ISSUER, 1, ['accept', BID, NID_B].join('|'), 1030, 'ACC1');
  w.pay(ISSUER, BOB, 1, ['result', BID, NID_B, '5', '4', 'v2'].join('|'), 1060, 'TEC', 'tecUNFUNDED_PAYMENT');
  const b = await loadBattle(w.client, ISSUER, BID);
  ok(b.result === null, 'a tec\'d result memo is not a result', b.result);
  const r = await resolveBattleTx(w.client, w.wallet, BID);
  ok(r.status !== 'ALREADY_RESOLVED' && r.payout, 'so the fight can still be settled and paid', r.status);
}

// ── 8. VOID/DRAW refunds are per-leg idempotent ─────────────────────────────────────────────────
async function testRefundIdempotence() {
  console.log('8. VOID: both legs refunded, and a retry pays nothing twice');
  const w = world();
  w.mint(NID_A, ALICE, 10); w.mint(NID_B, BOB, 20);
  const BID = 'E'.repeat(64);
  w.pay(ALICE, ISSUER, 1, ['challenge', NID_A, '10000000', '1900'].join('|'), 1000, BID);   // underpaid by A
  w.pay(BOB, ISSUER, 10000000, ['accept', BID, NID_B].join('|'), 1030, 'ACC1');
  w.current = 5000;
  const r = await resolveBattleTx(w.client, w.wallet, BID);
  ok(r.status === 'VOID', 'voided', r.status);
  const paid = payments(w);
  ok(paid.some(p => p.to === ALICE && p.memo === ['refund', BID, 'A'].join('|')), 'leg A refunded', paid);
  ok(paid.some(p => p.to === BOB && p.drops === 10000000 && p.memo === ['refund', BID, 'B'].join('|')), 'leg B refunded in full', paid);
  const last = paid[paid.length - 1];
  ok(last.memo && last.memo.startsWith('result|'), 'the result memo is written LAST, after both refunds', last);
  w.settle();
  const r2 = await resolveBattleTx(w.client, w.wallet, BID);
  ok(r2.status === 'ALREADY_RESOLVED', 'a retry is a no-op', r2.status);
  ok(payments(w).length === 0, 'and moves no money', payments(w));
}

// ── 9. expiry: late accepts are refused, but the grace window covers submission latency ─────────
// An open-ended challenge is exploitable: a passed pet forfeits, so an opponent could wait for the
// challenger's pet to die of neglect and then accept for a certain win.
async function testExpiry() {
  console.log('9. expiry: honoured, with one margin of grace for a signed tx in flight');
  // REAL ledger indices: the expiry field is only treated as absolute when it is > 1,000,000, because
  // the ladder branch writes the MARGIN into the same slot. Toy ledger numbers skip the check entirely.
  const L = 105955000, EXPIRY = L + 900;
  const mk = async acceptLseq => {
    const w = world();
    w.mint(NID_A, ALICE, L - 100); w.mint(NID_B, BOB, L - 50);
    const BID = '9'.repeat(64);
    w.pay(ALICE, ISSUER, 1, ['challenge', NID_A, '1', String(EXPIRY)].join('|'), L, BID);
    w.pay(BOB, ISSUER, 1, ['accept', BID, NID_B].join('|'), acceptLseq, 'ACC1');
    w.current = L + 100000;
    return pickAccept(w.client, ISSUER, await loadBattle(w.client, ISSUER, BID));
  };
  ok(!!await mk(EXPIRY - 1), 'in time -> accepted');
  ok(!!await mk(EXPIRY + 2), 'a few ledgers late (signed tx in flight) -> still accepted');
  ok((await mk(EXPIRY + 600)) === null, 'long after expiry -> refused');
}

// ── 10. the poller's target must not move with a later accept ───────────────────────────────────
function testPollerTarget() {
  console.log("10. poller: a later accept does not push the resolution ledger out");
  pendingPvp.clear();
  const BID = '1'.repeat(64);
  const acc = { Memos: [{ Memo: { MemoType: hex(BATTLE_MEMO), MemoData: hex(['accept', BID, NID_B].join('|')) } }] };
  noteLadderChallenge(acc, 'H1', 1030);
  const first = pendingPvp.get(BID);
  noteLadderChallenge(acc, 'H2', 1400);
  ok(pendingPvp.get(BID) === first, `target stayed at ${first}`, pendingPvp.get(BID));
  pendingPvp.clear();
}

(async () => {
  await testReRoll();
  await testForgedResult();
  await testRefundTheft();
  await testSelfBattle();
  await testConscription();
  await testGhostPet();
  await testTecIsNotSuccess();
  await testRefundIdempotence();
  await testExpiry();
  testPollerTarget();
  console.log('');
  if (failures) { console.error(`FAILED: ${failures}/${checks} checks\n`); process.exit(1); }
  console.log(`PASS: ${checks} checks — only the issuer settles, and only the first valid accept counts.`);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
