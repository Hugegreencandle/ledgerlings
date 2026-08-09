// migrate_claim_offers — make the EXISTING custodial pets claimable to real self-custody.
// For each pet STILL held by the issuer (taxon 7777), read its URI owner and create a 0-drop,
// destination-locked NFTokenCreateOffer to that owner. Then those owners can /claim-pet -> own on-ledger.
//
// SAFE BY DEFAULT: dry-run (prints the plan, submits nothing). Pass --commit to actually create offers.
// IDEMPOTENT: skips a pet that already has a live 0-drop offer to its owner, so re-runs are cheap + resumable.
// Only touches issuer-HELD pets (never claimed ones). Targets whatever XRPL_ENDPOINT points at — for the
// 39 mainnet pets that MUST be mainnet + the mainnet issuer RegularKey (Dane's key), so the --commit run is
// Dane's to execute. This module is unit-proven on testnet by g4_migration.cjs.
process.env.POLLER = '0';
const xrpl = require('xrpl');
const S = require('./server.js');

const SOURCE_TAG = process.env.MAKEWAVES_SOURCE_TAG !== undefined && process.env.MAKEWAVES_SOURCE_TAG !== ''
  ? Number(process.env.MAKEWAVES_SOURCE_TAG) : undefined;
const withTag = (tx) => (SOURCE_TAG !== undefined ? { ...tx, SourceTag: SOURCE_TAG } : tx);

async function liveSellOffers(c, nid) {
  try { return (await c.request({ command: 'nft_sell_offers', nft_id: nid, ledger_index: 'validated' })).result.offers || []; }
  catch (e) {
    const code = e && e.data && e.data.error;              // 'objectNotFound' when a token has no offers
    const msg = String((e && e.message) || e).toLowerCase();
    if (code === 'objectNotFound' || msg.includes('objectnotfound') || msg.includes('not found')) return [];
    throw e;
  }
}

// Build the migration plan for pets STILL held by `issuer`.
async function planMigration(c, issuer) {
  const held = (await S.allIssuerNfts(c, issuer)).filter(n => n.NFTokenTaxon === S.TAXON && n.URI);
  const plan = [];
  for (const n of held) {
    let owner = null; try { owner = S.dec(n.URI).owner; } catch { /* undecodable */ }
    if (!owner || owner === issuer) { plan.push({ nid: n.NFTokenID, owner, skip: 'no external owner in URI' }); continue; }
    const has = (await liveSellOffers(c, n.NFTokenID)).some(o => o.destination === owner && o.amount === '0');
    plan.push(has ? { nid: n.NFTokenID, owner, skip: 'claim offer already exists' } : { nid: n.NFTokenID, owner, action: 'create' });
  }
  return plan;
}

// Execute the plan (create the offers). Requires a signing wallet = the issuer.
async function commitMigration(c, w, plan) {
  const issuer = w.classicAddress; const results = [];
  for (const p of plan.filter(x => x.action === 'create')) {
    try {
      const tx = await c.autofill(withTag({ TransactionType: 'NFTokenCreateOffer', Account: issuer,
        NFTokenID: p.nid, Amount: '0', Flags: 1 /* tfSellNFToken */, Destination: p.owner }));
      const code = (await c.submitAndWait(w.sign(tx).tx_blob)).result.meta.TransactionResult;
      results.push({ nid: p.nid, owner: p.owner, result: code });
    } catch (e) { results.push({ nid: p.nid, owner: p.owner, result: 'ERR', error: e.message }); }
  }
  return results;
}

async function main() {
  const commit = process.argv.includes('--commit');
  const endpoint = process.env.XRPL_ENDPOINT;
  const issuerAddr = process.env.ISSUER_ADDRESS;
  const seed = process.env.LEDGERLINGS_ISSUER_SEED;
  if (!endpoint) { console.error('set XRPL_ENDPOINT (mainnet for the 39 real pets)'); process.exit(2); }
  if (!issuerAddr && !seed) { console.error('set ISSUER_ADDRESS (read) or LEDGERLINGS_ISSUER_SEED (commit)'); process.exit(2); }
  const c = new xrpl.Client(endpoint); await c.connect();
  let w = null, issuer = issuerAddr;
  if (seed) { w = xrpl.Wallet.fromSeed(seed, seed.startsWith('sEd') ? { algorithm: 'ed25519' } : undefined);
    if (process.env.ISSUER_ADDRESS) w.classicAddress = process.env.ISSUER_ADDRESS; issuer = w.classicAddress; }
  console.log(`endpoint ${endpoint}\nissuer   ${issuer}\nmode     ${commit ? 'COMMIT (creating offers)' : 'DRY-RUN (no submit)'}  sourceTag ${SOURCE_TAG ?? '(none)'}\n`);
  const plan = await planMigration(c, issuer);
  const toCreate = plan.filter(p => p.action === 'create');
  for (const p of plan) console.log(`  ${p.nid.slice(0, 12)}…  owner ${String(p.owner || '-').slice(0, 14)}  ${p.action || 'SKIP: ' + p.skip}`);
  console.log(`\nplan: ${toCreate.length} offer(s) to create, ${plan.length - toCreate.length} skipped`);
  if (commit) {
    if (!w) { console.error('COMMIT needs LEDGERLINGS_ISSUER_SEED'); process.exit(2); }
    const res = await commitMigration(c, w, plan);
    const ok = res.filter(r => r.result === 'tesSUCCESS').length;
    console.log(`\ncommitted: ${ok}/${res.length} offers created`);
    for (const r of res.filter(r => r.result !== 'tesSUCCESS')) console.log('  FAIL', r.nid.slice(0, 12), r.result, r.error || '');
  } else {
    console.log('DRY-RUN only. Re-run with --commit (and LEDGERLINGS_ISSUER_SEED set) to create the offers.');
  }
  await c.disconnect();
}

module.exports = { planMigration, commitMigration, liveSellOffers };
if (require.main === module) main().catch(e => { console.error('migration error:', e.message); process.exit(1); });
