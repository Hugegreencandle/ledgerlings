/* Ledgerlings issuer backend — the only party that can NFTokenModify a pet.
 * Verifies the player's signed Payment(+op memo) via the Xaman SDK, applies the open rules, and writes the
 * new state to the pet's dNFT URI. Uses the PAYMENT's ledger_index as `now` (so the replay verifier can
 * reproduce decay/age — the verifiability fix).
 *
 * Setup (see XAMAN_SETUP.md):  npm install  ·  set env  ·  node server.js
 *   XAMAN_API_KEY, XAMAN_API_SECRET   (https://apps.xaman.dev)
 *   LEDGERLINGS_ISSUER_SEED            (the SIGNING seed — mints + modifies; KEEP SECRET. In the
 *                                      RegularKey setup this is the REGULARKEY seed, NOT the master.)
 *   ISSUER_ADDRESS                    (optional; the issuer account we act AS = the Account on every
 *                                      tx. Set this to the ISSUER (master) address when the seed above
 *                                      is a RegularKey. Unset => act as the seed's own account.)
 *   XRPL_ENDPOINT                     (default testnet)
 */
const express = require('express');
const xrpl = require('xrpl');
const { XummSdk } = require('xumm-sdk');
const crypto = require('crypto');
const R = require('./pet_rules.js');
const A = require('./achievements.js');
const BR = require('./battle_rules.js');
const { verifyPetQuorum } = require('./verify_quorum.cjs');

// sdk only needed for /interact (verifying signed payloads); lazy so /adopt + /pet + tests run without it.
const sdk = process.env.XAMAN_API_KEY ? new XummSdk(process.env.XAMAN_API_KEY, process.env.XAMAN_API_SECRET) : null;
const ENDPOINT = process.env.XRPL_ENDPOINT || 'wss://s.altnet.rippletest.net:51233';
const ISSUER_SEED = process.env.LEDGERLINGS_ISSUER_SEED;
// RegularKey setup: sign with LEDGERLINGS_ISSUER_SEED (the RegularKey) but act AS the issuer account.
// When ISSUER_ADDRESS is set we override the wallet's classicAddress so every tx Account + every
// account_nfts/account_tx lookup targets the ISSUER, while signing still uses the RegularKey keypair
// (the ledger accepts it because the issuer authorized that key via SetRegularKey). Unset => the wallet
// acts as its own account (the plain master-key mode; testnet unaffected).
const ISSUER_ADDRESS = process.env.ISSUER_ADDRESS || undefined;
const TAXON = 7777, TF_MUTABLE_TRANSFERABLE = 8 | 16;
// Royalty: native XRPL TransferFee, auto-paid to the issuer on every secondary sale.
// 0–50000 = 0.000%–50.000% (0.001% steps). 5000 = 5%. Requires tfTransferable (set above).
// FINALIZED default = 5%; Dane confirms the final business number.
const ROYALTY_BPS = 5000;
// Collaborator accessories/backgrounds: separate taxon, transferable (royalty), not mutable.
const ACCESSORY_TAXON = 7778, TF_TRANSFERABLE = 8;
// Bring-your-character registrations (NFT projects adding a playable skin): own taxon. The roster is
// just "all issuer NFTs at this taxon" — persistent on-ledger, no database needed.
const CHARACTER_TAXON = 7779;
// Achievements (Make Waves #11): soulbound badges — non-transferable (Flags 0), no royalty, own taxon.
// A badge is a PURE PROJECTION of the pet's on-ledger history (achievements.js), so it re-derives + can't be faked.
const ACHIEVEMENT_TAXON = 7780;
// Ruleset version stamped into each badge so it can't be validated against a swapped ruleset.
// Production = the anchored open-rules hash; MVP default 'v1'.
// v2: egg hatches in-session. v3 (2026-08-06): battle roll is keyed nid-first with an avalanche
// finalizer — under v2 the roll was fnv1a(seed+':'+nid), and because sibling pet NFTokenIDs differ
// only in their low sequence bits, both pets' rolls came from a near-identical hash state. Care was
// worth nothing in some matchups and nearly decisive in others. See build/battle_rules.js.
// NOTE: this is the DEFAULT only. If RULESET_VERSION is set in the deploy environment it wins, so
// bumping this line does not change production on its own.
const RULESET_VERSION = String(process.env.RULESET_VERSION || 'v3').slice(0, 12);
// Auto-mint newly-earned badges inside /interact (more live on-chain txns for the demo). Default ON; AUTO_AWARD=0 disables.
const AUTO_AWARD = process.env.AUTO_AWARD !== '0';
// Battles (Make Waves #10): provably-fair pet duels. Soulbound "battle card" record NFT; own taxon.
const BATTLE_TAXON = 7781;
const BATTLE_FEE_BPS = Number(process.env.BATTLE_FEE_BPS || 500);        // platform cut of the pot (5%)
// Challenger pins a FUTURE ledger N >= now + margin so its hash is unknowable at commit (unbiasable seed).
// Ledgers between the challenge landing and the ledger whose hash seeds it. ~4s each, so 20 is
// roughly 80 seconds: long enough that the seed cannot be known at commitment, short enough that a
// player is not left waiting. Counted from the CHALLENGE's ledger, not from when the payload was built.
const BATTLE_LEDGER_MARGIN = Number(process.env.BATTLE_LEDGER_MARGIN || 20);
// Fight Club (PvP via /sign): how long a challenge stays acceptable, in ledgers (~4s each, so 900 ≈ 60 min).
// This is an EXPIRY written as an ABSOLUTE ledger index into memo field 4, not a seed commitment: the seed
// ledger is always derived at resolution from the ACCEPT's landing ledger (+ BATTLE_LEDGER_MARGIN), so the
// dice are unknowable at the moment of the last commitment no matter what this value is.
// 10800 ledgers at 4s each is 12 hours. It was 900, i.e. ONE HOUR, which is shorter than a
// timezone gap: challenge a friend and unless they happen to have Xaman open, the challenge expires
// before they ever see it. That made expiry the default outcome of challenging a human, which is
// the exact action the feature exists for.
//
// NOT 24 HOURS, and the reason is measured rather than assumed. A never-touched pet is dead by
// ledger 28802, which is 1.33 days. A passed pet forfeits, so an open challenge is also a window in
// which an opponent can simply wait for the challenger's pet to weaken and then accept for a
// near-free win. At 12h a challenge spans 37% of a neglected pet's whole lifespan; at 24h it spans
// 75%, which makes waiting a strategy rather than an edge case.
const BATTLE_CHALLENGE_TTL = Number(process.env.BATTLE_CHALLENGE_TTL || 10800);   // ledgers (12h at 4s)
const BATTLE_MEMO = 'ledgerlings/battle';
// House ladder: PUBLISHED NPC opponents (open stat blocks, versioned). Because the opponent's stats are public
// + fixed, a ladder battle is as provably-fair as PvP — the seed is still the pinned ledger hash and
// verify-battle re-derives the winner from (player history @N, the published NPC block, seed). Free (no wager).
const LADDER = [
  { id: 'runt',     name: 'Scrappy Runt',      stats: { stage: 1, form: 1, care: 20,  care_max: 40,  health: 70, alive: 1 } },
  { id: 'sparring', name: 'Sparring Partner',  stats: { stage: 2, form: 2, care: 60,  care_max: 80,  health: 85, alive: 1 } },
  { id: 'veteran',  name: 'Grizzled Veteran',  stats: { stage: 3, form: 3, care: 150, care_max: 180, health: 92, alive: 1 } },
  { id: 'champion', name: 'Ladder Champion',   stats: { stage: 4, form: 4, care: 230, care_max: 240, health: 98, alive: 1 } },
];
// SECURITY: all mint/write endpoints require this admin token (fail-closed). No anon minting from the
// issuer. ALLOWED_ORIGIN locks CORS. Set both in the host env.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://hugegreencandle.github.io';
// Broker fee = platform's atomic cut on a PRIMARY sale (NFTokenBrokerFee), as bps of the list price.
// Configurable — final business number TBD (Dane). 1000 = 10%. Artist keeps the price; platform keeps this.
const BROKER_FEE_BPS = Number(process.env.BROKER_FEE_BPS || 1000);
// Make Waves leaderboard attribution: stamp every project tx (issuer-signed AND user-signed offers)
// with the hackathon SourceTag so on-chain activity + active accounts are credited to Ledgerlings.
// Env-gated + non-breaking: unset => no SourceTag field, behaves exactly as before. Set MAKEWAVES_SOURCE_TAG.
const SOURCE_TAG = Number.isInteger(Number(process.env.MAKEWAVES_SOURCE_TAG))
  ? Number(process.env.MAKEWAVES_SOURCE_TAG) : undefined;
const tag = tx => (SOURCE_TAG !== undefined && tx && tx.SourceTag === undefined ? { ...tx, SourceTag: SOURCE_TAG } : tx);

const hex = s => Buffer.from(s, 'utf8').toString('hex').toUpperCase();
const unhex = h => Buffer.from(h, 'hex').toString('utf8');

// Compact on-ledger codec — the NFT URI is capped at 256 bytes; full-key JSON was 254 (≈no headroom).
// Short keys + omit `loadout` (cosmetic, step() never reads it) shrink the wire form to ~150 bytes while
// pet_rules state shape stays UNCHANGED in memory (so the diff harness + rules are untouched). Fixed key
// order => deterministic string, so the verifier's enc(derived) === enc(current) still holds.
const K = { v: 'v', owner: 'o', birth: 'b', last_ix: 'x', hunger: 'h', happiness: 'j', health: 'l',
  stage: 's', form: 'f', alive: 'a', age: 'g', care: 'c', care_max: 'm', death_cause: 'd',
  last_feed: 'F', last_play: 'P', name: 'n' };
const KINV = Object.fromEntries(Object.entries(K).map(([f, s]) => [s, f]));
const enc = state => {
  const o = {};
  for (const f in K) o[K[f]] = state[f];          // fixed order from K -> deterministic
  return hex(JSON.stringify(o));
};
const dec = h => {
  const o = JSON.parse(unhex(h));
  const s = { loadout: [] };                        // loadout not stored on-ledger; restore the default
  for (const sk in o) s[KINV[sk] || sk] = o[sk];
  return s;
};

// xrpl.Wallet.fromSeed() defaults to ed25519 and, given a secp256k1 family seed, SILENTLY derives a
// different account rather than erroring. Xaman "secret numbers" accounts are secp256k1, so a seed
// exported from Xaman would produce the wrong keypair here and every signature would fail auth with
// nothing in the logs pointing at why. Encoded ed25519 seeds start with "sEd"; everything else is
// secp256k1, so the prefix decides it.
const walletFromSeed = seed =>
  xrpl.Wallet.fromSeed(seed, { algorithm: seed.startsWith('sEd') ? 'ed25519' : 'ecdsa-secp256k1' });

async function withClient(fn) {
  const c = new xrpl.Client(ENDPOINT); await c.connect();
  try {
    const w = walletFromSeed(ISSUER_SEED);
    // RegularKey: sign with w's keypair but ACT AS the issuer — override the address so tx.Account and
    // every account lookup target the issuer; the signature stays the RegularKey's (valid per SetRegularKey).
    if (ISSUER_ADDRESS) w.classicAddress = ISSUER_ADDRESS;
    return await fn(c, w);
  } finally { await c.disconnect(); }
}
// Tiny in-process TTL cache for the PUBLIC read endpoints only.
//
// Every one of them (loadBattle, /leaderboard) paginates the issuer's ENTIRE account_tx history, over a
// fresh WebSocket connection per request, and the client polls an open fight for up to an hour. Cost
// per call also grows with total game history, because every pet interaction is a Payment to the same
// issuer — it gets more expensive exactly as the game succeeds. NOTHING that settles or verifies a
// battle reads this: resolveBattleTx and verifyBattle always go to the ledger.
const _cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.val;
  const val = await fn();
  if (_cache.size > 500) _cache.clear();          // crude bound; these are all cheap to rebuild
  _cache.set(key, { at: Date.now(), val });
  return val;
}
async function readState(c, issuer, nid) {
  const r = await c.request({ command: 'account_nfts', account: issuer });
  const n = r.result.account_nfts.find(x => x.NFTokenID === nid);
  return n ? dec(n.URI) : null;
}
async function submit(c, w, tx) {
  const prepared = await c.autofill(tag(tx));
  const res = await c.submitAndWait(w.sign(prepared).tx_blob);
  return res.result.meta.TransactionResult;
}

