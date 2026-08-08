// G2 — after a pet is CLAIMED to a player, an interaction + the OWNER-AWARE poller reconcile must still
// produce /verify PASS. Drives the REAL server exports (reconcilePet, verifyPet, loadHistory via them).
// PASS = player owns pet on-ledger, reconcile modifies the player-held token (Owner=player), verify=PASS.
process.env.POLLER = '0';
process.env.AUTO_AWARD = '0';   // keep G2 focused on state reconcile, not badge mints
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
const nftsOf = async (c, a) => (await c.request({ command: 'account_nfts', account: a, ledger_index: 'validated' })).result.account_nfts;

(async () => {
  const c = new xrpl.Client(S.ENDPOINT);
  await c.connect();
  console.log('funding issuer + player…');
  const issuer = (await c.fundWallet()).wallet;
  const player = (await c.fundWallet()).wallet;
  console.log('  issuer', issuer.classicAddress, '| player', player.classicAddress);

  // 1) mint pet (genesis URI owner = player) — same as /adopt mint
  const now = (await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index;
  const genesis = S.R.genesis(now, player.classicAddress, '');
  const mint = await submit(c, issuer, { TransactionType: 'NFTokenMint', Account: issuer.classicAddress,
    NFTokenTaxon: S.TAXON, Flags: S.TF_MUTABLE_TRANSFERABLE, TransferFee: S.ROYALTY_BPS, URI: S.enc(genesis) }, 'mint');
  const nid = mint.meta.nftoken_id;
  console.log('  nid', nid);

  // 2) claim: 0-drop offer locked to player, player accepts -> player owns
  await submit(c, issuer, { TransactionType: 'NFTokenCreateOffer', Account: issuer.classicAddress, NFTokenID: nid,
    Amount: '0', Flags: 1, Destination: player.classicAddress }, 'createClaimOffer');
  const offer = (await c.request({ command: 'nft_sell_offers', nft_id: nid, ledger_index: 'validated' })).result.offers[0].nft_offer_index;
  await submit(c, player, { TransactionType: 'NFTokenAcceptOffer', Account: player.classicAddress, NFTokenSellOffer: offer }, 'playerClaim');
  const claimed = (await nftsOf(c, player.classicAddress)).some(n => n.NFTokenID === nid);
  console.log('  player owns pet after claim:', claimed);
  if (!claimed) throw new Error('claim failed — player does not own pet');

  // 3) player interaction: a 'feed' op Payment to the issuer (the on-ledger care action)
  await submit(c, player, { TransactionType: 'Payment', Account: player.classicAddress, Destination: issuer.classicAddress,
    Amount: '1', Memos: [{ Memo: { MemoType: hx('ledgerlings/op'), MemoData: hx(`feed|${nid}`) } }] }, 'playerInteract(feed)');

  // 4) OWNER-AWARE reconcile: reads current from the PLAYER, NFTokenModify with Owner=player
  const rec = await S.reconcilePet(c, issuer, nid);
  console.log('  reconcile:', JSON.stringify(rec).slice(0, 140));

  // 5) verify still PASS + player still owns
  const v = await S.verifyPet(c, issuer.classicAddress, nid);
  const stillOwns = (await nftsOf(c, player.classicAddress)).some(n => n.NFTokenID === nid);
  console.log('  verify verdict:', v.verdict, '| interactions:', v.interactions, '| player still owns:', stillOwns);

  await c.disconnect();
  const pass = claimed && (rec.holder === player.classicAddress) && v.verdict === 'PASS' && stillOwns;
  console.log('\n=== G2', pass ? 'PASS ✅' : 'FAIL ❌', '===');
  console.log(pass
    ? 'Claimed pet: player owns it, owner-aware poller reconciles it (Owner=player), /verify still PASS.'
    : `something off — reconcile.holder=${rec.holder} verdict=${v.verdict} owns=${stillOwns}`);
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('G2 ERROR:', e.message); process.exit(1); });
