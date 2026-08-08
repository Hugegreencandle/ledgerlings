// G3 — the poller's INIT catch-up must DISCOVER a CLAIMED pet (which left the issuer wallet) via
// mint-history enumeration, then reconcile it to /verify PASS. Proves the fleet-discovery gap is closed.
// The point: a claimed pet is NOT in allIssuerNfts, but IS in allMintedPetNids.
process.env.POLLER = '0';
process.env.AUTO_AWARD = '0';
const xrpl = require('xrpl');
const S = require('./server.js');
const hx = (s) => xrpl.convertStringToHex(s);

async function submit(c, w, tx, label) {
  const prep = await c.autofill(tx);
  const r = (await c.submitAndWait(w.sign(prep).tx_blob)).result;
  const code = r.meta.TransactionResult;
  console.log(`  ${label}: ${code}`);
  if (code !== 'tesSUCCESS') throw new Error(`${label} -> ${code}`);
  return r;
}

(async () => {
  const c = new xrpl.Client(S.ENDPOINT);
  await c.connect();
  const issuer = (await c.fundWallet()).wallet;
  const player = (await c.fundWallet()).wallet;
  console.log('  issuer', issuer.classicAddress, '| player', player.classicAddress);

  // mint + claim -> pet leaves the issuer wallet
  const now = (await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index;
  const mint = await submit(c, issuer, { TransactionType: 'NFTokenMint', Account: issuer.classicAddress,
    NFTokenTaxon: S.TAXON, Flags: S.TF_MUTABLE_TRANSFERABLE, TransferFee: S.ROYALTY_BPS,
    URI: S.enc(S.R.genesis(now, player.classicAddress, '')) }, 'mint');
  const nid = mint.meta.nftoken_id;
  await submit(c, issuer, { TransactionType: 'NFTokenCreateOffer', Account: issuer.classicAddress, NFTokenID: nid,
    Amount: '0', Flags: 1, Destination: player.classicAddress }, 'createClaimOffer');
  const offer = (await c.request({ command: 'nft_sell_offers', nft_id: nid, ledger_index: 'validated' })).result.offers[0].nft_offer_index;
  await submit(c, player, { TransactionType: 'NFTokenAcceptOffer', Account: player.classicAddress, NFTokenSellOffer: offer }, 'playerClaim');

  // player interacts (creates pending state) — simulate the poller being DOWN (no reconcile yet)
  await submit(c, player, { TransactionType: 'Payment', Account: player.classicAddress, Destination: issuer.classicAddress,
    Amount: '1', Memos: [{ Memo: { MemoType: hx('ledgerlings/op'), MemoData: hx(`feed|${nid}`) } }] }, 'playerInteract(feed)');

  // THE GAP: allIssuerNfts (old discovery) must NOT see the claimed pet; allMintedPetNids (new) MUST.
  const heldNids = (await S.allIssuerNfts(c, issuer.classicAddress)).filter(n => n.NFTokenTaxon === S.TAXON).map(n => n.NFTokenID);
  const mintedNids = await S.allMintedPetNids(c, issuer.classicAddress);
  const inHeld = heldNids.includes(nid), inMinted = mintedNids.includes(nid);
  console.log(`  claimed pet in allIssuerNfts (old): ${inHeld}  | in allMintedPetNids (new): ${inMinted}`);

  // simulate the INIT catch-up over the union → reconcile the claimed pet
  const petNids = [...new Set([...heldNids, ...mintedNids])];
  let rec;
  for (const n of petNids) { const r = await S.reconcilePet(c, issuer, n); if (n === nid) rec = r; }
  const v = await S.verifyPet(c, issuer.classicAddress, nid);
  await c.disconnect();

  const pass = !inHeld && inMinted && rec && rec.updated && rec.holder === player.classicAddress && v.verdict === 'PASS';
  console.log(`  reconcile(claimed): updated=${rec && rec.updated} holder=${rec && rec.holder}  | verify=${v.verdict}`);
  console.log('\n=== G3', pass ? 'PASS ✅' : 'FAIL ❌', '===');
  console.log(pass
    ? 'Claimed pet (gone from issuer wallet) is discovered by mint-history enumeration + reconciled to verify PASS. Gap closed.'
    : `gap NOT closed — inHeld=${inHeld} inMinted=${inMinted} rec=${JSON.stringify(rec)} verify=${v.verdict}`);
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('G3 ERROR:', e.message); process.exit(1); });
