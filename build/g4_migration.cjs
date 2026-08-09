// G4 — prove migrate_claim_offers on testnet: mint CUSTODIAL pets (issuer-held, owner in URI, NO offer),
// run the migration to create claim offers, prove idempotence, then a player claims one to real ownership.
process.env.POLLER = '0';
const xrpl = require('xrpl');
const S = require('./server.js');
const M = require('./migrate_claim_offers.cjs');

async function submit(c, w, tx, label) {
  const r = (await c.submitAndWait(w.sign(await c.autofill(tx)).tx_blob)).result;
  const code = r.meta.TransactionResult;
  if (label) console.log(`  ${label}: ${code}`);
  if (code !== 'tesSUCCESS') throw new Error(`${label} -> ${code}`);
  return r;
}
const mintCustodial = async (c, issuer, ownerAddr) => {
  const now = (await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index;
  const r = await submit(c, issuer, { TransactionType: 'NFTokenMint', Account: issuer.classicAddress,
    NFTokenTaxon: S.TAXON, Flags: S.TF_MUTABLE_TRANSFERABLE, TransferFee: S.ROYALTY_BPS,
    URI: S.enc(S.R.genesis(now, ownerAddr, '')) }, null);
  return r.meta.nftoken_id;
};

(async () => {
  const c = new xrpl.Client(S.ENDPOINT);
  await c.connect();
  const issuer = (await c.fundWallet()).wallet;
  const p1 = (await c.fundWallet()).wallet;
  const p2 = (await c.fundWallet()).wallet;
  console.log('  issuer', issuer.classicAddress);

  // 2 CUSTODIAL pets (issuer-held, owner in URI), no claim offer — mimics the 39 mainnet pets
  const n1 = await mintCustodial(c, issuer, p1.classicAddress);
  const n2 = await mintCustodial(c, issuer, p2.classicAddress);
  console.log('  minted custodial pets:', n1.slice(0, 10), n2.slice(0, 10));

  // plan (dry) — expect 2 to create
  let plan = await M.planMigration(c, issuer.classicAddress);
  const create1 = plan.filter(p => p.action === 'create').length;
  console.log('  plan #1: create =', create1, '(expect 2)');

  // commit -> create offers
  const res = await M.commitMigration(c, issuer, plan);
  const ok = res.filter(r => r.result === 'tesSUCCESS').length;
  console.log('  committed offers:', ok, '(expect 2)');

  // plan again -> idempotent (0 to create, both skip)
  plan = await M.planMigration(c, issuer.classicAddress);
  const create2 = plan.filter(p => p.action === 'create').length;
  console.log('  plan #2 (idempotent): create =', create2, '(expect 0)');

  // player1 claims via the offer -> owns on-ledger
  const offers = await M.liveSellOffers(c, n1);
  const off = offers.find(o => o.destination === p1.classicAddress && o.amount === '0');
  await submit(c, p1, { TransactionType: 'NFTokenAcceptOffer', Account: p1.classicAddress, NFTokenSellOffer: off.nft_offer_index }, 'p1 claim');
  const owns = (await c.request({ command: 'account_nfts', account: p1.classicAddress, ledger_index: 'validated' })).result.account_nfts.some(n => n.NFTokenID === n1);
  console.log('  player1 owns pet on-ledger after claim:', owns);

  await c.disconnect();
  const pass = create1 === 2 && ok === 2 && create2 === 0 && owns;
  console.log('\n=== G4', pass ? 'PASS ✅' : 'FAIL ❌', '===');
  console.log(pass
    ? 'Migration creates destination-locked claim offers for custodial pets, is idempotent, and owners can claim to real ownership.'
    : `off — create1=${create1} committed=${ok} create2=${create2} owns=${owns}`);
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('G4 ERROR:', e.message); process.exit(1); });
