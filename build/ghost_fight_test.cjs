#!/usr/bin/env node
/* Ghost fights: fighting a SNAPSHOT of somebody else's pet, with one commitment and no second human.
 *
 * pvpPlayed sat at 0 for a week. The reason was never the invitation flow — it was that a duel needs
 * two people to both sign inside a window, and half this game's owners pasted an address and never
 * signed anything again. Every async game that works at small scale deletes the counterparty instead
 * of improving the invite: Super Auto Pets fights stored teams, Fire Emblem Heroes' arena defender
 * does nothing, Clash of Clans' Revenge runs against a shadow base.
 *
 * A ghost fight has exactly ONE commitment, so it is structurally the already-verified ladder path
 * with the NPC stat block swapped for a real pet's derived state. The accept-derived seed rule
 * exists only to stop a second mover peeking at the dice; with no second mover there is nothing to
 * peek at.
 *
 * THREE PROPERTIES THIS FILE EXISTS TO PIN, all of them things that would be quietly wrong:
 *   1. the ghost's record is NEVER credited — their owner did not agree to fight, and a loss landing
 *      on a stranger's public board is the exact conscription pickAccept was written to prevent
 *   2. a DEAD ghost cannot be farmed — a passed pet forfeits under battle_rules, and half this
 *      game's pets are dying unattended, so an unguarded ghost fight is a free-win generator
 *   3. two pets with the same owner cannot fight, checked at RESOLUTION and not only at /sign,
 *      because a raw Payment carrying a ghost memo bypasses /sign entirely
 *
 * Drives the REAL loadBattle / resolveBattleTx / verifyBattle out of server.js against a stubbed
 * client, so it fails if the rules move.
 */
'use strict';

const S = require('./server.js');
const { enc, hex, R, loadBattle, resolveBattleTx, verifyBattle, BATTLE_LEDGER_MARGIN, BATTLE_MEMO } = S;

const ISSUER = 'rISSUER', ALICE = 'rALICE', BOB = 'rBOB';
const NID_A = 'A'.repeat(64), NID_G = 'B'.repeat(64), NID_A2 = 'C'.repeat(64);

let failures = 0, checks = 0;
const ok = (cond, label, detail) => {
  checks++;
  if (cond) console.log(`  ok   ${label}`);
  else { console.log(`  XX   ${label}${detail === undefined ? '' : '  -> ' + JSON.stringify(detail)}`); failures++; }
};