const app = express();
// Railway terminates TLS at its edge and forwards the real scheme in x-forwarded-proto. Without
// this, req.protocol reports 'http', so the share page emitted og:image and twitter:image as
// http:// URLs — and X/Twitter, Discord and Slack all refuse to fetch card images over plain http.
// The viral loop (/p/:nid share pages) rendered link previews with no image because of it.
app.set('trust proxy', true);
app.use(express.json({ limit: '8mb' }));   // accessory submissions carry a small PNG hash + metadata
// CORS — locked to our own origin (not '*'). The canvas/demo are served from GitHub Pages.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Auth gate for all write/mint endpoints. Fail-closed: no token configured OR mismatch => rejected.
// No anonymous minting from the issuer wallet (closes the open-signing-oracle hole).
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(503).json({ error: 'minting not configured (ADMIN_TOKEN unset)' });
  if (req.header('x-admin-token') !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// adopt: mint a mutable pet dNFT owned (in-state) by the user. PUBLIC so a real player can start with one tap,
// but hardened: server builds the genesis URI (no state injection) and caps ONE living pet per owner (returns the
// existing one instead of minting again). Only /adopt is public; every other mint stays requireAdmin.
app.post('/adopt', async (req, res) => {
  const owner = req.body.owner;
  if (!owner || !xrpl.isValidClassicAddress(owner)) return res.status(400).json({ error: 'valid owner address required' });
  // Optional pet name, fixed at mint and never changed (step() copies it through untouched, so it
  // re-derives for free and any later edit by us would DIVERGE). Budget: the NFT URI is capped at
  // kMaxTokenUriLength = 256 bytes and an unnamed pet already uses ~152, so the check is on the
  // ENCODED byte length, not the character count — a quote or an emoji costs more than one byte.
  const rawName = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const petName = rawName.slice(0, 24);
  if (petName && Buffer.byteLength(JSON.stringify(petName), 'utf8') > 64) {
    return res.status(400).json({ error: 'name too long once encoded; use fewer or simpler characters' });
  }
  if (petName && /[\u0000-\u001f\u007f]/.test(petName)) {
    return res.status(400).json({ error: 'name contains control characters' });
  }
  try {
    const out = await withClient(async (c, w) => {
      // one-living-pet-per-owner cap: return the caller's existing pet rather than minting a second
      for (const n of await allIssuerNfts(c, w.classicAddress)) {
        if (n.NFTokenTaxon !== TAXON || !n.URI) continue;
        let s; try { s = dec(n.URI); } catch { continue; }
        if (s.owner === owner && s.alive !== 0) return { existing: true, nid: n.NFTokenID, state: s };
      }
      const now = (await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index;
      const prepared = await c.autofill(tag({ TransactionType: 'NFTokenMint', Account: w.classicAddress,
        NFTokenTaxon: TAXON, Flags: TF_MUTABLE_TRANSFERABLE, TransferFee: ROYALTY_BPS, URI: enc(R.genesis(now, owner, petName)) }));
      const rr = (await c.submitAndWait(w.sign(prepared).tx_blob)).result;
      return { result: rr.meta.TransactionResult, nid: rr.meta.nftoken_id, state: R.genesis(now, owner, petName) };
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// public config — lets the frontend stamp the Make Waves SourceTag on the PLAYER's own interaction Payment
// (so distinct player accounts show on the leaderboard, not just issuer-built txns).
app.get('/config', (req, res) => {
  // pngCards reports whether THIS RUNNING BUILD can actually rasterise text, and fontFile says
  // which font it loaded. Both exist because a card that renders blank returns a perfectly valid
  // HTTP 200 PNG of the right dimensions: status, content-type, magic bytes and size all pass while
  // the image is empty. There was also no way to tell a stale deploy from a live-but-broken one,
  // since the fix changed no HTTP surface. Now one request answers both questions.
  res.json({ sourceTag: SOURCE_TAG !== undefined ? SOURCE_TAG : null, taxon: TAXON, rulesetVersion: RULESET_VERSION,
    pngCards: pngStatus(), fontFile: FONT_FILE, fontMode: FONT_MODE,
    // Which care-award rule THIS build enforces. The fork changes no behaviour until its ledger
    // arrives, so without this there is no way to tell a deployed fix from an undeployed one — and
    // the gap is the whole risk: if the server is still writing awards under the old rule after the
    // fork ledger passes, a verifier running the new rule will report DIVERGED on that history.
    careFork: R.CARE_FORK });
});

// current validated ledger — the frontend uses this as `now` for LIVE pets (real ledger indices) so it can
// gray-out feed/play while on cooldown (no wasted signature on a step() no-op).
app.get('/now', async (req, res) => {
  try { const l = (await withClient((c) => c.request({ command: 'ledger', ledger_index: 'validated' }))).result.ledger_index; res.json({ ledger: l }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// read pet state
app.get('/pet/:nid', async (req, res) => {
  const s = await withClient((c, w) => readState(c, w.classicAddress, req.params.nid));
  s ? res.json(s) : res.status(404).json({ error: 'pet not found' });
});

// replay the OPEN rules from genesis over the pet's on-ledger interaction history
function replay(genesis, interactions) {
  let s = genesis;
  for (const [op, now, sender] of interactions) s = R.step(s, op, now, sender);
  return s;
}

// verify a pet: re-derive it from its on-ledger history and compare to the on-chain state.
// Multi-pet-sound: genesis = the mint whose meta.nftoken_id == nid; interactions = Payments memo'd
// "<op>|<nid>" for THIS nid (so other pets' interactions are not mixed in). `now` per interaction =
// the Payment's ledger_index (deterministic — the verifiability fix).
// Pull a pet's full on-ledger history: genesis mint URI + all interaction Payments (memo'd "<op>|<nid>"
// for THIS nid), each with its Payment ledger_index (= the deterministic `now`). Shared by the pet
// verifier AND the achievements projection so both replay the exact same inputs.
async function loadHistory(c, issuer, nid) {
  const current = await readState(c, issuer, nid);
  // Bound the scan to the pet's own lifetime: its genesis mint is at ledger `birth` and every interaction is
  // after it, so ledger_index_min = birth guarantees we never miss genesis AND never truncate history — the
  // arbitrary count cap is gone (it silently caused false NO_GENESIS/DIVERGED as issuer volume grew). This also
  // avoids re-scanning the issuer's entire history for every verify/reconcile. (Optimization for extreme scale:
  // maintain a per-nid tx index; for hackathon volume the birth-bounded window is fine.)
  const minLedger = current && Number.isInteger(current.birth) ? current.birth : null;
  let genesis = null; const interactions = [];
  let marker;
  do {
    const req = { command: 'account_tx', account: issuer, limit: 200, forward: true, marker };
    if (minLedger != null) req.ledger_index_min = minLedger;
    const r = await c.request(req);
    for (const t of r.result.transactions) {
      const tx = t.tx || t.tx_json || {};
      const lseq = tx.ledger_index || t.ledger_index;
      if (tx.TransactionType === 'NFTokenMint' && tx.URI && t.meta && t.meta.nftoken_id === nid) {
        try { genesis = dec(tx.URI); } catch { /* not our genesis */ }
      } else if (tx.TransactionType === 'Payment' && tx.Destination === issuer) {
        for (const m of (tx.Memos || [])) {
          const md = m.Memo || {};
          try {
            if (unhex(md.MemoType || '') === 'ledgerlings/op') {
              const [opName, mNid] = unhex(md.MemoData || '').split('|');
              if (mNid === nid) interactions.push([R.OP[opName] || 0, lseq, tx.Account]);
            }
          } catch { /* skip malformed memo */ }
        }
      }
    }
    marker = r.result.marker;
  } while (marker);
  interactions.sort((a, b) => a[1] - b[1]);
  return { current, genesis, interactions };
}

// verify a pet: re-derive it from its on-ledger history and compare to the on-chain state.
async function verifyPet(c, issuer, nid) {
  const { current, genesis, interactions } = await loadHistory(c, issuer, nid);
  if (!current) return { ok: false, verdict: 'NOT_FOUND', reason: 'pet not found at issuer' };
  if (!genesis) return { ok: false, verdict: 'NO_GENESIS', reason: 'no mint URI found for this nid' };
  const derived = replay(genesis, interactions);
  const ok = enc(derived) === enc(current);   // reproduce the exact stored bytes
  return { ok, verdict: ok ? 'PASS' : 'DIVERGED', nid, interactions: interactions.length,
    derived, current,     // both states, so the UI can show the field-level match + a live "rig it" demo
    reason: ok ? 'on-ledger state matches a faithful replay of the open rules'
               : 'on-ledger state does NOT match the open rules — the operator deviated' };
}

// ---- Achievements (Make Waves #11): badges = a pure projection of the same replay ----
// Compact soulbound-badge codec (hex(JSON) <= 256 bytes, same cap as pets). Full pet nid kept so the
// badge is independently replayable; owner is looked up from the pet, not duplicated.
function encAch(nid, achId, earnedLedger, meta) {
  const o = { t: 'ach', p: nid, i: achId, L: earnedLedger, rv: RULESET_VERSION };
  if (meta && meta.form) o.fm = meta.form;
  let h = hex(JSON.stringify(o));
  if (h.length > 256) { delete o.rv; h = hex(JSON.stringify(o)); }   // shed rv first if oversized (keep pet+id+ledger)
  return h;
}
function decAch(uri) { try { const o = JSON.parse(unhex(uri)); return o && o.t === 'ach' ? o : null; } catch { return null; } }

// all NFTs held by an account (paginated) — badges can accumulate past one page.
async function allIssuerNfts(c, issuer) {
  const out = []; let marker;
  do {
    const r = await c.request({ command: 'account_nfts', account: issuer, limit: 400, marker });
    out.push(...r.result.account_nfts); marker = r.result.marker;
  } while (marker);
  return out;
}
// minted badges (optionally filtered to one pet nid)
async function listAchievements(c, issuer, nid) {
  return (await allIssuerNfts(c, issuer))
    .filter(n => n.NFTokenTaxon === ACHIEVEMENT_TAXON && n.URI)
    .map(n => { const o = decAch(n.URI); return o ? { achNid: n.NFTokenID, ...o } : null; })
    .filter(Boolean)
    .filter(b => !nid || b.p === nid);
}
// mint any newly-earned, not-yet-minted badges for a pet. Idempotent (skips (pet, achId) already on-ledger).
async function claimAchievements(c, w, nid, only) {
  const issuer = w.classicAddress;
  const { genesis, interactions } = await loadHistory(c, issuer, nid);
  if (!genesis) return { minted: [], skipped: [], reason: 'no genesis for nid' };
  const earned = A.achievementsFor(genesis, interactions).filter(e => !only || e.id === only);
  const haveIds = new Set((await listAchievements(c, issuer, nid)).map(b => b.i));
  const minted = [], skipped = [];
  for (const e of earned) {
    if (haveIds.has(e.id)) { skipped.push(e.id); continue; }
    const prepared = await c.autofill(tag({ TransactionType: 'NFTokenMint', Account: issuer,
      NFTokenTaxon: ACHIEVEMENT_TAXON, Flags: 0 /* soulbound: non-transferable, no royalty */,
      URI: encAch(nid, e.id, e.earnedLedger, e.meta) }));
    const r = (await c.submitAndWait(w.sign(prepared).tx_blob)).result;
    minted.push({ id: e.id, earnedLedger: e.earnedLedger, result: r.meta.TransactionResult, achNid: r.meta.nftoken_id });
  }
  return { minted, skipped, earnedCount: earned.length };
}
// verify a badge: re-derive its pet from on-ledger history and assert the badge was earned at the claimed ledger.
async function verifyAchievement(c, issuer, achNid) {
  const badge = (await allIssuerNfts(c, issuer)).find(n => n.NFTokenID === achNid);
  if (!badge) return { ok: false, verdict: 'NOT_FOUND', reason: 'badge not held by issuer' };
  const o = badge.URI && decAch(badge.URI);
  if (!o) return { ok: false, verdict: 'NOT_ACHIEVEMENT', reason: 'not a Ledgerlings badge' };
  const { genesis, interactions } = await loadHistory(c, issuer, o.p);
  if (!genesis) return { ok: false, verdict: 'NO_GENESIS', reason: 'pet for this badge not found' };
  const match = A.achievementsFor(genesis, interactions).find(e => e.id === o.i);
  const ok = Boolean(match) && match.earnedLedger === o.L;
  return { ok, verdict: ok ? 'PASS' : 'FAIL', achNid, pet: o.p, achId: o.i, claimedLedger: o.L,
    derivedLedger: match ? match.earnedLedger : null,
    reason: ok ? 'badge re-derives from the open rules at the claimed ledger'
      : match ? 'earnedLedger mismatch — badge does not match a faithful replay'
              : 'this pet never earned this badge under the open rules' };
}

/* Re-derive a pet from ledger history.
 *
 * Answered by the quorum engine: a validated ledger that several independent nodes agree on, history
 * read from all of them, and a refusal to answer if they disagree. The response keeps the original
 * shape (verdict / derived / current / interactions) so existing clients are unaffected, and adds the
 * evidence a third party needs to reproduce the result — the pinned ledger, which endpoints agreed,
 * the transaction digest, and a bundle hash.
 *
 * Falls back to the single-node verifier only if the quorum cannot be formed (endpoints unreachable),
 * and says so in the response rather than silently downgrading.
 */
app.get('/verify/:nid', async (req, res) => {
  const nid = req.params.nid;
  // Same resolution withClient uses: act as ISSUER_ADDRESS when a RegularKey is configured,
  // otherwise the signing wallet's own account.
  const issuer = ISSUER_ADDRESS || walletFromSeed(ISSUER_SEED).classicAddress;
  try {
    const b = await verifyPetQuorum(issuer, nid);
    return res.json({
      ok: b.verdict === 'MATCH',
      verdict: b.verdict === 'MATCH' ? 'PASS' : b.verdict,
      nid,
      interactions: (b.meta && b.meta.reducer && b.meta.reducer.interactions) ?? 0,
      derived: b.derived,
      current: b.claimed,
      divergence: b.divergence,
      evidence: {
        method: 'quorum',
        ledger_index: b.pin.ledger_index,
        ledger_hash: b.pin.ledger_hash,
        nodes_agreed: b.pin.agreed_by.length,
        endpoints: b.pin.agreed_by,
        history_digest: b.history.digest,
        transactions: b.history.count,
        reducer: b.reducer,
        bundle_hash: b.bundle_hash,
      },
    });
  } catch (e) {
    // A disagreement between nodes is a real signal, not a transport hiccup — never fall back on it.
    if (e.fatal) {
      return res.status(409).json({ ok: false, verdict: 'ENDPOINTS_DISAGREE',
        reason: e.message, detail: e.detail || null });
    }
    try {
      const out = await withClient((c, w) => verifyPet(c, w.classicAddress, nid));
      return res.json({ ...out, evidence: { method: 'single-node',
        note: 'quorum unavailable, verified against one endpoint only', reason: e.message } });
    } catch (e2) {
      return res.status(500).json({ ok: false, verdict: 'ERROR', reason: e2.message });
    }
  }
});

// claim: mint any newly-earned badges for a pet (admin, idempotent). Optional body.achId limits to one.
app.post('/claim-achievement', requireAdmin, async (req, res) => {
  const { nid, achId } = req.body || {};
  if (!nid) return res.status(400).json({ error: 'nid required' });
  try { res.json(await withClient((c, w) => claimAchievements(c, w, nid, achId))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// list a pet's minted badges + the full catalog (public).
app.get('/achievements/:nid', async (req, res) => {
  try {
    const badges = await withClient((c, w) => listAchievements(c, w.classicAddress, req.params.nid));
    res.json({ nid: req.params.nid, badges,
      catalog: A.CATALOG.map(a => ({ id: a.id, label: a.label, desc: a.desc })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// verify a badge: re-derive it from the pet's on-ledger history (public — the fairness proof).
app.get('/verify-achievement/:achNid', async (req, res) => {
  try { res.json(await withClient((c, w) => verifyAchievement(c, w.classicAddress, req.params.achNid))); }
  catch (e) { res.status(500).json({ ok: false, verdict: 'ERROR', reason: e.message }); }
});

// ---- Provably-fair battles (Make Waves #10) ----
// Seed = SHA-256(ledgerHash(N) | battleId | aNid | bNid). N is pinned in the future at challenge time, so its
// hash is unknowable to anyone until it closes => unbiasable, yet re-derivable by anyone. (Same idea as `now`.)
function seedFor(ledgerHash, battleId, aNid, bNid) {
  return crypto.createHash('sha256').update([ledgerHash, battleId, aNid, bNid].join('|')).digest('hex');
}
// pet state AS OF ledger N = replay only the interactions up to N (so the result is fixed + re-derivable).
function stateAtLedger(genesis, interactions, N) {
  return replay(genesis, interactions.filter(([, lseq]) => lseq <= N));
}
// Advance a replayed state to ledger N with no action, so decay and any resulting death are applied.
// replay() stops at the last interaction; a pet nobody has touched therefore reads at full strength
// forever, which is why an untouched pet's death never lands on-chain. Used by ghost fights so an
// opponent snapshot reflects the pet as it actually is. Deterministic: same inputs, same output,
// and the public verifier runs the identical call.
function projectTo(s, N) {
  if (!s || !s.owner) return s;
  try { return R.step(s, null, Number(N), s.owner); } catch { return s; }
}
async function ledgerHashOf(c, N) {
  const r = await c.request({ command: 'ledger', ledger_index: Number(N) });
  return (r.result.ledger && r.result.ledger.ledger_hash) || r.result.ledger_hash || null;
}
// a battle lives entirely in memo'd Payments on the issuer: challenge (tx hash = battleId), accept(s),
// refund legs, result.
//
// EVERY memo here is attacker-writable. The format is public, and a 1-drop Payment to the issuer
// carrying one needs none of our endpoints — so the guards in the payload BUILDERS (/battle/accept,
// /sign) are advice to honest clients, not enforcement. This parser is where authority is decided:
//
//   · SETTLEMENT IS ISSUER-ONLY. A `result` or `refund` memo counts only when the ISSUER signed it
//     (tx.Account === issuer). Anyone could otherwise send a forged `result|<battleId>|…` and freeze
//     the pot behind the ALREADY_RESOLVED short-circuit — the winner never paid — while flipping the
//     public /verify-battle to FAIL on a fight that was in fact fair.
//   · COMMITMENTS MUST BE DELIVERED TO THE ISSUER (tx.Destination === issuer): the Payment IS the stake.
//   · FIRST COMMITMENT WINS. Accepts are collected in ledger order and a later one is INERT. Under
//     last-write-wins the seed ledger (accept.lseq + margin) moved with every new accept memo, so a
//     party who read the outcome after ledger N closed could re-roll the dice for a drop, repeatedly,
//     and could also swap b.accept.ownerB — the VOID branch refunds THAT address — to walk off with
//     the honest acceptor's stake. Both die here.
//   · tec IS NOT SUCCESS. A tec'd Payment is recorded in the ledger with its memos intact but moves
//     nothing. Counting one as a commitment, a refund or a settlement is how a battle became
//     permanently ALREADY_RESOLVED with the money still sitting at the issuer.
async function loadBattle(c, issuer, battleId) {
  const out = { battleId, challenge: null, accept: null, accepts: [], refunds: {}, result: null };
  let marker;   // full pagination (no count cap) — battles are low-frequency; correctness over a bounded scan
  do {
    const r = await c.request({ command: 'account_tx', account: issuer, limit: 200, forward: true, marker });
    for (const t of r.result.transactions) {
      const tx = t.tx || t.tx_json || {}; if (tx.TransactionType !== 'Payment') continue;
      if (!t.meta || t.meta.TransactionResult !== 'tesSUCCESS') continue;   // tec'd: in the ledger, moved nothing
      const hash = tx.hash || t.hash || ''; const lseq = tx.ledger_index || t.ledger_index;
      const toIssuer = tx.Destination === issuer, byIssuer = tx.Account === issuer;
      for (const m of (tx.Memos || [])) {
        const md = m.Memo || {};
        try {
          if (unhex(md.MemoType || '') !== BATTLE_MEMO) continue;
          const f = unhex(md.MemoData || '').split('|'), kind = f[0];
          if (kind === 'challenge' && hash === battleId && toIssuer && !out.challenge) out.challenge = { aNid: f[1], stakeDrops: f[2], N: Number(f[3]), ownerA: tx.Account, delivered: (t.meta && t.meta.delivered_amount) || tx.Amount, lseq };
          else if (kind === 'ladder' && hash === battleId && toIssuer && !out.challenge) out.challenge = { aNid: f[1], rung: Number(f[2]), N: Number(f[3]), ownerA: tx.Account, npc: true, lseq };
          // GHOST: fight a SNAPSHOT of another player's pet. Structurally this is a ladder fight
          // whose opponent stats come from a real pet's derived state instead of the NPC table, so
          // it has exactly ONE commitment and needs no second human. The accept-derived seed rule
          // exists only to stop a second mover peeking at the dice; with no second mover there is
          // nothing to peek at, which is why this reuses the ladder's already-verified seeding.
          else if (kind === 'ghost' && hash === battleId && toIssuer && !out.challenge) out.challenge = { aNid: f[1], ghostNid: f[2], N: Number(f[3]), ownerA: tx.Account, ghost: true, lseq };
          else if (kind === 'accept' && f[1] === battleId && toIssuer) out.accepts.push({ bNid: f[2], ownerB: tx.Account, delivered: (t.meta && t.meta.delivered_amount) || tx.Amount, lseq, hash });
          else if (kind === 'result' && f[1] === battleId && byIssuer && !out.result) out.result = { winnerNid: f[2], scoreA: Number(f[3]), scoreB: Number(f[4]), rv: f[5], dest: tx.Destination, lseq };
          else if (kind === 'refund' && f[1] === battleId && byIssuer && (f[2] === 'A' || f[2] === 'B')) out.refunds[f[2]] = { dest: tx.Destination, drops: (t.meta && t.meta.delivered_amount) || tx.Amount, lseq };
        } catch { /* skip malformed memo */ }
      }
    }
    marker = r.result.marker;
  } while (marker);
  out.accepts.sort((a, b) => (a.lseq - b.lseq) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  // Cheap, network-free pick: the first WELL-FORMED accept. pickAccept() below refines this with the
  // ownership test (which costs a history read) and is what every money and verification path uses.
  out.accept = out.accepts.find(a => acceptWellFormed(out.challenge, a)) || null;
  return out;
}
// Is this accept memo a real commitment to THIS challenge? Every test is a function of ledger data
// alone — no server state — so /verify-battle reaches the same answer any third party does.
function acceptWellFormed(ch, a) {
  if (!ch || ch.npc) return false;                                          // a ladder battle has no second party
  if (!a.bNid || a.bNid === ch.aNid) return false;                          // a pet cannot fight itself: identical
                                                                            // state means scoreA === scoreB, the
                                                                            // tiebreak hands nidA a certain win, and
                                                                            // the board folded the one battle twice
  if (Number(a.delivered || 0) < Number(ch.stakeDrops || 0)) return false;   // the stake has to actually arrive
  // Field 4 of a PvP challenge memo is an ABSOLUTE expiry ledger (only the ladder branch writes the
  // margin form there, and a ladder challenge never reaches here). An open-ended challenge is not just
  // untidy: a pet that has PASSED forfeits (score -1), so an opponent could sit on a public battleId,
  // wait for the challenger's pet to die of neglect, and then accept for a certain win.
  //
  // The cutoff carries one margin of grace. Both accept builders check the expiry against the CURRENT
  // ledger and the signed transaction lands a ledger or two later, and POST /battle/challenge pins N
  // only BATTLE_LEDGER_MARGIN ahead — so an exact cutoff would reject accepts our own endpoint had just
  // told the player were in time, and strand the challenge with no refund path.
  if (Number.isInteger(ch.N) && ch.N > 1000000 && Number(a.lseq) > ch.N + BATTLE_LEDGER_MARGIN) return false;
  return true;
}
// The accept that decides the fight: the first well-formed one whose SENDER OWNS the pet it nominates.
// Owner is read from that pet's replayed history at the accept's own ledger — fixed, public, and it
// dodges the circularity of needing the seed ledger (which this choice determines) to make the choice.
// Without it a griefer conscripts a stranger's pet into a fight it never agreed to, and the loss lands
// on that pet's public record. Returns the loaded history so the caller does not pay for it twice.
async function pickAccept(c, issuer, b) {
  if (!b || !b.challenge || b.challenge.npc) return null;
  for (const a of b.accepts) {
    if (!acceptWellFormed(b.challenge, a)) continue;
    const h = await loadHistory(c, issuer, a.bNid);
    if (!h.genesis) continue;                                                     // nominated a pet that does not exist
    if (stateAtLedger(h.genesis, h.interactions, a.lseq).owner !== a.ownerB) continue;   // not their pet
    return { accept: a, history: h };
  }
  return null;
}
// resolve (admin, idempotent): re-derive the winner from the pinned ledger hash + open rules, pay the winner, mint a card.
// ladder (vs a published house NPC): no accept, no wager. Free, provably fair, solo-climbable.
async function resolveLadder(c, w, battleId, b) {
  const issuer = w.classicAddress;
  const { aNid, rung, ownerA, lseq } = b.challenge;
  const npc = LADDER[rung];
  if (!npc) return { error: 'invalid ladder rung', rung };

  // SEED LEDGER IS DERIVED, NOT TAKEN FROM THE MEMO.
  //
  // /sign pins N = current + margin when the PAYLOAD IS BUILT, but the player signs whenever they
  // get round to it. On 2026-07-30 a real challenge was built pinning 105955044 and landed in
  // 105955051, so the "unknowable future ledger" had already closed seven ledgers before the
  // challenge was even recorded. Its hash was public at the moment of commitment, and the whole
  // unriggability claim evaporates: a player who waits can read the seed before deciding to sign.
  //
  // Deriving the seed ledger from the ledger the challenge LANDED in fixes that by construction. It
  // is strictly in the future relative to the commitment no matter how long the player takes, and it
  // is still fully public and re-derivable by anyone reading the challenge transaction.
  //
  // The memo's N is kept only to detect the stale case and say so.
  const claimedN = b.challenge.N;
  if (!lseq) return { error: 'challenge ledger unknown', battleId };
  const N = lseq + BATTLE_LEDGER_MARGIN;
  // Older challenges wrote an absolute ledger index here; new ones write the margin. Only an
  // absolute-looking value that predates the landing ledger indicates a commitment that was
  // already knowable when signed.
  const staleCommitment = Number.isInteger(claimedN) && claimedN > 1000000 && claimedN <= lseq;

  const lh = await ledgerHashOf(c, N);
  if (!lh) return { error: 'pinned ledger not validated yet', N };
  const npcId = 'NPC:' + npc.id;
  const seed = seedFor(lh, battleId, aNid, npcId);
  const h = await loadHistory(c, issuer, aNid);
  if (!h.genesis) return { error: 'pet not found' };
  const sA = stateAtLedger(h.genesis, h.interactions, N);
  const d = BR.resolveBattle(seed, sA, npc.stats, aNid, npcId);
  const winnerNid = d.winner === null ? 'DRAW' : d.winner, playerWon = d.winner === aNid;
  const resultMemo = [{ Memo: { MemoType: hex(BATTLE_MEMO), MemoData: hex(['result', battleId, winnerNid, d.scoreA, d.scoreB, RULESET_VERSION].join('|')) } }];
  const rr = await submit(c, w, { TransactionType: 'Payment', Account: issuer, Destination: ownerA, Amount: '1', Memos: resultMemo });   // 1-drop carries the result
  // A tec'd payment is in the ledger with its memo intact but moved nothing, and loadBattle ignores it,
  // so the battle stays unresolved. Say so rather than reporting a settlement that did not happen.
  if (rr !== 'tesSUCCESS') return { error: 'result payment did not succeed', result: rr, battleId, ladder: true };
  let card;
  if (playerWon) { try {
    const cp = await c.autofill(tag({ TransactionType: 'NFTokenMint', Account: issuer, NFTokenTaxon: BATTLE_TAXON, Flags: 0,
      URI: hex(JSON.stringify({ t: 'btl', i: battleId.slice(0, 32), w: aNid.slice(0, 24), N, npc: npc.id })) }));
    const cr = (await c.submitAndWait(w.sign(cp).tx_blob)).result; card = { nid: cr.meta.nftoken_id, result: cr.meta.TransactionResult };
  } catch (e) { card = { error: e.message }; } }
  return { battleId, ladder: true, opponent: npc.name, rung, winner: playerWon ? 'player' : (d.winner === null ? 'DRAW' : 'NPC'),
    scoreA: d.scoreA, scoreB: d.scoreB, rollA: d.rollA, rollB: d.rollB, powerA: d.powerA, powerB: d.powerB,
    seed, seedLedger: N, challengeLedger: lseq, claimedN,
    staleCommitment: staleCommitment || undefined,   // the memo pinned a ledger that had already closed
    card };
}

// Refund both sides, then write the settlement record LAST.
//
// The VOID and DRAW branches used to attach the result memo to the FIRST of two separate payments and
// discard every TransactionResult. Once that first one validated the battle was ALREADY_RESOLVED
// forever, so a tec on the second refund (a destination with lsfRequireDestTag or lsfDepositAuth, the
// issuer short of reserve, or simply the process dying between the two submits) left the counterparty
// permanently unpaid, reported as success, and never retried by the poller.
//
// Now each leg carries its own `refund|<battleId>|A|B` memo, so a leg that already landed is skipped on
// a retry (per-leg idempotence — no double refund), and the `result` memo is only written once BOTH
// legs are on the ledger. No result memo means the battle is still unresolved, which is exactly what a
// retry needs to be safe.
async function refundBoth(c, w, battleId, b, deliveredA, deliveredB, resultMemo) {
  const issuer = w.classicAddress;
  const legs = [];
  if (deliveredA > 0 && !b.refunds.A) legs.push(['A', b.challenge.ownerA, deliveredA]);
  if (deliveredB > 0 && !b.refunds.B) legs.push(['B', b.accept.ownerB, deliveredB]);
  const refunds = { ...b.refunds }, failed = [];
  for (const [leg, dest, drops] of legs) {
    const rr = await submit(c, w, { TransactionType: 'Payment', Account: issuer, Destination: dest, Amount: String(Math.max(1, drops)),
      Memos: [{ Memo: { MemoType: hex(BATTLE_MEMO), MemoData: hex(['refund', battleId, leg].join('|')) } }] });
    if (rr === 'tesSUCCESS') refunds[leg] = { dest, drops: String(Math.max(1, drops)) };
    else failed.push({ leg, dest, drops, result: rr });
  }
  if (failed.length) {
    console.warn(`[battle] ${battleId.slice(0, 8)} refund leg(s) failed:`, JSON.stringify(failed));
    return { error: 'refund did not succeed — battle left UNRESOLVED so it can be retried safely', failed, refunds };
  }
  // 1 drop to the challenger carries the record. Issuer-signed, so loadBattle will count it.
  const rr = await submit(c, w, { TransactionType: 'Payment', Account: issuer, Destination: b.challenge.ownerA, Amount: '1', Memos: resultMemo });
  if (rr !== 'tesSUCCESS') return { error: 'refunds landed but the result memo did not — retry is safe (legs are skipped)', failed: [{ leg: 'result', result: rr }], refunds };
  return { refunds };
}

// GHOST FIGHT. The challenger fights a SNAPSHOT of another player's pet, derived from that pet's
// real ledger history at the seed ledger. One commitment, no second human, and no wallet round-trip
// from the ghost's owner — which is the whole point, because pvpPlayed sat at 0 while every pet
// waiting to be challenged belonged to somebody who had stopped signing anything.
//
// Fairness is inherited from the ladder rather than argued from scratch: the seed ledger is derived
// from the ledger the challenge LANDED in, so it is strictly in the future at the only commitment
// there is. There is no second mover, so there is nobody who could have peeked at the dice.
//
// The ghost's record is never touched. See the leaderboard fold: a ghost battle credits only the
// challenger. Their owner did not agree to fight and must not carry a loss for it.
async function resolveGhost(c, w, battleId, b) {
  const issuer = w.classicAddress;
  const { aNid, ghostNid, ownerA, lseq } = b.challenge;
  if (!ghostNid || !/^[0-9A-F]{64}$/i.test(ghostNid)) return { error: 'bad ghost id', battleId };
  if (ghostNid === aNid) return { error: 'a pet cannot fight its own ghost', battleId };
  if (!lseq) return { error: 'challenge ledger unknown', battleId };

  const claimedN = b.challenge.N;
  const N = lseq + BATTLE_LEDGER_MARGIN;
  const staleCommitment = Number.isInteger(claimedN) && claimedN > 1000000 && claimedN <= lseq;
  const lh = await ledgerHashOf(c, N);
  if (!lh) return { error: 'pinned ledger not validated yet', N };

  const hA = await loadHistory(c, issuer, aNid);
  if (!hA.genesis) return { error: 'pet not found' };
  const hG = await loadHistory(c, issuer, ghostNid);
  if (!hG.genesis) return { error: 'ghost not found' };
  // PROJECTED, not merely replayed. stateAtLedger replays interactions up to N and stops, so a pet
  // with no interactions since ledger X is evaluated at its strength AT X — full stats, alive,
  // forever. For a ghost that is exactly backwards: the seven abandoned pets in this game would
  // become permanently strong opponents, and a pet that starved to death would still fight, because
  // decay and death only commit inside step() when an owner transacts.
  //
  // Projecting with a null op applies the same decay the client already shows, so a ghost fights as
  // it ACTUALLY IS at the seed ledger. It stays fully deterministic and re-derivable — the verifier
  // does the identical projection — and it is scoped to ghost fights only, so ladder and PvP
  // semantics are untouched.
  const sA = projectTo(stateAtLedger(hA.genesis, hA.interactions, N), N);
  const sG = projectTo(stateAtLedger(hG.genesis, hG.interactions, N), N);

  // Same owner on both sides would let one person farm wins against themselves, and the board is
  // what the ranking is read from. Checked at resolution, not only at /sign, because a raw Payment
  // carrying a ghost memo bypasses /sign entirely.
  if (sA.owner && sG.owner && sA.owner === sG.owner) return { error: 'cannot fight your own pet', battleId };

  // A dead pet forfeits under battle_rules, so an unguarded ghost fight against a neglected pet is a
  // free win farm — and half this game's pets are dying unattended. VOID instead: nothing is scored,
  // and the result is still on-ledger and re-derivable so the verifier can confirm the refusal.
  if (sG.alive === 0) {
    const voidMemo = [{ Memo: { MemoType: hex(BATTLE_MEMO), MemoData: hex(['result', battleId, 'VOID', 0, 0, RULESET_VERSION].join('|')) } }];
    const vr = await submit(c, w, { TransactionType: 'Payment', Account: issuer, Destination: ownerA, Amount: '1', Memos: voidMemo });
    if (vr !== 'tesSUCCESS') return { error: 'void payment did not succeed', result: vr, battleId };
    return { battleId, ghost: true, status: 'VOID', reason: 'the ghost had already passed; nothing was scored' };
  }

  const seed = seedFor(lh, battleId, aNid, ghostNid);
  const d = BR.resolveBattle(seed, sA, sG, aNid, ghostNid);
  const winnerNid = d.winner === null ? 'DRAW' : d.winner, playerWon = d.winner === aNid;
  const resultMemo = [{ Memo: { MemoType: hex(BATTLE_MEMO), MemoData: hex(['result', battleId, winnerNid, d.scoreA, d.scoreB, RULESET_VERSION].join('|')) } }];
  const rr = await submit(c, w, { TransactionType: 'Payment', Account: issuer, Destination: ownerA, Amount: '1', Memos: resultMemo });
  if (rr !== 'tesSUCCESS') return { error: 'result payment did not succeed', result: rr, battleId, ghost: true };

  let card;
  if (playerWon) { try {
    const cp = await c.autofill(tag({ TransactionType: 'NFTokenMint', Account: issuer, NFTokenTaxon: BATTLE_TAXON, Flags: 0,
      URI: hex(JSON.stringify({ t: 'btl', i: battleId.slice(0, 32), w: aNid.slice(0, 24), N, g: ghostNid.slice(0, 24) })) }));
    const cs = await c.submitAndWait(cp, { wallet: w });
    if (cs.result.meta.TransactionResult === 'tesSUCCESS') card = cs.result.hash;
  } catch (e) { console.warn('[ghost] card mint failed', e.message); } }

  return { battleId, ghost: true, winner: winnerNid, ghostNid, scoreA: d.scoreA, scoreB: d.scoreB,
    rollA: d.rollA, rollB: d.rollB, powerA: d.powerA, powerB: d.powerB,
    seedLedger: N, challengeLedger: lseq, seed, card,
    staleCommitment: staleCommitment || undefined };
}

async function resolveBattleTx(c, w, battleId) {
  const issuer = w.classicAddress;
  const b = await loadBattle(c, issuer, battleId);
  if (!b.challenge) return { error: 'battle not found', battleId };
  if (b.result) return { status: 'ALREADY_RESOLVED', result: b.result };     // idempotent — never double-pay
  if (b.challenge.npc) return resolveLadder(c, w, battleId, b);               // ladder path (no accept/wager)
  if (b.challenge.ghost) return resolveGhost(c, w, battleId, b);              // ghost path (no accept, no second human)
  // The FIRST valid accept and nothing else. Later accept memos are inert (see loadBattle): the seed
  // ledger is derived from this one, so a movable accept is a re-rollable dice.
  const picked = await pickAccept(c, issuer, b);
  if (!picked) return { status: 'OPEN', error: 'not accepted yet',
    ...(b.accepts.length ? { ignoredAccepts: b.accepts.length, reason: 'accept memo(s) exist but none is a valid commitment (self-battle, unowned pet, underpaid stake or past the expiry)' } : {}) };
  b.accept = picked.accept;
  const { aNid } = b.challenge, { bNid } = b.accept;
  // Seed ledger is derived from the ACCEPT's landing ledger, not from the challenge memo.
  //
  // The ladder path got this fix on 2026-07-30; this one did not, and it is worse here. PvP has TWO
  // commitments, challenge then accept, and the memo pins N at the FIRST. BATTLE_LEDGER_MARGIN is
  // small, so ledger N closes a minute or two after the challenge lands. The acceptor chooses when
  // to accept. Any acceptor acting after that could read ledger N's hash, compute the winner, and
  // only accept when they win — and this path moves real staked XRP.
  //
  // Counting from the accept means the seed is unknowable at the time of the LAST commitment,
  // however slow either party is. The memo's N is kept only to flag the stale case and say so.
  const claimedN = b.challenge.N;
  const acceptLseq = b.accept.lseq;
  if (!acceptLseq) return { error: 'accept ledger unknown', battleId };
  const N = acceptLseq + BATTLE_LEDGER_MARGIN;
  const staleCommitment = Number.isInteger(claimedN) && claimedN > 1000000 && claimedN <= acceptLseq;
  const lh = await ledgerHashOf(c, N);
  if (!lh) return { error: 'pinned ledger not validated yet', N };
  const seed = seedFor(lh, battleId, aNid, bNid);
  const hA = await loadHistory(c, issuer, aNid), hB = picked.history;   // pickAccept already read B's history
  if (!hA.genesis || !hB.genesis) return { error: 'a pet in this battle was not found' };
  const sA = stateAtLedger(hA.genesis, hA.interactions, N), sB = stateAtLedger(hB.genesis, hB.interactions, N);
  const d = BR.resolveBattle(seed, sA, sB, aNid, bNid);
  // Custody guard (mainnet-safe): pot = what ACTUALLY arrived (meta.delivered_amount), not the memo. If either
  // side delivered less than the agreed stake, VOID the battle and refund the actual amounts — no one can win the
  // counterpart's real XRP by under-delivering their own stake.
  const stake = Number(b.challenge.stakeDrops || 0);
  const deliveredA = Number(b.challenge.delivered || 0), deliveredB = Number(b.accept.delivered || 0);
  const winnerNid = d.winner === null ? 'DRAW' : d.winner;
  const pot = deliveredA + deliveredB;
  const fee = Math.floor(pot * BATTLE_FEE_BPS / 10000);
  const memoFor = wn => [{ Memo: { MemoType: hex(BATTLE_MEMO), MemoData: hex(['result', battleId, wn,
    wn === 'VOID' ? 0 : d.scoreA, wn === 'VOID' ? 0 : d.scoreB, RULESET_VERSION].join('|')) } }];
  if (deliveredA < stake || deliveredB < stake) {
    const r = await refundBoth(c, w, battleId, b, deliveredA, deliveredB, memoFor('VOID'));
    if (r.error) return { battleId, status: 'REFUND_FAILED', ...r, stake, deliveredA, deliveredB };
    return { battleId, status: 'VOID', reason: 'stake underpaid — refunded actual amounts', stake, deliveredA, deliveredB, refunds: r.refunds };
  }
  let payout;
  if (d.winner === null) {                                                    // draw → refund both, then record
    const r = await refundBoth(c, w, battleId, b, deliveredA, deliveredB, memoFor('DRAW'));
    if (r.error) return { battleId, status: 'REFUND_FAILED', ...r, pot };
    payout = { winner: 'DRAW', refunded: true, refunds: r.refunds };
  } else {
    const winnerOwner = d.winner === aNid ? sA.owner : sB.owner;
    const amount = String(Math.max(1, pot - fee));
    // The result memo rides the payout itself, so the settlement record and the money are one atomic
    // transaction: if it fails there is no memo, the battle is not ALREADY_RESOLVED, and a retry pays
    // exactly once. (loadBattle ignores non-tesSUCCESS, which is what makes that true.)
    const rr = await submit(c, w, { TransactionType: 'Payment', Account: issuer, Destination: winnerOwner, Amount: amount, Memos: memoFor(winnerNid) });
    if (rr !== 'tesSUCCESS') return { battleId, status: 'PAYOUT_FAILED', error: 'payout did not succeed', result: rr, winnerOwner, amount };
    payout = { winner: winnerNid, winnerOwner, paidDrops: amount, feeDrops: fee, result: rr };
  }
  let card;                                                                   // cosmetic soulbound "battle card" keepsake
  try {
    const cp = await c.autofill(tag({ TransactionType: 'NFTokenMint', Account: issuer, NFTokenTaxon: BATTLE_TAXON, Flags: 0,
      URI: hex(JSON.stringify({ t: 'btl', i: battleId.slice(0, 32), w: (d.winner || 'DRAW').slice(0, 24), N })) }));
    const cr = (await c.submitAndWait(w.sign(cp).tx_blob)).result;
    card = { nid: cr.meta.nftoken_id, result: cr.meta.TransactionResult };
  } catch (e) { card = { error: e.message }; }
  return { battleId, winner: winnerNid, scoreA: d.scoreA, scoreB: d.scoreB, rollA: d.rollA, rollB: d.rollB, powerA: d.powerA, powerB: d.powerB,
    seed, seedLedger: N, acceptLedger: acceptLseq, claimedN,
    staleCommitment: staleCommitment || undefined,   // memo pinned a ledger that had closed before the accept
    pot, fee, payout, card };
}
// verify (public): re-derive winner + scores from the pinned ledger + open rules; confirm the payout went to the winner.
async function verifyBattle(c, issuer, battleId) {
  const b = await loadBattle(c, issuer, battleId);
  if (!b.challenge) return { ok: false, verdict: 'NOT_FOUND', reason: 'no challenge with this id' };
  // GHOST: opponent stats are DERIVED from the ghost pet's own ledger history at the seed ledger,
  // so they are as checkable as the challenger's. Same single-commitment seeding as the ladder.
  if (b.challenge.ghost) {
    if (!b.result) return { ok: false, verdict: 'UNRESOLVED', reason: 'not resolved yet' };
    const { aNid, ghostNid, lseq } = b.challenge;
    const claimedN = b.challenge.N;
    const N = (lseq || 0) + BATTLE_LEDGER_MARGIN;
    const staleCommitment = Number.isInteger(claimedN) && claimedN > 1000000 && lseq && claimedN <= lseq;
    const lh = await ledgerHashOf(c, N);
    if (!lh) return { ok: false, verdict: 'ERROR', reason: 'pinned ledger not available' };
    const hA = await loadHistory(c, issuer, aNid), hG = await loadHistory(c, issuer, ghostNid);
    if (!hA.genesis || !hG.genesis) return { ok: false, verdict: 'ERROR', reason: 'pet history unavailable' };
    // Identical projection to resolveGhost. If these two ever diverge the verifier would report
    // FAIL on honest fights, which is the failure mode this whole project exists to avoid.
    const sA = projectTo(stateAtLedger(hA.genesis, hA.interactions, N), N);
    const sG = projectTo(stateAtLedger(hG.genesis, hG.interactions, N), N);
    // A VOID here is a POSITIVE result: it means the rules refused to score a fight against a pet
    // that had already passed. Re-derive that refusal rather than taking the issuer's word for it.
    if (b.result.winnerNid === 'VOID') {
      const legit = sG.alive === 0;
      return { ok: legit, verdict: legit ? 'VOID' : 'FAIL', battleId, ghost: true,
        reason: legit ? 'voided: the ghost had already passed at the seed ledger, so nothing was scored'
                      : 'VOID recorded but the ghost was alive at the seed ledger' };
    }
    const seed = seedFor(lh, battleId, aNid, ghostNid);
    const d = BR.resolveBattle(seed, sA, sG, aNid, ghostNid, b.result.rv);
    const derivedWinner = d.winner === null ? 'DRAW' : d.winner;
    const ok = derivedWinner === b.result.winnerNid && d.scoreA === b.result.scoreA && d.scoreB === b.result.scoreB;
    return { ok, verdict: ok ? 'PASS' : 'FAIL', battleId, ghost: true, ghostNid,
      seedLedger: N, challengeLedger: lseq, claimedN, seed,
      math: { rollA: d.rollA, powerA: d.powerA, scoreA: d.scoreA, rollB: d.rollB, powerB: d.powerB, scoreB: d.scoreB, rulesetVersion: d.rulesetVersion },
      names: { a: sA && sA.name ? sA.name : null, b: sG && sG.name ? sG.name : null },
      nids: { a: aNid, b: ghostNid },
      ...(staleCommitment ? { warning: 'STALE_COMMITMENT', warningDetail:
        `the challenge memo pinned ledger ${claimedN}, which had already closed when the challenge landed in ${lseq}.` } : {}),
      derived: { winner: derivedWinner, scoreA: d.scoreA, scoreB: d.scoreB }, recorded: b.result,
      reason: ok ? 'winner + scores re-derive from the pinned ledger hash, both pets\' own histories, and the open rules'
                 : 'recorded ghost result does not match a faithful replay' };
  }
  if (b.challenge.npc) {   // ladder: opponent stats come from the PUBLISHED NPC table (that is why it stays provably fair)
    if (!b.result) return { ok: false, verdict: 'UNRESOLVED', reason: 'not resolved yet' };
    const { aNid, rung, lseq } = b.challenge, npc = LADDER[rung];
    if (!npc) return { ok: false, verdict: 'BAD_RUNG', reason: 'invalid ladder rung' };
    // Same derivation as resolveLadder: seed ledger counted from the ledger the challenge LANDED in,
    // so it is always after the commitment. Verifying against the memo's N instead would confirm the
    // arithmetic while missing whether the seed was knowable when the player signed — which is the
    // only property that makes this fair. A verifier that cannot fail on that is not a verifier.
    const claimedN = b.challenge.N;
    const N = (lseq || 0) + BATTLE_LEDGER_MARGIN;
    const staleCommitment = Number.isInteger(claimedN) && claimedN > 1000000 && lseq && claimedN <= lseq;
    const lh = await ledgerHashOf(c, N); if (!lh) return { ok: false, verdict: 'ERROR', reason: 'pinned ledger not available' };
    const npcId = 'NPC:' + npc.id, seed = seedFor(lh, battleId, aNid, npcId);
    const h = await loadHistory(c, issuer, aNid), sA = stateAtLedger(h.genesis, h.interactions, N);
    // Re-derive under the ruleset the battle was RECORDED with, not today's. The rules are versioned
    // precisely so a later fix cannot retroactively contradict a result the verifier already
    // published; deriving a v2 battle under v3 would report DIVERGED on honest history.
    const d = BR.resolveBattle(seed, sA, npc.stats, aNid, npcId, b.result.rv), derivedWinner = d.winner === null ? 'DRAW' : d.winner;
    const ok = derivedWinner === b.result.winnerNid && d.scoreA === b.result.scoreA && d.scoreB === b.result.scoreB;
    return { ok, verdict: ok ? 'PASS' : 'FAIL', battleId, ladder: true, opponent: npc.name,
      seedLedger: N, challengeLedger: lseq, claimedN, seed,
      // The arithmetic, not just the verdict. resolveBattle has always returned these; they were
      // computed, checked and then dropped on the floor, so a player could see WHO won but never
      // BY WHAT. A score with no roll and no power behind it is indistinguishable from a coin flip,
      // which is exactly what this game is accused of being.
      math: { rollA: d.rollA, powerA: d.powerA, scoreA: d.scoreA,
              rollB: d.rollB, powerB: d.powerB, scoreB: d.scoreB, rulesetVersion: d.rulesetVersion },
      names: { a: sA && sA.name ? sA.name : null, b: npc.name },
      nids: { a: aNid, b: npcId },
      ...(staleCommitment ? { warning: 'STALE_COMMITMENT', warningDetail:
        `the challenge memo pinned ledger ${claimedN}, which had already closed when the challenge landed in ${lseq}. `
        + 'That seed was public at signing time. Resolution used the derived ledger instead.' } : {}),
      derived: { winner: derivedWinner, scoreA: d.scoreA, scoreB: d.scoreB }, recorded: b.result,
      reason: ok ? 'ladder result re-derives from the pinned ledger hash + the published NPC stats + open rules' : 'recorded ladder result does not match a faithful replay' };
  }
  // Re-run the SAME accept selection resolveBattleTx used — first well-formed accept whose sender owns
  // the pet. Verifying against whatever accept memo happened to be last would confirm the arithmetic of
  // a re-rolled fight: the loser could send a second accept, move the seed ledger, and this endpoint
  // would hand the new dice a PASS. A verifier that cannot fail on that is not a verifier.
  const picked = await pickAccept(c, issuer, b);
  b.accept = picked ? picked.accept : null;
  const ignoredAccepts = b.accepts.length - (picked ? 1 : 0);
  if (!b.accept && !b.result) return { ok: false, verdict: 'OPEN', reason: 'not accepted yet', ignoredAccepts };
  if (!b.result) return { ok: false, verdict: 'UNRESOLVED', reason: 'not resolved yet', ignoredAccepts };
  if (b.result.winnerNid === 'VOID') {   // battle was voided for underpayment; refunds are on-ledger + checkable
    const stake = Number(b.challenge.stakeDrops || 0), dA = Number(b.challenge.delivered || 0), dB = b.accept ? Number(b.accept.delivered || 0) : 0;
    const legit = dA < stake || dB < stake;
    return { ok: legit, verdict: legit ? 'VOID' : 'FAIL', battleId, refunds: b.refunds, reason: legit ? 'voided: a party delivered less than the agreed stake; refunded' : 'VOID recorded but both stakes were fully delivered' };
  }
  if (!b.accept) return { ok: false, verdict: 'FAIL', battleId, ignoredAccepts,
    reason: 'a result was recorded but no accept on the ledger is a valid commitment to this challenge' };
  const { aNid } = b.challenge, { bNid } = b.accept;
  // SAME derivation as resolveBattleTx, for the same reason the ladder verifier uses it: verifying
  // against the memo's N would confirm the arithmetic while missing whether the seed was knowable
  // when the acceptor signed, which is the only property that makes a staked battle fair.
  const claimedN = b.challenge.N;
  const acceptLseq = b.accept.lseq;
  const N = (acceptLseq || 0) + BATTLE_LEDGER_MARGIN;
  const staleCommitment = Number.isInteger(claimedN) && claimedN > 1000000 && acceptLseq && claimedN <= acceptLseq;
  const lh = await ledgerHashOf(c, N);
  if (!lh) return { ok: false, verdict: 'ERROR', reason: 'pinned ledger not available' };
  const seed = seedFor(lh, battleId, aNid, bNid);
  const hA = await loadHistory(c, issuer, aNid), hB = picked.history;   // pickAccept already read B's history
  const sA = stateAtLedger(hA.genesis, hA.interactions, N), sB = stateAtLedger(hB.genesis, hB.interactions, N);
  // As above: re-derive under the RECORDED ruleset version so a rules fix never invalidates a
  // battle that was settled honestly under the older rules.
  const d = BR.resolveBattle(seed, sA, sB, aNid, bNid, b.result.rv);
  const derivedWinner = d.winner === null ? 'DRAW' : d.winner;
  const winnerMatch = derivedWinner === b.result.winnerNid;
  const scoresMatch = d.scoreA === b.result.scoreA && d.scoreB === b.result.scoreB;
  const winnerOwner = d.winner === aNid ? sA.owner : d.winner === bNid ? sB.owner : null;
  const paidRight = d.winner === null || b.result.dest === winnerOwner;
  const ok = winnerMatch && scoresMatch && paidRight;
  return { ok, verdict: ok ? 'PASS' : 'FAIL', battleId, N, seed,
    seedLedger: N, acceptLedger: acceptLseq, claimedN, ignoredAccepts,
    // See the ladder branch: the arithmetic is the product, the verdict is only the receipt.
    math: { rollA: d.rollA, powerA: d.powerA, scoreA: d.scoreA,
            rollB: d.rollB, powerB: d.powerB, scoreB: d.scoreB, rulesetVersion: d.rulesetVersion },
    names: { a: sA && sA.name ? sA.name : null, b: sB && sB.name ? sB.name : null },
    nids: { a: aNid, b: bNid },
    ...(staleCommitment ? { warning: 'STALE_COMMITMENT', warningDetail:
      `the challenge memo pinned ledger ${claimedN}, which had already closed when the accept landed in ${acceptLseq}. `
      + 'That seed was public when the acceptor signed. Resolution used the derived ledger instead.' } : {}),
    derived: { winner: derivedWinner, scoreA: d.scoreA, scoreB: d.scoreB, winnerOwner }, recorded: b.result,
    reason: ok ? 'winner + scores re-derive from the pinned ledger hash and the open rules; payout went to the winner'
      : !winnerMatch ? 'recorded winner does not match a faithful replay'
      : !scoresMatch ? 'recorded scores do not match the replay' : 'payout did not go to the derived winner' };
}

// challenge → returns an UNSIGNED stake Payment (owner signs via Xaman). Pins a future ledger N for the seed.
app.post('/battle/challenge', async (req, res) => {
  const { owner, aNid, stakeXrp, N } = req.body || {};
  if (!owner || !aNid) return res.status(400).json({ error: 'owner + aNid required' });
  if (!xrpl.isValidClassicAddress(owner)) return res.status(400).json({ error: 'invalid owner address' });
  try {
    const out = await withClient(async (c, w) => {
      const issuer = w.classicAddress;
      const ps = await readState(c, issuer, aNid);
      if (!ps) return { error: 'pet not found' };
      if (ps.owner !== owner) return { error: 'you do not own this pet' };
      if (ps.alive === 0) return { error: 'a passed pet cannot battle' };
      const cur = (await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index;
      const targetN = Number.isInteger(Number(N)) && Number(N) >= cur + BATTLE_LEDGER_MARGIN ? Number(N) : cur + BATTLE_LEDGER_MARGIN;
      const drops = stakeXrp ? xrpl.xrpToDrops(stakeXrp) : '1';   // 0-stake friendly = 1 drop to carry the memo
      return { unsignedTx: tag({ TransactionType: 'Payment', Account: owner, Destination: issuer, Amount: String(drops),
          Memos: [{ Memo: { MemoType: hex(BATTLE_MEMO), MemoData: hex(['challenge', aNid, String(drops), String(targetN)].join('|')) } }] }),
        signWith: 'owner (Xaman)', pinnedLedger: targetN, currentLedger: cur,
        note: 'battleId = this Payment tx hash after it validates; share it so an opponent can POST /battle/accept' };
    });
    if (out.error) return res.status(400).json(out);
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// accept → returns an UNSIGNED matching-stake Payment (opponent signs via Xaman).
app.post('/battle/accept', async (req, res) => {
  const { owner, battleId, bNid } = req.body || {};
  if (!owner || !battleId || !bNid) return res.status(400).json({ error: 'owner + battleId + bNid required' });
  if (!xrpl.isValidClassicAddress(owner)) return res.status(400).json({ error: 'invalid owner address' });
  try {
    const out = await withClient(async (c, w) => {
      const issuer = w.classicAddress;
      const b = await loadBattle(c, issuer, battleId);
      if (!b.challenge) return { error: 'unknown battleId' };
      if (b.challenge.npc) return { error: 'that is a ladder battle, not a PvP challenge' };
      if (b.result) return { error: 'that fight is already settled' };
      // Only a VALID accept blocks this. Guarding on any accept memo let a griefer lock a challenge
      // shut for one drop by sending a junk accept (nobody could then build a real one, and the
      // challenger's stake sat at the issuer with no path out).
      if (await pickAccept(c, issuer, b)) return { error: 'already accepted' };
      if (bNid === b.challenge.aNid) return { error: 'a pet cannot battle itself' };
      // must accept BEFORE the pinned ledger closes — otherwise ledgerHash(N) is known and the accepter
      // could join only when the seed already favors them. Closes the accepter-foreknowledge bias.
      const curL = (await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index;
      if (curL >= b.challenge.N) return { error: `challenge expired: pinned ledger ${b.challenge.N} already reached (current ${curL})` };
      const ps = await readState(c, issuer, bNid);
      if (!ps) return { error: 'pet not found' };
      if (ps.owner !== owner) return { error: 'you do not own this pet' };
      if (ps.alive === 0) return { error: 'a passed pet cannot battle' };
      // Must MATCH the challenger's stake. loadBattle writes that to `stakeDrops`; this read was
      // `b.challenge.amount`, a key no code path has set since 4a8438ab renamed it, so every accept
      // built here was 1 drop and reported `matchStakeDrops: '1'`. Against a real staked challenge
      // that is an automatic underpayment: deliveredB < stake, VOID, the fight never happens.
      const drops = b.challenge.stakeDrops || '1';
      return { unsignedTx: tag({ TransactionType: 'Payment', Account: owner, Destination: issuer, Amount: String(drops),
          Memos: [{ Memo: { MemoType: hex(BATTLE_MEMO), MemoData: hex(['accept', battleId, bNid].join('|')) } }] }),
        signWith: 'owner (Xaman)', matchStakeDrops: String(drops) };
    });
    if (out.error) return res.status(400).json(out);
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// resolve (admin) · status (public) · verify (public — the fairness proof)
app.post('/battle/resolve', requireAdmin, async (req, res) => {
  const { battleId } = req.body || {};
  if (!battleId) return res.status(400).json({ error: 'battleId required' });
  try { res.json(await withClient((c, w) => resolveBattleTx(c, w, battleId))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/battle/:battleId', async (req, res) => {
  try {
    // Cached: the challenger's client polls this while it waits for a human to accept, and each
    // uncached call is a full pass over the issuer's history. Settlement takes ~80s, so a few seconds
    // of staleness costs the player nothing. Resolution and verification never read the cache.
    const out = await cached('battle:' + req.params.battleId, 8000, () => withClient(async (c, w) => {
      const issuer = w.classicAddress;
      const b = await loadBattle(c, issuer, req.params.battleId);
      const picked = await pickAccept(c, issuer, b);            // free when there are no accept memos
      b.accept = picked ? picked.accept : null;
      return { status: !b.challenge ? 'NOT_FOUND' : b.result ? 'RESOLVED' : b.accept ? 'LIVE' : 'OPEN', ...b };
    }));
    res.set('Cache-Control', 'public, max-age=8').json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/verify-battle/:battleId', async (req, res) => {
  try { res.json(await withClient((c, w) => verifyBattle(c, w.classicAddress, req.params.battleId))); }
  catch (e) { res.status(500).json({ ok: false, verdict: 'ERROR', reason: e.message }); }
});

// ladder: the PUBLISHED house-NPC roster (opponents are public + fixed → provably fair). Auditable.
// ── server-side sign requests ────────────────────────────────────────────────────────────────────
// The browser SDK's authorize() hangs on both desktop and mobile: no popup, no error, no rejection.
// The app registration is fine (opening the OAuth URL by hand renders a real Xaman sign request), so
// rather than keep fighting the client flow, payloads are created here with the server credentials.
// This is the ordinary Xaman server integration and it needs no sign-in at all: the player supplies
// an address, we build the transaction, Xaman shows it to them, they approve.
//
// DELIBERATELY NOT A GENERIC SIGNING PROXY. It only ever builds the two transactions this game
// defines, from validated inputs. An endpoint that signed arbitrary txjson would let anyone create
// payloads under this app's identity and show users transactions we did not author.
app.post('/sign', async (req, res) => {
  if (!sdk) return res.status(503).json({ error: 'signing not configured (set XAMAN_API_KEY and XAMAN_API_SECRET)' });
  const { kind, owner, nid, op, rung, battleId, ghostNid } = req.body || {};
  // signin is the one kind that cannot know the address yet — discovering it IS the point.
  // Every other kind still requires a valid owner up front.
  if (kind !== 'signin' && !xrpl.isValidClassicAddress(owner || '')) {
    return res.status(400).json({ error: 'valid owner address required' });
  }

  try {
    let txjson, instruction;

    if (kind === 'signin') {
      // Xaman's SignIn pseudo-transaction. It is never submitted to a ledger and moves no
      // value; it only proves the user controls the account they resolve with. This keeps
      // /sign a fixed menu of intents rather than a generic signing proxy.
      txjson = { TransactionType: 'SignIn' };
      instruction = 'Sign in to Ledgerlings. This moves no funds and is not a ledger transaction.';
    } else if (kind === 'interact') {
      if (!R.OP[op]) return res.status(400).json({ error: 'unknown op' });
      if (!nid) return res.status(400).json({ error: 'nid required' });
      txjson = { TransactionType: 'Payment', Account: owner, Destination: ISSUER_ADDRESS || undefined,
        Amount: '10', Memos: [{ Memo: { MemoType: hex('ledgerlings/op'), MemoData: hex(`${op}|${nid}`) } }] };
      instruction = `Ledgerlings: ${op} your pet`;

    } else if (kind === 'ghost') {
      // Challenge a snapshot of somebody else's pet. No accept, no second signature, no waiting for
      // a human who may never come back. Mirrors the ladder branch exactly, including writing the
      // MARGIN rather than an absolute ledger, because the seed is derived at resolution.
      if (!nid) return res.status(400).json({ error: 'nid required' });
      const g = String(ghostNid || '').toUpperCase();
      if (!/^[0-9A-F]{64}$/.test(g)) return res.status(400).json({ error: 'valid ghostNid required' });
      if (g === String(nid).toUpperCase()) return res.status(400).json({ error: 'a pet cannot fight its own ghost' });
      const built = await withClient(async (c, w) => {
        const ps = await readState(c, w.classicAddress, nid);
        if (!ps) return { error: 'pet not found' };
        if (ps.owner !== owner) return { error: 'you do not own this pet' };
        if (ps.alive === 0) return { error: 'a passed pet cannot battle' };
        const gs = await readState(c, w.classicAddress, g);
        if (!gs) return { error: 'no such opponent' };
        if (gs.owner === owner) return { error: 'pick somebody else\'s pet' };
        // Checked here for a clear error; resolution re-checks against DERIVED state, because a pet
        // that reads alive today can be derived-dead by the seed ledger and this check is advisory.
        if (gs.alive === 0) return { error: 'that pet has passed' };
        const cur = (await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index;
        return { N: cur + BATTLE_LEDGER_MARGIN, tx: { TransactionType: 'Payment', Account: owner, Destination: w.classicAddress, Amount: '1',
          Memos: [{ Memo: { MemoType: hex(BATTLE_MEMO), MemoData: hex(['ghost', nid, g, String(BATTLE_LEDGER_MARGIN)].join('|')) } }] } };
      });
      if (built.error) return res.status(400).json(built);
      txjson = built.tx;
      instruction = `Ledgerlings: fight the ghost of ${g.slice(0, 8)}`;
      res.locals = { pinnedLedger: built.N };

    } else if (kind === 'ladder') {
      if (!LADDER[rung]) return res.status(400).json({ error: 'invalid rung (see GET /ladder)' });
      if (!nid) return res.status(400).json({ error: 'nid required' });
      const built = await withClient(async (c, w) => {
        const ps = await readState(c, w.classicAddress, nid);
        if (!ps) return { error: 'pet not found' };
        if (ps.owner !== owner) return { error: 'you do not own this pet' };
        if (ps.alive === 0) return { error: 'a passed pet cannot battle' };
        const cur = (await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index;
        const N = cur + BATTLE_LEDGER_MARGIN;
        return { N, tx: { TransactionType: 'Payment', Account: owner, Destination: w.classicAddress, Amount: '1',
          // 4th field is the MARGIN, not an absolute ledger. The seed ledger is derived at resolution
          // from the ledger this challenge lands in, so pinning an absolute one here would be both
          // meaningless and always stale by the time a human finishes approving.
          Memos: [{ Memo: { MemoType: hex(BATTLE_MEMO), MemoData: hex(['ladder', nid, String(rung), String(BATTLE_LEDGER_MARGIN)].join('|')) } }] } };
      });
      if (built.error) return res.status(400).json(built);
      txjson = built.tx;
      instruction = `Ledgerlings: challenge ${LADDER[rung].name}`;
      res.locals = { pinnedLedger: built.N };

    } else if (kind === 'challenge') {
      // Fight Club v1: PvP. FREE — the stake is hard-coded to 1 drop on BOTH sides, so the pot is 2 drops,
      // the fee floors to 0, and the custody guard can never trip. No stakeXrp is accepted here; /sign is a
      // fixed menu of intents and this build deliberately holds no real player XRP.
      if (!nid) return res.status(400).json({ error: 'nid required' });
      const built = await withClient(async (c, w) => {
        const ps = await readState(c, w.classicAddress, nid);
        if (!ps) return { error: 'pet not found' };
        if (ps.owner !== owner) return { error: 'you do not own this pet' };
        if (ps.alive === 0) return { error: 'a passed pet cannot battle' };
        const cur = (await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index;
        // ABSOLUTE ledger index here, unlike the ladder branch above, and that asymmetry is required.
        // Field 4 is inert for a ladder battle (no second party), but loadBattle reads it into
        // challenge.N and the accept path rejects once curL >= N. Writing the margin (20) there would
        // make every accept "expired" forever and the PvP path would be dead on arrival.
        // Caller-supplied N is ignored outright: it buys nothing for fairness (the seed comes from the
        // accept's landing ledger) and an unbounded one would defeat the deadline.
        const N = cur + BATTLE_CHALLENGE_TTL;
        return { N, tx: { TransactionType: 'Payment', Account: owner, Destination: w.classicAddress, Amount: '1',
          Memos: [{ Memo: { MemoType: hex(BATTLE_MEMO), MemoData: hex(['challenge', nid, '1', String(N)].join('|')) } }] } };
      });
      if (built.error) return res.status(400).json(built);
      txjson = built.tx;
      instruction = `Ledgerlings: start a fight`;
      // NOTE: for this kind pinnedLedger is the ACCEPT EXPIRY, not a seed ledger.
      res.locals = { pinnedLedger: built.N };

    } else if (kind === 'accept') {
      if (!nid) return res.status(400).json({ error: 'nid required' });
      const bid = String(battleId || '').toUpperCase();
      if (!/^[0-9A-F]{64}$/.test(bid)) return res.status(400).json({ error: 'valid battleId required' });
      const built = await withClient(async (c, w) => {
        const issuer = w.classicAddress;
        const b = await loadBattle(c, issuer, bid);
        if (!b.challenge) return { error: 'unknown battleId' };
        // MANDATORY: resolveBattleTx routes b.challenge.npc to resolveLadder BEFORE it ever reads
        // b.accept, so drops sent as an accept against a ladder battleId are kept by the issuer with
        // no refund path. Refuse to build that transaction at all.
        if (b.challenge.npc) return { error: 'that is a ladder battle, not a PvP challenge' };
        if (b.result) return { error: 'that fight is already settled' };
        // Only a VALID accept closes the fight (see /battle/accept): a junk accept memo must not be
        // able to lock an honest challenge shut for one drop.
        if (await pickAccept(c, issuer, b)) return { error: 'already accepted' };
        if (nid === b.challenge.aNid) return { error: 'a pet cannot battle itself' };
        // Must accept BEFORE the challenge's expiry. Self-accept (both pets one owner) is deliberately
        // ALLOWED: the seed is derived from the accept's landing ledger + margin, so it is unknowable to
        // either side at signing regardless of who owns what.
        const curL = (await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index;
        if (curL >= b.challenge.N) return { error: `challenge expired: pinned ledger ${b.challenge.N} already reached (current ${curL})` };
        const ps = await readState(c, issuer, nid);
        if (!ps) return { error: 'pet not found' };
        if (ps.owner !== owner) return { error: 'you do not own this pet' };
        if (ps.alive === 0) return { error: 'a passed pet cannot battle' };
        return { tx: { TransactionType: 'Payment', Account: owner, Destination: issuer, Amount: '1',
          Memos: [{ Memo: { MemoType: hex(BATTLE_MEMO), MemoData: hex(['accept', bid, nid].join('|')) } }] } };
      });
      if (built.error) return res.status(400).json(built);
      txjson = built.tx;
      instruction = `Ledgerlings: accept fight ${bid.slice(0, 8)}`;
      // No res.locals: there is no pinnedLedger for an accept, and this tx's own hash is NOT the battleId.

    } else {
      return res.status(400).json({ error: "kind must be 'interact', 'ladder', 'ghost', 'challenge' or 'accept'" });
    }

    // A SignIn payload proves control of an address and moves nothing, so it is not
    // SourceTagged (it never reaches a ledger) and carries no Account of its own.
    const payload = await sdk.payload.create(
      kind === 'signin' ? { txjson, custom_meta: { instruction } }
                        : { txjson: tag(txjson), custom_meta: { instruction } });
    if (!payload) return res.status(502).json({ error: 'Xaman did not return a payload' });
    res.json({
      uuid: payload.uuid,
      next: payload.next && payload.next.always,     // open this: Xaman deep link on mobile, QR on desktop
      qr: payload.refs && payload.refs.qr_png,
      // Xaman hands us a status socket per payload. The frontend subscribes to it instead of
      // polling; polling stays as the fallback for when the socket cannot be opened.
      ws: payload.refs && payload.refs.websocket_status,
      pinnedLedger: (res.locals && res.locals.pinnedLedger) || undefined,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Poll a sign request. Returns signed:true plus the txid once the user approves in Xaman.
app.get('/sign/:uuid', async (req, res) => {
  if (!sdk) return res.status(503).json({ error: 'signing not configured' });
  try {
    const pl = await sdk.payload.get(req.params.uuid);
    if (!pl) return res.status(404).json({ error: 'not found' });
    res.json({ signed: !!(pl.meta && pl.meta.signed), cancelled: !!(pl.meta && pl.meta.cancelled),
      expired: !!(pl.meta && pl.meta.expired), txid: pl.response && pl.response.txid,
      // resolved signer — this is what a signin returns instead of a txid
      account: pl.response && pl.response.account });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/ladder', (req, res) => {
  res.json({ rulesetVersion: RULESET_VERSION, rungs: LADDER.map((n, i) => ({ rung: i, id: n.id, name: n.name, stats: n.stats, power: BR.power(n.stats) })) });
});
// ladder challenge → unsigned 0-stake Payment (owner signs via Xaman). Then POST /battle/resolve after ledger N.
app.post('/battle/ladder', async (req, res) => {
  const { owner, aNid, rung } = req.body || {};
  if (!owner || aNid === undefined || rung === undefined) return res.status(400).json({ error: 'owner + aNid + rung required' });
  if (!xrpl.isValidClassicAddress(owner)) return res.status(400).json({ error: 'invalid owner address' });
  if (!LADDER[rung]) return res.status(400).json({ error: 'invalid rung (see GET /ladder)' });
  try {
    const out = await withClient(async (c, w) => {
      const issuer = w.classicAddress, ps = await readState(c, issuer, aNid);
      if (!ps) return { error: 'pet not found' };
      if (ps.owner !== owner) return { error: 'you do not own this pet' };
      if (ps.alive === 0) return { error: 'a passed pet cannot battle' };
      const cur = (await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index;
      const N = cur + BATTLE_LEDGER_MARGIN;
      return { unsignedTx: tag({ TransactionType: 'Payment', Account: owner, Destination: issuer, Amount: '1',
          Memos: [{ Memo: { MemoType: hex(BATTLE_MEMO), MemoData: hex(['ladder', aNid, String(rung), String(N)].join('|')) } }] }),
        signWith: 'owner (Xaman)', opponent: LADDER[rung].name, pinnedLedger: N,
        note: 'battleId = this tx hash; after ledger N POST /battle/resolve to fight the house NPC (free, provably fair)' };
    });
    if (out.error) return res.status(400).json(out);
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// a pet's ladder progression — wins, current win-streak, highest rung beaten (all re-derivable from ledger).
app.get('/ladder-rank/:nid', async (req, res) => {
  try {
    const out = await withClient(async (c, w) => {
      const issuer = w.classicAddress, nid = req.params.nid;
      const cur = await readState(c, issuer, nid), minL = cur && Number.isInteger(cur.birth) ? cur.birth : null;
      const battles = []; let marker;
      do {
        const rq = { command: 'account_tx', account: issuer, limit: 200, forward: true, marker };
        if (minL != null) rq.ledger_index_min = minL;
        const r = await c.request(rq);
        for (const t of r.result.transactions) {
          const tx = t.tx || t.tx_json || {}; if (tx.TransactionType !== 'Payment') continue;
          if (!t.meta || t.meta.TransactionResult !== 'tesSUCCESS') continue;
          const hash = tx.hash || t.hash, lseq = tx.ledger_index || t.ledger_index;
          for (const m of (tx.Memos || [])) {
            const md = m.Memo || {};
            try { if (unhex(md.MemoType || '') !== BATTLE_MEMO) continue; const f = unhex(md.MemoData || '').split('|');
              if (f[0] === 'ladder' && f[1] === nid && hash && tx.Destination === issuer) battles.push({ battleId: hash, rung: Number(f[2]), lseq, win: null });
              // ISSUER-SIGNED results only — same rule as loadBattle. Anyone can send the issuer a
              // Payment carrying a `result|…` memo, and counting one here would let a stranger write
              // wins and losses onto any pet's public record for a drop.
              else if (f[0] === 'result' && tx.Account === issuer) { const bb = battles.find(x => x.battleId === f[1]); if (bb && bb.win === null) bb.win = f[2] === nid; }
            } catch { /* skip */ }
          }
        }
        marker = r.result.marker;
      } while (marker);
      battles.sort((a, b) => a.lseq - b.lseq);
      let wins = 0, streak = 0, best = -1;
      for (const b of battles) { if (b.win) { wins++; streak++; best = Math.max(best, b.rung); } else if (b.win === false) streak = 0; }
      // last RESOLVED battle, so the client can show a pet is freshly scuffed. This is a pure
      // projection of on-ledger battle records — the same trust model as the achievement badges —
      // so it changes no pet state and cannot make /verify diverge.
      const settled = battles.filter(b => b.win !== null);
      const last = settled.length ? settled[settled.length - 1] : null;
      return { nid, resolved: settled.length, wins, currentStreak: streak, highestRungBeaten: best,
        highestRungName: best >= 0 ? LADDER[best].name : null,
        lastLedger: last ? last.lseq : null, lastWin: last ? last.win : null };
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── the fight board (public) ─────────────────────────────────────────────────────────────────────
// Every resolved battle on the issuer, folded per pet, from ONE account_tx pass. Deliberately NOT
// built from the battle-card NFTs: the card URI keeps w = winnerNid.slice(0,24), which is flags +
// transfer fee + the first 8 bytes of the issuer AccountID — identical for every pet this issuer
// mints, so a card cannot say WHICH pet won. The result memo carries the full 64-hex winner nid.
// Also deliberately not a fan-out: /ladder-rank/:nid and loadBattle each do their own full scan.
// Ranked by wins, tie-broken on best streak then highest rung. NEVER by stake volume — every battle
// ever played staked 1 drop, so a stake column would rank battle count under a money label.
const BOARD_MIN_BATTLES_FOR_WINRATE = 5;
const BOARD_NOTE = 'Ladder battles are free and unlimited, so total wins is grindable. Win rate is shown only after '
  + BOARD_MIN_BATTLES_FOR_WINRATE + ' resolved battles. Draws break a streak; voided battles are not counted at all.';
app.get('/leaderboard', async (req, res) => {
  try {
    const q = Number(req.query.limit);
    const limit = Number.isFinite(q) && q >= 1 ? Math.min(100, Math.floor(q)) : 25;
    // Cached server-side, not just in a response header: this endpoint does its own full pass over the
    // issuer's account_tx PLUS an account_nfts pass, on a fresh connection, and it is fired on every
    // page load by every visitor whether or not they own a pet. The max-age header alone does nothing
    // without a CDN in front, which there is not.
    const out = await cached('leaderboard:' + limit, 30000, () => withClient(async (c, w) => {
      const issuer = w.classicAddress;
      const generatedLedger = (await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index;
      // battleId -> the whole battle, assembled from the four memo kinds. challenge/ladder are keyed by
      // the TX HASH (the challenge hash IS the battleId); accept/result carry the battleId in field 1.
      const B = new Map();
      const bat = id => { let b = B.get(id); if (!b) { b = { aNid: null, bNid: null, rung: null, ladder: false, winnerNid: null, resultLseq: null }; B.set(id, b); } return b; };
      let scannedTx = 0, marker;
      do {
        const r = await c.request({ command: 'account_tx', account: issuer, limit: 200, forward: true, marker });
        for (const t of r.result.transactions) {
          scannedTx++;
          const tx = t.tx || t.tx_json || {}; if (tx.TransactionType !== 'Payment') continue;
          if (!t.meta || t.meta.TransactionResult !== 'tesSUCCESS') continue;
          const hash = tx.hash || t.hash || ''; const lseq = tx.ledger_index || t.ledger_index;
          const toIssuer = tx.Destination === issuer, byIssuer = tx.Account === issuer;
          for (const m of (tx.Memos || [])) {
            const md = m.Memo || {};
            try {
              if (unhex(md.MemoType || '') !== BATTLE_MEMO) continue;
              const f = unhex(md.MemoData || '').split('|'), kind = f[0];
              // Same authority rules as loadBattle, because this board is a public scoreboard and every
              // memo it reads is attacker-writable: commitments must be delivered TO the issuer, the
              // FIRST accept is the one that counts, and only the ISSUER can declare a result. Without
              // the last one the #1 slot was purchasable — forge a result memo naming your own pet.
              if (kind === 'challenge' && hash && toIssuer) { const b = bat(hash); if (b.aNid == null) b.aNid = f[1]; }
              else if (kind === 'ladder' && hash && toIssuer) { const b = bat(hash); if (b.aNid == null) { b.aNid = f[1]; b.rung = Number(f[2]); b.ladder = true; } }
              // b.ghostNid is recorded for display only. It is deliberately NOT set as b.bNid,
              // because bNid is what the leaderboard credits — and a ghost's owner never agreed to
              // fight, so a loss must never land on their public record.
              else if (kind === 'ghost' && hash && toIssuer) { const b = bat(hash); if (b.aNid == null) { b.aNid = f[1]; b.ghostNid = f[2]; b.ghost = true; } }
              else if (kind === 'accept' && f[1] && toIssuer) { const b = bat(f[1]); if (b.bNid == null) b.bNid = f[2]; }
              else if (kind === 'result' && f[1] && byIssuer) { const b = bat(f[1]); if (b.winnerNid == null) { b.winnerNid = f[2]; b.resultLseq = lseq; } }
            } catch { /* skip malformed memo */ }
          }
        }
        marker = r.result.marker;
      } while (marker);
      // a battle counts only with BOTH a challenge/ladder and a result; folded oldest result first so
      // the streak and the "last battle" fields come out in ledger order.
      const settled = [...B.entries()]
        .filter(([, b]) => b.aNid && b.winnerNid)
        .map(([battleId, b]) => ({ battleId, ...b }))
        .sort((x, y) => (x.resultLseq || 0) - (y.resultLseq || 0));

      const P = new Map();
      const row = nid => { let p = P.get(nid); if (!p) { p = { nid, played: 0, ladderPlayed: 0, pvpPlayed: 0, wins: 0, losses: 0,
        draws: 0, voids: 0, currentStreak: 0, bestStreak: 0, highestRungBeaten: -1, lastLedger: null, lastWin: null }; P.set(nid, p); } return p; };
      for (const b of settled) {
        // A ghost fight is one-sided by design: only the challenger's record moves. The ghost's
        // owner never signed anything, so crediting them — win OR loss — would be conscripting a
        // stranger's pet into a fight it never agreed to, which is the exact thing pickAccept was
        // written to prevent on the PvP path.
        const pvp = !b.ladder && !b.ghost && b.bNid;
        // If the recorded winner is neither side, the accept this scan picked is not the accept the
        // settlement used (anyone can send an accept memo, and a griefer's can land first). Credit
        // nobody rather than credit the wrong pet.
        if (pvp && !['DRAW', 'VOID', b.aNid, b.bNid].includes(b.winnerNid)) continue;
        // Deduped: an accept naming the CHALLENGER's own pet made parts [X, X], so one crafted
        // self-battle folded onto the same row twice — +2 wins and +2 streak, deterministically,
        // for two transaction fees. Resolution now refuses to settle a self-battle at all; this is
        // the second lock on the same door, because the board is what the ranking is read from.
        const parts = [...new Set(pvp ? [b.aNid, b.bNid] : [b.aNid])];
        for (const nid of parts) {
          const p = row(nid);
          if (b.winnerNid === 'VOID') { p.voids++; continue; }        // refunded, never happened — no played, no streak break
          p.played++;
          if (b.ladder) p.ladderPlayed++; else p.pvpPlayed++;
          let win = false;
          if (b.winnerNid === 'DRAW') { p.draws++; p.currentStreak = 0; }   // same as /ladder-rank, disclosed in `note`
          else if (b.winnerNid === nid) {
            p.wins++; p.currentStreak++; win = true;
            if (b.ladder && Number.isInteger(b.rung)) p.highestRungBeaten = Math.max(p.highestRungBeaten, b.rung);
          } else { p.losses++; p.currentStreak = 0; }                       // includes every NPC:* winner
          p.bestStreak = Math.max(p.bestStreak, p.currentStreak);
          p.lastLedger = b.resultLseq == null ? null : b.resultLseq;
          p.lastWin = win;
        }
      }
      // stage/alive from ONE account_nfts pass, not one readState per pet.
      const live = new Map();
      for (const n of (await allIssuerNfts(c, issuer))) {
        if (n.NFTokenTaxon !== TAXON || !n.URI) continue;
        try { live.set(n.NFTokenID, dec(n.URI)); } catch { /* unreadable URI -> treated as absent */ }
      }
      const rows = [...P.values()].map(p => {
        const s = live.get(p.nid);
        return { nid: p.nid, stage: s ? s.stage : null, alive: s ? s.alive : null,
          played: p.played, ladderPlayed: p.ladderPlayed, pvpPlayed: p.pvpPlayed,
          wins: p.wins, losses: p.losses, draws: p.draws, voids: p.voids,
          currentStreak: p.currentStreak, bestStreak: p.bestStreak, highestRungBeaten: p.highestRungBeaten,
          winRate: p.played >= BOARD_MIN_BATTLES_FOR_WINRATE ? Math.round(p.wins * 100 / p.played) : null,
          lastLedger: p.lastLedger, lastWin: p.lastWin };
      });
      rows.sort((a, b) => (b.wins - a.wins) || (b.bestStreak - a.bestStreak) || (b.highestRungBeaten - a.highestRungBeaten)
        || (a.played - b.played) || (a.nid < b.nid ? -1 : a.nid > b.nid ? 1 : 0));
      return { generatedLedger, scannedTx, battles: settled.length, rulesetVersion: RULESET_VERSION,
        minBattlesForWinRate: BOARD_MIN_BATTLES_FOR_WINRATE, note: BOARD_NOTE, rows: rows.slice(0, limit) };
    }));
    res.set('Cache-Control', 'public, max-age=30').json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// interact: verify the signed Payment, apply rules, NFTokenModify
app.post('/interact', requireAdmin, async (req, res) => {
  const { uuid, nid } = req.body;
  if (!uuid || !nid) return res.status(400).json({ error: 'uuid + nid required' });
  if (!sdk) return res.status(503).json({ error: 'signing not configured (set XAMAN_API_KEY/SECRET)' });
  // 1) verify the sign request was actually signed
  const pl = await sdk.payload.get(uuid);
  if (!pl || !pl.meta.signed) return res.status(400).json({ error: 'not signed' });
  const txid = pl.response.txid;

  const out = await withClient(async (c, w) => {
    // 2) read the on-ledger Payment: op memo + sender + the ledger_index (= the deterministic `now`)
    const tx = (await c.request({ command: 'tx', transaction: txid })).result;
    const memo = (tx.Memos || []).map(m => m.Memo).find(m => unhex(m.MemoType || '') === 'ledgerlings/op');
    if (!memo) throw new Error('no op memo');
    const [opName] = unhex(memo.MemoData).split('|');   // memo is "<op>|<nid>" (nid present for on-ledger verify)
    const op = R.OP[opName] || 0;
    const sender = tx.Account, now = tx.ledger_index;
    // 3) apply the open rules, write the new state on-ledger
    const state = await readState(c, w.classicAddress, nid);
    if (!state) throw new Error('pet not found');
    const next = R.step(state, op, now, sender);            // sender !== owner ⇒ no-op (owner-only)
    const result = await submit(c, w, { TransactionType: 'NFTokenModify',
      Account: w.classicAddress, NFTokenID: nid, URI: enc(next) });
    // auto-award: mint any milestone badge this interaction just crossed (more live on-chain txns). Non-fatal.
    let achievements;
    if (AUTO_AWARD) { try { achievements = await claimAchievements(c, w, nid); } catch (e) { achievements = { error: e.message }; } }
    return { result, state: next, applied: JSON.stringify(next) !== JSON.stringify(state), achievements };
  });
  res.json(out);
});

// mint-accessory: a collaborator's drawn accessory/background → an on-ledger NFT with the 5% royalty.
// The issuer mints (taxon=ACCESSORY_TAXON, transferable); artist + image hash + name are anchored in the
// URI (compact, <=256 bytes). MVP: the URI carries provenance (name/artist/sha256); hosting the image
// itself (IPFS/Arweave) + delivering the NFT to the artist's wallet are the production follow-ups.
app.post('/mint-accessory', requireAdmin, async (req, res) => {
  const { artist, name, sha256, kind } = req.body || {};
  if (!artist || !name || !sha256) return res.status(400).json({ error: 'artist, name, sha256 required' });
  try {
    const out = await withClient(async (c, w) => {
      const meta = { t: 'acc', k: String(kind || 'accessory').slice(0, 12), n: String(name).slice(0, 40),
        a: String(artist).slice(0, 40), h: String(sha256).slice(0, 64), r: ROYALTY_BPS };
      if (Buffer.byteLength(JSON.stringify(meta)) > 256) meta.h = meta.h.slice(0, 32);  // keep URI <=256 bytes
      const prepared = await c.autofill(tag({ TransactionType: 'NFTokenMint', Account: w.classicAddress,
        NFTokenTaxon: ACCESSORY_TAXON, Flags: TF_TRANSFERABLE, TransferFee: ROYALTY_BPS, URI: hex(JSON.stringify(meta)) }));
      const r = (await c.submitAndWait(w.sign(prepared).tx_blob)).result;
      return { result: r.meta.TransactionResult, nid: r.meta.nftoken_id, meta };
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// register-character: an NFT project adds their character as a playable Ledgerlings skin (per
// CHARACTER_TEMPLATE.md). Mints a registration NFT (taxon=CHARACTER_TAXON) anchoring creator + name +
// collection + art hash + a hash of the anchor map; 5% royalty. The character runs the SHARED rules
// engine — registration is attribution + roster membership, not game logic.
// AUTHORIZED MINTING: if `creatorAddress` (a valid XRPL r-address) is supplied, we mint with
// Issuer = that address, so the on-ledger TransferFee (resale royalty) routes to the CREATOR, not the
// platform. Precondition: the creator must first authorize our issuer as their NFTokenMinter (one-time
// AccountSet — see GET /minter-info). Without creatorAddress we fall back to a platform-issuer mint
// (royalty supports the project). This is the partition model: characters → creator royalty.
app.post('/register-character', requireAdmin, async (req, res) => {
  const { creator, name, collection, sha256, anchorsHash, creatorAddress } = req.body || {};
  if (!creator || !name || !sha256) return res.status(400).json({ error: 'creator, name, sha256 required' });
  if (creatorAddress && !xrpl.isValidClassicAddress(creatorAddress))
    return res.status(400).json({ error: 'creatorAddress is not a valid XRPL r-address' });
  const authorized = Boolean(creatorAddress);
  try {
    const out = await withClient(async (c, w) => {
      const meta = { t: 'char', n: String(name).slice(0, 32), a: String(creator).slice(0, 32),
        col: String(collection || '').slice(0, 32), h: String(sha256).slice(0, 64),
        x: String(anchorsHash || '').slice(0, 16), r: ROYALTY_BPS };
      if (authorized) meta.iss = creatorAddress;                 // royalty recipient (the creator)
      if (Buffer.byteLength(JSON.stringify(meta)) > 256) { meta.col = meta.col.slice(0, 16); meta.h = meta.h.slice(0, 32); }
      const tx = { TransactionType: 'NFTokenMint', Account: w.classicAddress,
        NFTokenTaxon: CHARACTER_TAXON, Flags: TF_TRANSFERABLE, TransferFee: ROYALTY_BPS, URI: hex(JSON.stringify(meta)) };
      if (authorized) tx.Issuer = creatorAddress;                // authorized mint: TransferFee → creator
      const r = (await c.submitAndWait(w.sign(await c.autofill(tag(tx))).tx_blob)).result;
      return { result: r.meta.TransactionResult, nid: r.meta.nftoken_id, meta,
        royaltyTo: authorized ? 'creator' : 'project',
        royaltyRecipient: authorized ? creatorAddress : w.classicAddress };
    });
    // authorized mint fails closed if the creator hasn't authorized us as their NFTokenMinter yet
    if (authorized && out.result === 'tecNO_PERMISSION') {
      const ourIssuer = await withClient(async (c, w) => w.classicAddress);
      return res.status(409).json({ error: 'authorized-mint not permitted yet', result: out.result, ourIssuer,
        fix: `Creator ${creatorAddress} must first run an AccountSet (from their own wallet) with SetFlag 10 (asfAuthorizedNFTokenMinter) and NFTokenMinter = ${ourIssuer}, then retry. See GET /minter-info.` });
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// minter-info: the one-time AccountSet a creator runs (from THEIR wallet) to authorize Ledgerlings to
// mint as them — so their character's resale royalty routes to THEM. Then register with creatorAddress.
app.get('/minter-info', async (req, res) => {
  try {
    const ourIssuer = await withClient(async (c, w) => w.classicAddress);
    res.json({ ourIssuer,
      instructions: 'From your own wallet, submit the accountSet below (one-time). Then POST /register-character with creatorAddress = your address. Your 5% resale royalty will route to you.',
      accountSet: { TransactionType: 'AccountSet', SetFlag: 10, NFTokenMinter: ourIssuer } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// roster: every registered character (= issuer NFTs at CHARACTER_TAXON). Persistent on-ledger, no DB.
app.get('/roster', async (req, res) => {
  try {
    const out = await withClient(async (c, w) => {
      const r = await c.request({ command: 'account_nfts', account: w.classicAddress, limit: 400 });
      return r.result.account_nfts
        .filter(n => n.NFTokenTaxon === CHARACTER_TAXON && n.URI)
        .map(n => { try { return { nid: n.NFTokenID, ...JSON.parse(unhex(n.URI)) }; } catch { return null; } })
        .filter(Boolean);
    });
    res.json({ characters: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- P2: brokered primary sale (platform's atomic cut, no custody) ----
// Flow: artist lists (sell offer, destination-locked to the platform broker) -> buyer offers price+brokerFee
// (buy offer) -> platform NFTokenAcceptOffer matches both with NFTokenBrokerFee = the spread. Seller (artist)
// receives buy.Amount - BrokerFee = the price; platform keeps the fee; buyer gets the NFT — atomic, no custody.
// Artist must own the pet first (delivered post-mint). Offers returned UNSIGNED for Xaman signing.
const brokerFeeDrops = priceDrops => String(Math.floor(Number(priceDrops) * BROKER_FEE_BPS / 10000));

app.get('/broker-info', async (req, res) => {
  try {
    const broker = await withClient(async (c, w) => w.classicAddress);
    res.json({ broker, brokerFeeBps: BROKER_FEE_BPS, royaltyBps: ROYALTY_BPS });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// artist lists a pet for primary sale -> UNSIGNED sell offer (artist signs via Xaman), locked to the broker.
app.post('/list-pet', async (req, res) => {
  const { artist, nftId, priceXrp } = req.body || {};
  if (!artist || !nftId || !priceXrp) return res.status(400).json({ error: 'artist, nftId, priceXrp required' });
  if (!xrpl.isValidClassicAddress(artist)) return res.status(400).json({ error: 'invalid artist address' });
  try {
    const broker = await withClient(async (c, w) => w.classicAddress);
    const tx = tag({ TransactionType: 'NFTokenCreateOffer', Account: artist, NFTokenID: nftId,
      Amount: xrpl.xrpToDrops(priceXrp), Flags: 1 /* tfSellNFToken */, Destination: broker });
    res.json({ unsignedTx: tx, signWith: 'artist (Xaman)', note: 'sell offer locked to the platform broker' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// buyer offer for a listed pet -> UNSIGNED buy offer for price + broker fee (buyer signs via Xaman).
app.post('/buy-pet', (req, res) => {
  const { buyer, artist, nftId, priceXrp } = req.body || {};
  if (!buyer || !artist || !nftId || !priceXrp) return res.status(400).json({ error: 'buyer, artist, nftId, priceXrp required' });
  if (!xrpl.isValidClassicAddress(buyer) || !xrpl.isValidClassicAddress(artist))
    return res.status(400).json({ error: 'invalid buyer/artist address' });
  const priceDrops = xrpl.xrpToDrops(priceXrp);
  const fee = brokerFeeDrops(priceDrops);
  const total = String(Number(priceDrops) + Number(fee));
  const tx = tag({ TransactionType: 'NFTokenCreateOffer', Account: buyer, Owner: artist, NFTokenID: nftId, Amount: total });
  res.json({ unsignedTx: tx, signWith: 'buyer (Xaman)', priceDrops, brokerFeeDrops: fee, totalDrops: total });
});

// platform matches a sell + buy offer, keeping NFTokenBrokerFee = the spread. Admin-signed, atomic, no custody.
app.post('/broker-sale', requireAdmin, async (req, res) => {
  const { sellOffer, buyOffer, brokerFeeDrops: fee } = req.body || {};
  if (!sellOffer || !buyOffer || !fee) return res.status(400).json({ error: 'sellOffer, buyOffer, brokerFeeDrops required' });
  try {
    const result = await withClient((c, w) => submit(c, w, { TransactionType: 'NFTokenAcceptOffer',
      Account: w.classicAddress, NFTokenSellOffer: sellOffer, NFTokenBuyOffer: buyOffer, NFTokenBrokerFee: String(fee) }));
    res.json({ result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Issuer poller: auto-applies signed interactions (no operator in the loop) ----
// A pet's correct state = replay(its on-ledger history). The poller reconciles each pet to that replay:
// if the on-ledger URI differs, it NFTokenModifies to the derived state + auto-awards badges. Idempotent
// (no-op once matched) and self-healing (actively enforces the same property /verify checks).
async function reconcilePet(c, w, nid) {
  const { current, genesis, interactions } = await loadHistory(c, w.classicAddress, nid);
  if (!genesis || !current) return { nid, updated: false };
  const derived = replay(genesis, interactions);
  if (enc(derived) === enc(current)) return { nid, updated: false };
  await submit(c, w, { TransactionType: 'NFTokenModify', Account: w.classicAddress, NFTokenID: nid, URI: enc(derived) });
  if (AUTO_AWARD) { try { await claimAchievements(c, w, nid); } catch { /* badge mint best-effort */ } }
  return { nid, updated: true, state: derived };
}
let pollerLastLedger = 0;
// ── ladder auto-resolution ───────────────────────────────────────────────────────────────────────
// A ladder challenge is a player-signed Payment carrying "ladder|aNid|rung|N". The fight can only be
// settled once ledger N is validated, because N's hash is the unriggable seed. Nothing resolved them
// before: /battle/resolve is requireAdmin, and the poller ignored battle memos, so a player could
// start a fight that no one could finish. resolveBattleTx is idempotent (it returns ALREADY_RESOLVED
// when a result memo exists), so calling it from the poller cannot double-settle or double-pay.
const pendingLadder = new Map();                       // battleId (tx hash) -> pinned ledger N
// Fight Club (PvP) needs the same treatment or it never finishes: /battle/resolve is requireAdmin and
// resolvePendingLadders only ever sees 'ladder' memos, so a PvP fight would sit LIVE forever. Registered
// on the ACCEPT, not the challenge, because the seed ledger is acceptLseq + BATTLE_LEDGER_MARGIN.
const pendingPvp = new Map();                          // battleId (from the accept memo) -> seed ledger N

function noteLadderChallenge(tx, hash, lseq) {
  for (const mm of (tx.Memos || [])) {
    const md = mm.Memo || {};
    try {
      if (unhex(md.MemoType || '') !== BATTLE_MEMO) continue;
      const f = unhex(md.MemoData || '').split('|');
      if (f[0] === 'ladder') {
        if (!hash) continue;
        const N = Number(f[3]);
        if (Number.isInteger(N)) pendingLadder.set(hash, N);
      } else if (f[0] === 'ghost') {
        // Ghost fights ride the ladder poller: one commitment, seed derived from the landing ledger.
        // The gate is stored as the real seed ledger rather than the memo's margin, so the poller
        // waits for the right ledger instead of relying on the resolver to keep erroring.
        if (!hash || !Number.isInteger(Number(lseq))) continue;
        pendingLadder.set(hash, Number(lseq) + BATTLE_LEDGER_MARGIN);
      } else if (f[0] === 'accept') {
        // separate map on purpose: a ladder battleId keys its own pinned N, a PvP one keys a seed
        // ledger derived from where the ACCEPT landed.
        const bid = String(f[1] || '');
        if (!/^[0-9A-F]{64}$/.test(bid.toUpperCase()) || !Number.isInteger(Number(lseq))) continue;
        // FIRST accept only. This was a plain .set on the same key, so every later accept memo pushed
        // the poller's own resolution ledger 20 further into the future — a loser who did not like the
        // outcome could postpone settlement indefinitely for a drop a time, and the map moved in step
        // with the seed ledger it was meant to pin. The value is only a lower bound on when it is worth
        // scanning: resolveBattleTx derives the real seed ledger itself and returns the transient
        // 'pinned ledger not validated yet' until it has closed, so an early entry is harmless.
        if (!pendingPvp.has(bid)) pendingPvp.set(bid, Number(lseq) + BATTLE_LEDGER_MARGIN);
      }
    } catch { /* skip malformed memo */ }
  }
}

async function resolvePendingLadders(c, w) {
  if (!pendingLadder.size) return 0;
  const cur = (await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index;
  let done = 0;
  for (const [battleId, N] of [...pendingLadder]) {
    if (cur < N) continue;                             // seed ledger not validated yet
    try {
      const r = await resolveBattleTx(c, w, battleId);
      // Keep retrying only the genuinely transient case; drop everything else so a permanently
      // broken challenge cannot be retried every six seconds forever.
      if (r && r.error === 'pinned ledger not validated yet') continue;
      pendingLadder.delete(battleId);
      done++;
      console.log(`[poller] ladder ${battleId.slice(0, 8)} -> ${r && (r.status || r.winnerNid || 'resolved')}`);
    } catch (e) { console.warn('[poller] ladder', battleId.slice(0, 8), e.message); }
  }
  return done;
}

// Same machinery for PvP. resolveBattleTx is idempotent (ALREADY_RESOLVED when a result memo exists),
// so this cannot double-settle or double-pay even if an accept is registered twice.
async function resolvePendingPvp(c, w) {
  if (!pendingPvp.size) return 0;
  const cur = (await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index;
  let done = 0;
  for (const [battleId, N] of [...pendingPvp]) {
    if (cur < N) continue;                             // seed ledger not validated yet
    try {
      const r = await resolveBattleTx(c, w, battleId);
      if (r && r.error === 'pinned ledger not validated yet') continue;   // the only transient case
      pendingPvp.delete(battleId);
      done++;
      console.log(`[poller] pvp ${battleId.slice(0, 8)} -> ${r && (r.status || r.winnerNid || 'resolved')}`);
    } catch (e) { console.warn('[poller] pvp', battleId.slice(0, 8), e.message); }
  }
  return done;
}

// Pick up challenges signed while this process was not running, so a restart does not strand a fight.
async function scanOpenLadders(c, issuer, backLedgers = 8000) {
  const cur = (await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index;
  let marker, seen = 0;
  do {
    const r = await c.request({ command: 'account_tx', account: issuer,
      ledger_index_min: Math.max(0, cur - backLedgers), ledger_index_max: -1, forward: true, limit: 200, marker });
    for (const t of r.result.transactions) {
      const tx = t.tx || t.tx_json || {};
      if (tx.TransactionType !== 'Payment' || tx.Destination !== issuer) continue;
      // registers ladder challenges AND PvP accepts, so a restart mid-fight does not strand either.
      noteLadderChallenge(tx, t.hash || tx.hash, tx.ledger_index || t.ledger_index);
    }
    seen += r.result.transactions.length;
    marker = r.result.marker;
  } while (marker);
  return pendingLadder.size;
}

async function pollerTick(c, w) {
  const issuer = w.classicAddress; const affected = new Set(); let marker;
  do {
    const r = await c.request({ command: 'account_tx', account: issuer, ledger_index_min: pollerLastLedger + 1, ledger_index_max: -1, forward: true, limit: 200, marker });
    for (const t of r.result.transactions) {
      const tx = t.tx || t.tx_json || {}; const lseq = tx.ledger_index || t.ledger_index;
      if (lseq && lseq > pollerLastLedger) pollerLastLedger = lseq;
      if (tx.TransactionType === 'Payment' && tx.Destination === issuer) {
        noteLadderChallenge(tx, t.hash || tx.hash, lseq);
        for (const mm of (tx.Memos || [])) { const md = mm.Memo || {}; try { if (unhex(md.MemoType || '') === 'ledgerlings/op') { const p = unhex(md.MemoData || '').split('|'); if (p[1]) affected.add(p[1]); } } catch { /* skip */ } }
      }
    }
    marker = r.result.marker;
  } while (marker);
  for (const nid of affected) { try { await reconcilePet(c, w, nid); } catch (e) { console.warn('[poller] reconcile', nid.slice(0, 8), e.message); } }
  try { await resolvePendingLadders(c, w); } catch (e) { console.warn('[poller] ladders', e.message); }
  try { await resolvePendingPvp(c, w); } catch (e) { console.warn('[poller] pvp', e.message); }
  return affected.size;
}
async function startPoller() {
  if (!ISSUER_SEED) { console.warn('[poller] disabled — no LEDGERLINGS_ISSUER_SEED'); return; }
  const c = new xrpl.Client(ENDPOINT); await c.connect();
  const w = walletFromSeed(ISSUER_SEED); if (ISSUER_ADDRESS) w.classicAddress = ISSUER_ADDRESS;
  // catch up every existing pet once, then only react to new interactions.
  const pets = (await allIssuerNfts(c, w.classicAddress)).filter(n => n.NFTokenTaxon === TAXON);
  for (const n of pets) { try { await reconcilePet(c, w, n.NFTokenID); } catch (e) { console.warn('[poller] init', e.message); } }
  pollerLastLedger = (await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index;
  let openLadders = 0;
  try { openLadders = await scanOpenLadders(c, w.classicAddress); } catch (e) { console.warn('[poller] ladder scan', e.message); }
  console.log(`[poller] watching ${w.classicAddress}; caught up ${pets.length} pet(s); ${openLadders} open ladder challenge(s); ${pendingPvp.size} open pvp accept(s); tracking from ledger ${pollerLastLedger}`);
  try { await resolvePendingLadders(c, w); } catch (e) { console.warn('[poller] ladders', e.message); }
  try { await resolvePendingPvp(c, w); } catch (e) { console.warn('[poller] pvp', e.message); }
  const loop = async () => {
    try { if (!c.isConnected()) await c.connect(); await pollerTick(c, w); }
    catch (e) { console.warn('[poller] tick', e.message); }
    setTimeout(loop, 6000);
  };
  setTimeout(loop, 6000);
}

// ---- Shareable pet card + public gallery (the viral loop) ----
const APP_URL = process.env.APP_URL || 'https://hugegreencandle.github.io/ledgerlings/';
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const shortNid = nid => `${String(nid).slice(0, 6)}…${String(nid).slice(-4)}`;
function careRatio(s) { return s.care_max > 0 ? Math.max(0, Math.min(1, s.care / s.care_max)) : 0; }
// dep-free SVG card (600x315, X-card ratio) — a little bear-ish Ledgerling colored by health, aura by rarity/form.
function genCardSvg(s, nid) {
  const stage = R.STAGE[s.stage] || 'egg', form = R.FORM[s.form] || '-';
  const dead = s.alive === 0;
  const body = dead ? '#5b6b72' : `hsl(${Math.round((s.health || 0) * 1.2)},62%,58%)`;
  const aura = s.form === 4 ? '#ffd24a' : s.form === 3 ? '#c98cff' : s.form === 2 ? '#6ff0ff' : '#3fae86';
  const scale = 0.55 + Math.min(4, s.stage) * 0.11;
  const cx = 165, cy = 150;
  const pct = Math.round(careRatio(s) * 100);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="315" viewBox="0 0 600 315">
  <defs><radialGradient id="bg" cx="30%" cy="35%" r="90%"><stop offset="0%" stop-color="#0e3a4a"/><stop offset="100%" stop-color="#05141a"/></radialGradient></defs>
  <rect width="600" height="315" fill="url(#bg)"/>
  <circle cx="${cx}" cy="${cy}" r="${92 * scale}" fill="none" stroke="${aura}" stroke-width="3" opacity="0.6"/>
  <g transform="translate(${cx},${cy}) scale(${scale})">
    <circle cx="-42" cy="-52" r="22" fill="${body}"/><circle cx="42" cy="-52" r="22" fill="${body}"/>
    <circle cx="0" cy="0" r="70" fill="${body}"/>
    <circle cx="-26" cy="-8" r="9" fill="#0b1e26"/><circle cx="26" cy="-8" r="9" fill="#0b1e26"/>
    <ellipse cx="0" cy="20" rx="14" ry="10" fill="#0b1e26"/>
    ${dead ? '<text x="0" y="-2" font-size="34" text-anchor="middle" fill="#0b1e26">✕</text>' : ''}
  </g>
  <text x="315" y="70" font-family="system-ui,sans-serif" font-size="30" font-weight="700" fill="#6ff0ff">${esc((s.name || 'Ledgerling').slice(0, 24))}</text>
  <text x="315" y="100" font-family="monospace" font-size="15" fill="#8fb3bd">${esc(shortNid(nid))}</text>
  <text x="315" y="146" font-family="system-ui,sans-serif" font-size="20" fill="#eaf6f9">${esc(stage)}${dead ? ' · passed' : ''}</text>
  <text x="315" y="174" font-family="system-ui,sans-serif" font-size="17" fill="${aura}">form: ${esc(form)}</text>
  <text x="315" y="206" font-family="system-ui,sans-serif" font-size="15" fill="#8fb3bd">care ${s.care} · quality ${pct}%</text>
  <text x="315" y="250" font-family="system-ui,sans-serif" font-size="15" fill="#7CFFB2">✅ provably fair — verify on XRPL</text>
  <text x="315" y="286" font-family="system-ui,sans-serif" font-size="13" fill="#5f7d86">Ledgerlings · a pet you can audit</text>
</svg>`;
}
// ---- PNG rendering -----------------------------------------------------------------------------
// X, Discord, Slack, LinkedIn and Facebook all refuse to rasterise SVG, so every og:image this
// project has ever emitted previewed as a blank box — including the launch post. These render the
// same cards to PNG.
//
// TWO THINGS THAT WILL BREAK THIS IF CHANGED CARELESSLY:
//  1. The font is BUNDLED and loadSystemFonts is false. Railway containers have essentially no
//     fonts, so relying on the host would render every glyph blank there while looking perfect on
//     a Mac. The font is an npm dependency (DejaVu, OFL licensed) rather than a committed binary.
//  2. ONE UNSUPPORTED GLYPH TOFUS THE ENTIRE <text> ELEMENT, not just that character. Measured:
//     "with emoji ✅ here" rendered as 17 empty boxes. So anything going into a PNG is passed
//     through pngSafe() first. ✓ → · – are all present in DejaVu; emoji are not.
// FONT LOADING IS RESOLVED AT RUNTIME BY MEASUREMENT, NOT BY ASSUMPTION.
//
// This has now failed in production twice, both times rendering cards with a background, panels,
// and ZERO text while returning a perfectly valid HTTP 200 PNG of the right dimensions. First guess
// was the format (woff2 needing brotli); switching to TTF did not fix it, so that diagnosis was
// wrong. The honest position is that the linux-x64 resvg build and the darwin-arm64 one do not
// accept fonts by the same route, and this environment cannot be reproduced locally.
//
// So instead of a third guess: try each way of supplying the font, RENDER A TEST STRING with each,
// and keep the first one that actually puts ink on the canvas. Whatever the cause, the server finds
// the working configuration by itself on any host.
//
// The probe checks ALL THREE font families the cards actually use, not just one. genCardSvg asks
// for "system-ui,sans-serif" and "monospace" while the fight card asks for "DejaVu Sans" — a config
// that resolves the explicit name but not the generic ones would render the fight card and blank
// half the pet card, which is exactly the sort of partial failure that reads as success.
const FONT_FAMILY = 'DejaVu Sans';
let FONT_FILE = null, FONT_MODE = null, FONT_OPTS = null, PNG_STATUS = 'unprobed', FONT_RESOLVED = false;

function fontFamilyMap() {
  // Map every generic the SVGs use onto the one font we ship, so "system-ui,sans-serif" and
  // "monospace" resolve instead of silently falling through to nothing.
  return { defaultFontFamily: FONT_FAMILY, sansSerifFamily: FONT_FAMILY, serifFamily: FONT_FAMILY,
           monospaceFamily: FONT_FAMILY, cursiveFamily: FONT_FAMILY, fantasyFamily: FONT_FAMILY };
}

// Does this option set put ink on the canvas for every family the cards use?
function inksFor(opts) {
  const { Resvg } = require('@resvg/resvg-js');
  for (const fam of ['DejaVu Sans', 'system-ui,sans-serif', 'monospace']) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="40">`
      + `<rect width="140" height="40" fill="#000"/>`
      + `<text x="4" y="28" font-family="${fam}" font-size="20" fill="#fff">Ag1</text></svg>`;
    let px;
    try { px = new Resvg(svg, { font: opts }).render().pixels; } catch { return false; }
    const seen = new Set();
    for (let i = 0; i < px.length; i += 4) seen.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
    if (seen.size <= 2) return false;      // background only: this family drew nothing
  }
  return true;
}

function resolveFont() {
  if (FONT_RESOLVED) return FONT_OPTS;
  FONT_RESOLVED = true;
  const fam = fontFamilyMap();
  let p = null, buf = null;
  try {
    p = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
    FONT_FILE = p.split('/').slice(-1)[0];
    buf = require('fs').readFileSync(p);
  } catch (e) {
    console.error('[png] bundled font not found:', e.message);
  }
  const dir = p ? p.split('/').slice(0, -1).join('/') : null;
  // Ordered by how explicit they are. fontFiles first: it is the plainest instruction, and
  // fontBuffers is the one that demonstrably works on darwin and produced blank text on linux.
  const candidates = [
    p && { mode: 'fontFiles', opts: { ...fam, loadSystemFonts: false, fontFiles: [p] } },
    dir && { mode: 'fontDirs', opts: { ...fam, loadSystemFonts: false, fontDirs: [dir] } },
    buf && { mode: 'fontBuffers', opts: { ...fam, loadSystemFonts: false, fontBuffers: [buf] } },
    p && { mode: 'fontFiles+system', opts: { ...fam, loadSystemFonts: true, fontFiles: [p] } },
    { mode: 'systemFonts', opts: { ...fam, loadSystemFonts: true } },
  ].filter(Boolean);

  const tried = [];
  for (const c of candidates) {
    let ok = false;
    try { ok = inksFor(c.opts); } catch { ok = false; }
    tried.push(`${c.mode}:${ok ? 'ok' : 'blank'}`);
    if (ok) {
      FONT_MODE = c.mode; FONT_OPTS = c.opts; PNG_STATUS = 'ok';
      console.log(`[png] font ok via ${c.mode} (${FONT_FILE || 'system'}) — tried ${tried.join(' ')}`);
      return FONT_OPTS;
    }
  }
  PNG_STATUS = p ? 'blank-text' : 'font-missing';
  FONT_MODE = 'none';
  console.error(`[png] NO FONT CONFIGURATION RENDERS TEXT — every card will be blank. tried ${tried.join(' ')}`);
  return null;
}
function pngStatus() { resolveFont(); return PNG_STATUS; }
// Map the emoji this codebase actually uses onto glyphs DejaVu HAS. Verified by rendering and
// looking at the output: ✓ (2713), ✕ (2715), → (2192) and · (00B7) all rasterise correctly, so the
// substitution keeps meaning rather than deleting it. Do NOT widen this into a blanket strip of
// U+2600-27BF — that block contains ✓ and ✕, and removing them silently blanked the dead pet's face.
const EMOJI_SUBS = [
  [/✅/g, '✓'], [/❌/g, '✕'], [/⚔️?/g, ''], [/🏆/g, ''], [/🥊/g, ''],
  [/🐣/g, ''], [/🔎/g, ''], [/👑/g, ''], [/💥/g, ''], [/🥚/g, ''], [/⚠️?/g, '!'],
];
function pngSafe(str) {
  let s = String(str);
  for (const [re, to] of EMOJI_SUBS) s = s.replace(re, to);
  // Whatever is left: drop astral-plane emoji and variation selectors only. One unsupported glyph
  // tofus its entire <text> element, so this is a correctness measure, not a cosmetic one.
  return s.replace(/[\u{1F000}-\u{1FAFF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu, '');
}
// resvg-js ignores `fitTo` in this version — width, zoom and original all returned the native size
// when measured. So scale by rewriting the root <svg> width/height instead; the viewBox is already
// present on both cards, so the geometry scales cleanly.
function scaleSvg(svg, toWidth) {
  const m = svg.match(/<svg[^>]*\swidth="(\d+)"[^>]*\sheight="(\d+)"/);
  if (!m || !toWidth) return svg;
  const w = Number(m[1]), h = Number(m[2]);
  if (!w || w >= toWidth) return svg;
  const nh = Math.round(h * (toWidth / w));
  return svg.replace(/(<svg[^>]*\s)width="\d+"([^>]*\s)height="\d+"/, `$1width="${toWidth}"$2height="${nh}"`);
}
function svgToPng(svg, width) {
  // Whichever supply route was measured to actually draw glyphs on THIS host. Null means none of
  // them did, and the routes return 503 rather than serving a picture with no text in it.
  const font = resolveFont();
  if (!font) return null;
  const { Resvg } = require('@resvg/resvg-js');
  return new Resvg(pngSafe(scaleSvg(svg, width)), { font }).render().asPng();
}

app.get('/card/:nid.png', async (req, res) => {
  try {
    const s = await withClient((c, w) => readState(c, w.classicAddress, req.params.nid));
    if (!s) return res.status(404).type('text/plain').send('pet not found');
    const png = svgToPng(genCardSvg(s, req.params.nid), 1200);
    if (!png) return res.status(503).type('text/plain').send('png rendering unavailable');
    res.type('image/png').set('Cache-Control', 'public, max-age=300').send(png);
  } catch (e) { res.status(500).type('text/plain').send('error'); }
});

app.get('/card/:nid.svg', async (req, res) => {
  try {
    const s = await withClient((c, w) => readState(c, w.classicAddress, req.params.nid));
    if (!s) return res.status(404).type('text/plain').send('pet not found');
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=60').send(genCardSvg(s, req.params.nid));
  } catch (e) { res.status(500).type('text/plain').send(e.message); }
});
// public gallery — all living pets ranked by care (best-cared first). No login.
app.get('/gallery', async (req, res) => {
  try {
    const out = await withClient(async (c, w) => (await allIssuerNfts(c, w.classicAddress))
      .filter(n => n.NFTokenTaxon === TAXON && n.URI)
      .map(n => { let s; try { s = dec(n.URI); } catch { return null; } return s && { nid: n.NFTokenID, owner: s.owner, stage: R.STAGE[s.stage] || s.stage, form: R.FORM[s.form] || '-', formId: s.form, care: s.care, quality: Math.round(careRatio(s) * 100), health: s.health, alive: s.alive }; })
      .filter(Boolean));
    out.sort((a, b) => (b.alive - a.alive) || (b.care - a.care) || (b.formId - a.formId));
    res.set('Cache-Control', 'public, max-age=30').json({ count: out.length, pets: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Opponents available to fight as a GHOST. Unlike /gallery this PROJECTS each pet to the current
// ledger before deciding whether it is alive, because the stored URI is only accurate as of the
// owner's last transaction: a pet nobody has touched reads alive with full stats forever. Listing
// those as opponents would offer fights that resolve to VOID, and would show a starving pet at the
// strength it had days ago.
//
// `owner` is optional and only used to hide your own pets — the list itself is public, like the
// gallery and the board.
app.get('/ghosts', async (req, res) => {
  try {
    const owner = String(req.query.owner || '');
    const out = await withClient(async (c, w) => {
      const cur = (await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index;
      return (await allIssuerNfts(c, w.classicAddress))
        .filter(n => n.NFTokenTaxon === TAXON && n.URI)
        .map(n => {
          let s; try { s = dec(n.URI); } catch { return null; }
          if (!s) return null;
          const p = projectTo(s, cur);                       // same call the resolver and verifier use
          if (!p || p.alive === 0) return null;              // a passed pet cannot be fought
          if (owner && p.owner === owner) return null;       // your own pets are not opponents
          return { nid: n.NFTokenID, name: p.name || null, owner: p.owner,
            stage: R.STAGE[p.stage] || p.stage, form: R.FORM[p.form] || '-',
            power: BR.power(p), care: p.care, quality: Math.round(careRatio(p) * 100),
            health: p.health, hunger: p.hunger, happiness: p.happiness };
        })
        .filter(Boolean);
    });
    // Strongest first: picking an opponent is the only real decision in a ghost fight, so the list
    // has to make the trade-off legible rather than hiding it behind an arbitrary order.
    out.sort((a, b) => (b.power - a.power) || (b.care - a.care));
    res.set('Cache-Control', 'public, max-age=15').json({ count: out.length, asOfProjected: true, ghosts: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// public gallery page — best-cared leaderboard grid, each linking to its shareable pet page. No login.
app.get('/gallery.html', (req, res) => {
  res.type('text/html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Ledgerlings — Gallery</title>
<meta name="description" content="Every Ledgerling, ranked by care. Provably fair on the XRPL.">
<style>body{margin:0;background:#05141a;color:#eaf6f9;font-family:system-ui,sans-serif}
.wrap{max-width:1000px;margin:0 auto;padding:24px}h1{color:#6ff0ff;margin:0}
.sub{color:#8fb3bd;margin:6px 0 18px}a.cta{display:inline-block;margin:0 0 18px;padding:11px 18px;border-radius:10px;
border:1px solid #6ff0ff;background:#0e3a4a;color:#6ff0ff;text-decoration:none}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
.card{border:1px solid #14414f;border-radius:14px;overflow:hidden;text-decoration:none;color:inherit;background:#08222b;transition:transform .1s}
.card:hover{transform:translateY(-2px);border-color:#6ff0ff}.card img{width:100%;display:block}
.meta{padding:10px 12px;font-size:13px;color:#8fb3bd}.meta b{color:#6ff0ff}.rank{color:#ffd24a;font-weight:700}</style></head>
<body><div class="wrap"><h1>🏆 Ledgerlings Gallery</h1>
<div class="sub">Every pet, ranked by care. Each one's whole life re-derives from the XRPL — click through and verify.</div>
<a class="cta" href="${esc(APP_URL)}">🐾 Adopt your own Ledgerling</a>
<div id="grid" class="grid"></div>
<script>fetch('/gallery').then(r=>r.json()).then(d=>{
  const g=document.getElementById('grid');
  if(!d.pets||!d.pets.length){g.innerHTML='<div style="color:#8fb3bd">No pets yet — be the first to adopt.</div>';return;}
  g.innerHTML=d.pets.slice(0,60).map((p,i)=>'<a class=card href="/p/'+p.nid+'"><img loading=lazy src="/card/'+p.nid+'.svg" alt="Ledgerling"><div class=meta><span class=rank>#'+(i+1)+'</span> · <b>'+p.stage+'</b>'+(p.form!=='-'?' · '+p.form:'')+'<br>care <b>'+p.care+'</b> · quality <b>'+p.quality+'%</b>'+(p.alive?'':' · passed')+'</div></a>').join('');
}).catch(e=>{document.getElementById('grid').textContent='Could not load the gallery.';});</script>
</div></body></html>`);
});

// public shareable pet page — OG preview (the card), live stats, Verify, and an Adopt CTA. No login.
app.get('/p/:nid', async (req, res) => {
  try {
    const nid = req.params.nid;
    const s = await withClient((c, w) => readState(c, w.classicAddress, nid));
    if (!s) return res.status(404).type('text/html').send('<h1>Ledgerling not found</h1>');
    const stage = R.STAGE[s.stage] || 'egg', form = R.FORM[s.form] || '-';
    const base = `${req.protocol}://${req.get('host')}`;
    // PNG, not SVG: no social platform rasterises SVG, so the previous og:image previewed blank
    // everywhere it was ever posted. The .svg route stays for the gallery's inline <img> tags.
    const card = `${base}/card/${esc(nid)}.png`;
    const title = `Ledgerling ${shortNid(nid)} — ${esc(stage)}${s.form ? ' · ' + esc(form) : ''}`;
    const desc = `A provably-fair on-chain pet. care ${s.care} (${Math.round(careRatio(s) * 100)}%). Its whole life re-derives from the XRPL — verify it yourself.`;
    res.type('text/html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}"><meta property="og:image" content="${card}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${card}">
<style>body{margin:0;background:#05141a;color:#eaf6f9;font-family:system-ui,sans-serif;text-align:center}
.wrap{max-width:640px;margin:0 auto;padding:24px}img{max-width:100%;border-radius:14px;border:1px solid #14414f}
.stats{display:flex;gap:14px;justify-content:center;flex-wrap:wrap;margin:16px 0;color:#8fb3bd;font-size:14px}
.stats b{color:#6ff0ff}a.cta,button{display:inline-block;margin:8px 6px;padding:11px 18px;border-radius:10px;border:1px solid #6ff0ff;
background:#0e3a4a;color:#6ff0ff;text-decoration:none;cursor:pointer;font-size:15px}#vout{margin-top:14px;min-height:22px}
.ok{color:#7CFFB2}.bad{color:#ff6b6b}</style></head><body><div class="wrap">
<h1 style="color:#6ff0ff;margin-bottom:4px">Ledgerling</h1>
<div style="color:#5f7d86;font-family:monospace;font-size:13px;margin-bottom:14px">${esc(shortNid(nid))}</div>
<img src="${card}" alt="Ledgerling card">
<div class="stats"><span>stage <b>${esc(stage)}</b></span><span>form <b>${esc(form)}</b></span>
<span>care <b>${s.care}</b></span><span>quality <b>${Math.round(careRatio(s) * 100)}%</b></span>
<span>${s.alive ? 'health <b>' + s.health + '</b>' : '<b class="bad">passed</b>'}</span></div>
<button id="v">🔎 Verify this pet on-ledger</button>
<a class="cta" href="${esc(APP_URL)}">🐾 Adopt your own</a>
<a class="cta" href="/gallery.html">🏆 Gallery</a>
<div id="vout"></div>
<div style="color:#5f7d86;font-size:12px;margin-top:20px">Every feed, evolution and battle re-derives from XRPL ledger data under open rules. You don't trust the operator — you check.</div>
<script>document.getElementById('v').onclick=async()=>{const o=document.getElementById('vout');o.textContent='re-deriving from ledger history…';
try{const v=await(await fetch('/verify/${esc(nid)}')).json();o.innerHTML=v.verdict==='PASS'?'<span class=ok>✅ VERIFIED — '+v.interactions+' interactions reproduce from the open rules.</span>':v.verdict==='DIVERGED'?'<span class=bad>🚨 DIVERGED — does not match the open rules.</span>':'could not verify ('+(v.reason||'')+')';}catch(e){o.textContent='verify failed';}};</script>
</div></body></html>`);
  } catch (e) { res.status(500).type('text/html').send('error'); }
});

// The share image for a fight: 1200x630, the ratio every platform crops to. Deliberately contains
// no emoji (see pngSafe) and no glyph outside DejaVu's latin coverage. The point of the picture is
// the arithmetic — a stranger scrolling past should be able to read WHY somebody won without
// opening anything.
function genFightSvg(v) {
  const m = v.math || {};
  const nm = (x, fb) => esc(pngSafe(String(x || fb)).slice(0, 18));
  const aName = nm(v.names && v.names.a, v.nids && v.nids.a ? shortNid(v.nids.a) : 'Challenger');
  const bName = nm(v.names && v.names.b, v.nids && v.nids.b ? shortNid(v.nids.b) : 'Opponent');
  const aWon = m.scoreA > m.scoreB, drawn = m.scoreA === m.scoreB;
  const side = (x, name, roll, pow, score, won) => `
    <g transform="translate(${x},0)">
      <rect x="0" y="150" width="440" height="300" rx="18" fill="${won ? '#0c2e2a' : '#0a2430'}"
            stroke="${won ? '#7CFFB2' : '#14414f'}" stroke-width="${won ? 3 : 1}"/>
      <text x="220" y="205" font-family="DejaVu Sans" font-size="30" font-weight="700"
            text-anchor="middle" fill="${won ? '#7CFFB2' : '#eaf6f9'}">${name}</text>
      <text x="220" y="300" font-family="DejaVu Sans" font-size="66" font-weight="700"
            text-anchor="middle" fill="#eaf6f9">${score}</text>
      <text x="220" y="360" font-family="DejaVu Sans" font-size="26" text-anchor="middle" fill="#8fb3bd">
        <tspan fill="#6ff0ff">${roll}</tspan> + <tspan fill="#ffd479">${pow}</tspan></text>
      <text x="220" y="398" font-family="DejaVu Sans" font-size="17" text-anchor="middle"
            fill="#5f7d86">dice + upbringing</text>
    </g>`;
  const headline = drawn ? `${aName} drew with ${bName}`
    : `${aWon ? aName : bName} won ${Math.max(m.scoreA, m.scoreB)} - ${Math.min(m.scoreA, m.scoreB)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs><radialGradient id="bg" cx="50%" cy="30%" r="85%">
    <stop offset="0%" stop-color="#0e3a4a"/><stop offset="100%" stop-color="#05141a"/></radialGradient></defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <text x="600" y="88" font-family="DejaVu Sans" font-size="44" font-weight="700"
        text-anchor="middle" fill="#6ff0ff">${esc(headline)}</text>
  <text x="600" y="128" font-family="DejaVu Sans" font-size="21" text-anchor="middle" fill="#8fb3bd">
    ${v.ladder ? 'Ledgerlings ladder' : 'Ledgerlings Fight Club'}</text>
  ${side(90, aName, m.rollA, m.powerA, m.scoreA, aWon && !drawn)}
  <text x="600" y="315" font-family="DejaVu Sans" font-size="30" text-anchor="middle" fill="#5f7d86">vs</text>
  ${side(670, bName, m.rollB, m.powerB, m.scoreB, !aWon && !drawn)}
  <text x="600" y="512" font-family="DejaVu Sans" font-size="23" text-anchor="middle" fill="#7CFFB2">
    ✓ the dice were the hash of ledger ${esc(String(v.seedLedger || '?'))}</text>
  <text x="600" y="548" font-family="DejaVu Sans" font-size="19" text-anchor="middle" fill="#8fb3bd">
    which had not closed when the last player committed. Nobody could know this.</text>
  <text x="600" y="596" font-family="DejaVu Sans" font-size="17" text-anchor="middle" fill="#5f7d86">
    Ledgerlings · re-derive it yourself</text>
</svg>`;
}
app.get('/bcard/:battleId.png', async (req, res) => {
  try {
    const battleId = String(req.params.battleId || '').toUpperCase();
    if (!/^[0-9A-F]{64}$/.test(battleId)) return res.status(400).type('text/plain').send('bad id');
    const v = await withClient((c, w) => verifyBattle(c, w.classicAddress, battleId));
    if (!v || v.verdict === 'NOT_FOUND') return res.status(404).type('text/plain').send('no such fight');
    if (!v.math) return res.status(409).type('text/plain').send('fight not settled yet');
    const png = svgToPng(genFightSvg(v));
    if (!png) return res.status(503).type('text/plain').send('png rendering unavailable');
    res.type('image/png').set('Cache-Control', 'public, max-age=300').send(png);
  } catch (e) { res.status(500).type('text/plain').send('error'); }
});

// Public shareable FIGHT page. The battle already computes roll + power + score for both sides,
// writes them into an on-ledger memo and runs a public verifier against them — and until now none
// of it reached a human. This route is the destination a shared battleId points at: the two pets by
// name, the arithmetic spelled out, the seed ledger, and a re-check the reader runs themselves.
//
// It deliberately touches no transaction, no memo and no rule. A page cannot make a verifier
// diverge, which is why it is the one combat-facing change that is not a ruleset migration.
app.get('/b/:battleId', async (req, res) => {
  try {
    const battleId = String(req.params.battleId || '').toUpperCase();
    if (!/^[0-9A-F]{64}$/.test(battleId)) return res.status(400).type('text/html').send('<h1>Not a battle id</h1>');
    const v = await withClient((c, w) => verifyBattle(c, w.classicAddress, battleId));

    const base = `${req.protocol}://${req.get('host')}`;
    if (!v || v.verdict === 'NOT_FOUND')
      return res.status(404).type('text/html').send('<h1>No such fight</h1>');

    const m = v.math || {};
    const ladder = !!v.ladder;
    // A pet that was never named shows its short id rather than a blank, and the NPC keeps its name.
    const nameA = (v.names && v.names.a) || (v.nids && v.nids.a ? shortNid(v.nids.a) : 'Challenger');
    const nameB = (v.names && v.names.b) || (v.nids && v.nids.b ? shortNid(v.nids.b) : 'Opponent');
    const unresolved = v.verdict === 'UNRESOLVED';
    const aWon = !unresolved && m.scoreA > m.scoreB, drawn = !unresolved && m.scoreA === m.scoreB;
    const winName = drawn ? null : aWon ? nameA : nameB;

    const title = unresolved ? `A Ledgerlings fight is pending`
      : drawn ? `${nameA} drew with ${nameB}`
      : `${winName} won ${Math.max(m.scoreA, m.scoreB)}–${Math.min(m.scoreA, m.scoreB)}`;
    const desc = unresolved
      ? 'The dice come from a ledger that has not closed yet. Nobody can know this result — including the operator.'
      : `Rolled on ledger ${v.seedLedger}, whose hash did not exist when the last player committed. Re-check it yourself.`;
    // og:image points at the WINNER's card. It is an SVG, which X and Discord will not rasterise, so
    // this preview is still a blank box on most platforms — a PNG renderer is the known next step and
    // is deliberately not faked here.
    // Only a real pet has a card. A ladder NPC's "nid" is the synthetic 'NPC:<id>', so fall back to
    // the human's pet rather than emitting /card/NPC:runt.svg, which would 404 into a broken preview.
    const rawWinNid = v.nids ? (aWon ? v.nids.a : v.nids.b) : null;
    const cardNid = /^[0-9A-F]{64}$/i.test(String(rawWinNid || '')) ? rawWinNid
      : (v.nids && /^[0-9A-F]{64}$/i.test(String(v.nids.a || '')) ? v.nids.a : null);
    // A settled fight gets the fight card, which shows the actual arithmetic. An unsettled one has
    // no numbers to show, so it falls back to the challenger's pet. PNG in both cases: no platform
    // rasterises SVG, so an SVG og:image is the same as having none.
    const card = !unresolved ? `${base}/bcard/${esc(battleId)}.png`
      : cardNid ? `${base}/card/${esc(cardNid)}.png` : '';

    const row = (nm, roll, pow, score, won) => `<div class="side${won ? ' win' : ''}">
      <div class="nm">${esc(nm)}${won ? ' <span class="crown">👑</span>' : ''}</div>
      <div class="sum"><span class="roll">${roll}</span> <span class="op">+</span> <span class="pow">${pow}</span>
        <span class="op">=</span> <b class="score">${score}</b></div>
      <div class="lbl">dice + upbringing = score</div></div>`;

    res.type('text/html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Ledgerlings</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">${card ? `<meta property="og:image" content="${card}">` : ''}
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">${card ? `<meta name="twitter:image" content="${card}">` : ''}
<style>body{margin:0;background:#05141a;color:#eaf6f9;font-family:system-ui,sans-serif}
.wrap{max-width:640px;margin:0 auto;padding:24px;text-align:center}
h1{color:#6ff0ff;font-size:22px;margin:0 0 2px}.sub{color:#5f7d86;font-size:13px;margin-bottom:18px}
.bout{display:flex;gap:10px;align-items:stretch;justify-content:center;margin:18px 0}
.side{flex:1;background:#0a2430;border:1px solid #14414f;border-radius:12px;padding:14px 8px}
.side.win{border-color:#7CFFB2;background:#0c2e2a}
.nm{font-weight:600;font-size:15px;margin-bottom:8px;word-break:break-word}
.sum{font-family:ui-monospace,Menlo,monospace;font-size:15px}
.roll{color:#6ff0ff}.pow{color:#ffd479}.op{color:#5f7d86}.score{color:#eaf6f9;font-size:19px}
.lbl{color:#5f7d86;font-size:11px;margin-top:6px}
.vs{align-self:center;color:#5f7d86;font-size:13px}
.fair{background:#0a2430;border:1px solid #14414f;border-left:4px solid #6ff0ff;border-radius:8px;
padding:12px 14px;margin:18px 0;text-align:left;font-size:13px;color:#8fb3bd;line-height:1.5}
.fair b{color:#eaf6f9}.mono{font-family:ui-monospace,Menlo,monospace;color:#6ff0ff;word-break:break-all}
a.cta,button{display:inline-block;margin:8px 6px;padding:11px 18px;border-radius:10px;border:1px solid #6ff0ff;
background:#0e3a4a;color:#6ff0ff;text-decoration:none;cursor:pointer;font-size:15px}
#vout{margin-top:12px;min-height:22px;font-size:14px}.ok{color:#7CFFB2}.bad{color:#ff6b6b}
.warn{color:#ffd479;font-size:13px}</style></head><body><div class="wrap">
<h1>${esc(title)}</h1>
<div class="sub">${ladder ? 'ladder fight' : 'Fight Club'} · ${esc(shortNid(battleId))}</div>
${unresolved ? `<div class="fair">This fight has not settled yet. The dice come from ledger
  <b>${v.seedLedger || 'a future ledger'}</b>, which has not closed. Nobody can know the result yet —
  not the players, not the operator.</div>`
: `<div class="bout">${row(nameA, m.rollA, m.powerA, m.scoreA, aWon && !drawn)}
   <div class="vs">vs</div>
   ${row(nameB, m.rollB, m.powerB, m.scoreB, !aWon && !drawn)}</div>
<div class="fair">
  <b>Why this was not fixable.</b> The dice are the hash of ledger <b>${v.seedLedger}</b>.
  That ledger had not closed when the last player committed, so nobody could know this result
  in advance — including whoever runs the game.<br><br>
  The <span class="roll">blue</span> number is the dice. The <span class="pow">amber</span> one is
  how well the pet was raised. They add up, so care tilts a fight without deciding it.
  ${v.warning ? `<br><br><span class="warn">⚠️ ${esc(v.warning)} — ${esc(v.warningDetail || '')}</span>` : ''}
  <br><br>ruleset <span class="mono">${esc(m.rulesetVersion || '?')}</span> · seed
  <span class="mono">${esc(String(v.seed || '').slice(0, 24))}…</span>
</div>`}
<button id="v">🔎 Re-check this fight</button>
<a class="cta" href="${esc(APP_URL)}?b=${esc(battleId)}">⚔️ Rematch</a>
<a class="cta" href="${esc(APP_URL)}">🐣 Adopt one</a>
<a class="cta" href="/gallery.html">🏆 Gallery</a>
<div id="vout"></div>
<div style="color:#5f7d86;font-size:12px;margin-top:20px">You don't trust the operator — you check.
The whole fight re-derives from XRPL ledger data under published rules.</div>
<script>document.getElementById('v').onclick=async()=>{const o=document.getElementById('vout');
o.textContent='re-deriving from ledger history…';
try{const v=await(await fetch('/verify-battle/${esc(battleId)}')).json();
o.innerHTML=v.verdict==='PASS'?'<span class=ok>✅ PASS — winner and scores re-derive from the pinned ledger hash and the open rules.</span>'
:v.verdict==='UNRESOLVED'?'not settled yet — try again in a minute.'
:'<span class=bad>🚨 '+v.verdict+' — '+(v.reason||'')+'</span>';}
catch(e){o.textContent='could not reach the verifier';}};</script>
</div></body></html>`);
  } catch (e) { res.status(500).type('text/html').send('error'); }
});

// export the issuer primitives so a harness can drive the logic without starting a server.
module.exports = { app, withClient, readState, submit, verifyPet, replay, enc, dec, hex, unhex, R, TAXON, TF_MUTABLE_TRANSFERABLE, ROYALTY_BPS, ENDPOINT,
  A, loadHistory, encAch, decAch, listAchievements, claimAchievements, verifyAchievement, ACHIEVEMENT_TAXON, RULESET_VERSION,
  BR, seedFor, stateAtLedger, loadBattle, acceptWellFormed, pickAccept, refundBoth, resolveBattleTx, verifyBattle, ledgerHashOf, BATTLE_TAXON, BATTLE_FEE_BPS, BATTLE_LEDGER_MARGIN, BATTLE_MEMO,
  reconcilePet, pollerTick, startPoller, allIssuerNfts, genCardSvg, careRatio, LADDER, resolveLadder,
  BATTLE_CHALLENGE_TTL, noteLadderChallenge, pendingLadder, pendingPvp, resolvePendingPvp, resolvePendingLadders };

if (require.main === module) {
  const PORT = process.env.PORT || 8788;
  app.listen(PORT, () => console.log(`Ledgerlings issuer on :${PORT} (endpoint ${ENDPOINT})`));
  if (process.env.POLLER !== '0') startPoller().catch(e => console.warn('[poller] failed to start', e.message));
}
