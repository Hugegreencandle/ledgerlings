// G1 — prove the ISSUER can NFTokenModify a PLAYER-OWNED mutable NFT on testnet.
// Mirrors production flags: TF_MUTABLE_TRANSFERABLE = 8|16, taxon 7777, TransferFee 5000.
// PASS = player owns the pet AND issuer NFTokenModify(Owner=player) -> tesSUCCESS AND URI changed.
const xrpl = require('xrpl');
const ENDPOINT = 'wss://s.altnet.rippletest.net:51233';
const TAXON = 7777, TF_MUTABLE_TRANSFERABLE = 8 | 16, ROYALTY_BPS = 5000;
const hx = (s) => xrpl.convertStringToHex(s);
const uxh = (h) => xrpl.convertHexToString(h);

async function submit(c, w, tx, label) {
  const prep = await c.autofill(tx);
  const r = (await c.submitAndWait(w.sign(prep).tx_blob)).result;
  const code = r.meta.TransactionResult;
  console.log(`  ${label}: ${code}`);
  if (code !== 'tesSUCCESS') throw new Error(`${label} -> ${code}`);
  return r;
}
const nftsOf = async (c, a) =>
  (await c.request({ command: 'account_nfts', account: a, ledger_index: 'validated' })).result.account_nfts;

(async () => {
  const c = new xrpl.Client(ENDPOINT);
  await c.connect();
  console.log('funding two testnet wallets (issuer, player)…');
  const issuer = (await c.fundWallet()).wallet;
  const player = (await c.fundWallet()).wallet;
  console.log('  issuer', issuer.classicAddress, '\n  player', player.classicAddress);

  // 1) issuer mints a MUTABLE pet, URI v1
  const URI1 = hx(JSON.stringify({ v: 1, owner: player.classicAddress, care: 0 }));
  const mint = await submit(c, issuer, {
    TransactionType: 'NFTokenMint', Account: issuer.classicAddress, NFTokenTaxon: TAXON,
    Flags: TF_MUTABLE_TRANSFERABLE, TransferFee: ROYALTY_BPS, URI: URI1 }, 'mint');
  const nid = mint.meta.nftoken_id;
  console.log('  nid', nid);

  // 2) issuer creates a 0-drop sell offer locked to the player
  await submit(c, issuer, {
    TransactionType: 'NFTokenCreateOffer', Account: issuer.classicAddress, NFTokenID: nid,
    Amount: '0', Flags: 1 /* tfSellNFToken */, Destination: player.classicAddress }, 'createOffer');
  const offers = (await c.request({ command: 'nft_sell_offers', nft_id: nid, ledger_index: 'validated' })).result.offers;
  const offerIndex = offers[0].nft_offer_index;
  console.log('  offerIndex', offerIndex);

  // 3) PLAYER accepts -> player owns the pet
  await submit(c, player, {
    TransactionType: 'NFTokenAcceptOffer', Account: player.classicAddress, NFTokenSellOffer: offerIndex }, 'playerAccept');
  const playerNfts = await nftsOf(c, player.classicAddress);
  const owned = playerNfts.find(n => n.NFTokenID === nid);
  console.log('  player owns pet on-ledger:', !!owned, '| account_nfts(player) count:', playerNfts.length);
  if (!owned) throw new Error('player does NOT own the pet after accept');

  // 4) THE CRUX — issuer modifies the PLAYER-OWNED token (Owner=player), URI v2
  const URI2 = hx(JSON.stringify({ v: 2, owner: player.classicAddress, care: 50 }));
  await submit(c, issuer, {
    TransactionType: 'NFTokenModify', Account: issuer.classicAddress, NFTokenID: nid,
    Owner: player.classicAddress, URI: URI2 }, 'issuerModify(Owner=player)');

  // 5) confirm URI actually changed AND still player-owned
  const after = (await nftsOf(c, player.classicAddress)).find(n => n.NFTokenID === nid);
  const uriNow = after ? uxh(after.URI) : null;
  const changed = uriNow === JSON.stringify({ v: 2, owner: player.classicAddress, care: 50 });
  console.log('  URI after modify:', uriNow);
  console.log('  URI changed to v2:', changed, '| still player-owned:', !!after);

  await c.disconnect();
  const pass = !!owned && !!after && changed;
  console.log('\n=== G1', pass ? 'PASS ✅' : 'FAIL ❌', '===');
  console.log(pass
    ? 'Issuer CAN modify a player-owned mutable NFT (Owner=player). Self-custody + poller coexist.'
    : 'Self-custody path is NOT clear — reassess before building /claim-pet.');
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('G1 ERROR:', e.message); process.exit(1); });