function world() {
  const w = { txs: [], nfts: [], current: 100000, submitted: [] };
  w.mint = (nid, owner, birth) => {
    const g = R.genesis(birth, owner);
    w.nfts.push({ NFTokenID: nid, NFTokenTaxon: 7777, URI: enc(g) });
    w.txs.push({ tx: { TransactionType: 'NFTokenMint', Account: ISSUER, URI: enc(g), ledger_index: birth },
      meta: { nftoken_id: nid, TransactionResult: 'tesSUCCESS' }, hash: 'MINT' + nid.slice(0, 4) });
    return g;
  };
  // Write a pet's state directly, so a ghost can be made dead without simulating days of neglect.
  w.setState = (nid, st, lseq) => {
    const n = w.nfts.find(x => x.NFTokenID === nid); if (n) n.URI = enc(st);
    w.txs.push({ tx: { TransactionType: 'NFTokenModify', Account: ISSUER, URI: enc(st), ledger_index: lseq,
      NFTokenID: nid }, meta: { TransactionResult: 'tesSUCCESS' }, hash: 'MOD' + w.txs.length });
  };
  w.pay = (from, to, drops, memo, lseq, hash) => {
    w.txs.push({ tx: { TransactionType: 'Payment', Account: from, Destination: to, Amount: String(drops),
      ledger_index: lseq, hash, Memos: memo ? [{ Memo: { MemoType: hex(BATTLE_MEMO), MemoData: hex(memo) } }] : undefined },
      meta: { TransactionResult: 'tesSUCCESS', delivered_amount: String(drops) }, hash });
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
    async submitAndWait(blob) { w.submitted.push(blob); return { result: { meta: { TransactionResult: 'tesSUCCESS', nftoken_id: 'CARD' }, hash: 'CARDTX' } }; },
  };
  w.wallet = { classicAddress: ISSUER, sign: tx => ({ tx_blob: tx }) };
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
const memoOf = tx => { const m = (tx.Memos || [])[0]; return m ? Buffer.from(m.Memo.MemoData, 'hex').toString('utf8') : null; };

(async () => {
  console.log('\n1. a ghost fight settles from ONE commitment, with no accept and no second signer');
  {
    const w = world();
    w.mint(NID_A, ALICE, 90000); w.mint(NID_G, BOB, 90000);
    const bid = w.pay(ALICE, ISSUER, 1, ['ghost', NID_A, NID_G, String(BATTLE_LEDGER_MARGIN)].join('|'), 100000, 'G'.repeat(64));
    w.current = 100000 + BATTLE_LEDGER_MARGIN + 5;
    const r = await resolveBattleTx(w.client, w.wallet, bid);
    ok(r && r.ghost === true && !r.error, 'resolved as a ghost fight', r);
    ok(r && [NID_A, NID_G, 'DRAW'].includes(r.winner), 'produced a winner', r && r.winner);
    ok(r && r.seedLedger === 100000 + BATTLE_LEDGER_MARGIN,
       'seed ledger derived from the CHALLENGE landing ledger, not the memo', r && r.seedLedger);
    const res = w.submitted.find(t => t.TransactionType === 'Payment');
    ok(res && res.Destination === ALICE, 'the result payment goes to the challenger', res && res.Destination);
  }

  console.log('\n2. THE GHOST IS NEVER CREDITED — loadBattle must not expose the ghost as bNid');
  {
    const w = world();
    w.mint(NID_A, ALICE, 90000); w.mint(NID_G, BOB, 90000);
    const bid = w.pay(ALICE, ISSUER, 1, ['ghost', NID_A, NID_G, '20'].join('|'), 100000, 'H'.repeat(64));
    const b = await loadBattle(w.client, ISSUER, bid);
    ok(b.challenge && b.challenge.ghost === true, 'parsed as a ghost challenge', b.challenge);
    ok(b.challenge && b.challenge.ghostNid === NID_G, 'ghost id recorded', b.challenge && b.challenge.ghostNid);
    ok(!b.accepts || b.accepts.length === 0, 'no accept is involved at all', b.accepts);
    // The leaderboard credits [aNid, bNid] only when pvp is true, and pvp requires !b.ghost.
    // If a future edit ever set bNid on a ghost, the ghost's owner starts taking losses they
    // never agreed to — so pin the absence directly.
    ok(b.challenge.bNid === undefined, 'the ghost is NOT exposed as bNid', b.challenge.bNid);
  }

  console.log('\n3. a DEAD ghost cannot be farmed — the fight VOIDs instead of paying a free win');
  {
    const w = world();
    w.mint(NID_A, ALICE, 90000);
    // Killed the way the rules actually kill: by neglect over time. A pet is dead ~1.33 days
    // (28,800 ledgers) after its last interaction, and death only materialises when someone
    // projects the state forward — which is precisely why an untouched pet reads alive forever
    // on every surface that merely replays. Born far enough back that it is derived-dead by N.
    w.mint(NID_G, BOB, 20000);
    const bid = w.pay(ALICE, ISSUER, 1, ['ghost', NID_A, NID_G, '20'].join('|'), 100000, 'I'.repeat(64));
    w.current = 100000 + BATTLE_LEDGER_MARGIN + 5;
    const r = await resolveBattleTx(w.client, w.wallet, bid);
    ok(r && r.status === 'VOID', 'a dead ghost VOIDs the fight', r);
    const res = w.submitted.find(t => t.TransactionType === 'Payment');
    ok(res && /\|VOID\|/.test(memoOf(res) || ''), 'the VOID is recorded on-ledger, not just refused', memoOf(res));
    ok(!w.submitted.some(t => t.TransactionType === 'NFTokenMint'), 'no battle card is minted for a voided fight');
    w.settle();
    const v = await verifyBattle(w.client, ISSUER, bid);
    ok(v.verdict === 'VOID' && v.ok === true, 'the verifier RE-DERIVES the refusal rather than trusting it', v);
  }

  console.log('\n4. you cannot fight your own pet, checked at RESOLUTION (a raw memo bypasses /sign)');
  {
    const w = world();
    w.mint(NID_A, ALICE, 90000); w.mint(NID_A2, ALICE, 90000);   // both ALICE's
    const bid = w.pay(ALICE, ISSUER, 1, ['ghost', NID_A, NID_A2, '20'].join('|'), 100000, 'J'.repeat(64));
    w.current = 100000 + BATTLE_LEDGER_MARGIN + 5;
    const r = await resolveBattleTx(w.client, w.wallet, bid);
    ok(r && /own pet/.test(r.error || ''), 'same-owner ghost fight refused', r);
    ok(w.submitted.length === 0, 'and nothing was written to the ledger', w.submitted.length);
  }
  {
    const w = world();
    w.mint(NID_A, ALICE, 90000);
    const bid = w.pay(ALICE, ISSUER, 1, ['ghost', NID_A, NID_A, '20'].join('|'), 100000, 'K'.repeat(64));
    w.current = 100000 + BATTLE_LEDGER_MARGIN + 5;
    const r = await resolveBattleTx(w.client, w.wallet, bid);
    ok(r && /own ghost/.test(r.error || ''), 'a pet cannot fight ITSELF', r);
  }

  console.log('\n5. the result is publicly re-derivable, like every other fight in this game');
  {
    const w = world();
    w.mint(NID_A, ALICE, 90000); w.mint(NID_G, BOB, 90000);
    const bid = w.pay(ALICE, ISSUER, 1, ['ghost', NID_A, NID_G, '20'].join('|'), 100000, 'L'.repeat(64));
    w.current = 100000 + BATTLE_LEDGER_MARGIN + 5;
    const r = await resolveBattleTx(w.client, w.wallet, bid);
    w.settle();
    const v = await verifyBattle(w.client, ISSUER, bid);
    ok(v.verdict === 'PASS' && v.ok === true, 'verify PASSes an honest ghost fight', v.verdict);
    ok(v.math && v.math.scoreA === r.scoreA && v.math.scoreB === r.scoreB,
       'the verifier reproduces the same arithmetic the resolver used', v.math);
    ok(v.nids && v.nids.b === NID_G, 'the ghost is named in the verification output', v.nids);
  }

  console.log(failures ? `\n${failures} FAILED of ${checks}` : `\nPASS: ${checks} checks — one commitment, ghost never credited, dead ghosts unfarmable.`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('crashed:', e); process.exit(2); });
