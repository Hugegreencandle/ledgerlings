# BUILD SPEC — mint-to-player (real on-ledger ownership) — 2026-08-08

DRAFT spec, not committed. Recon done against `build/server.js` HEAD `c6d1d77`.

## Problem (verified on mainnet 2026-08-08)
Ledgerlings markets on-chain verifiability, but pets are **custodial**: `/adopt` (server.js:224) mints
`NFTokenMint { Account: issuer, … }` with **no Destination**, so every pet stays in the issuer wallet
and "owner" lives only inside the NFT **URI** (`R.genesis(now, owner, …)`). On-ledger truth:
- All **39** mainnet pets are held by the ISSUER (`rDe4t…`); minted to self, never delivered.
- `account_nfts` for every `/gallery` "owner" (13 real collectors) = **0 pets**. Ownership is backend-DB only.
- A Make Waves judge who runs `account_nfts <player>` finds nothing → the ownership story is false on-ledger.

## Verified constraints (rippled 3.2.1 via xrpl-ref; DynamicNFT live mainnet 2025-06-11)
- `NFTokenModify` fields: REQUIRED `NFTokenID`, optional **`Owner`** (ACCOUNT), optional `URI`.
  → the issuer CAN modify a **player-owned** mutable NFT by setting `Owner=<player>`. **Self-custody +
  the poller care-loop coexist.** Pets already mint `TF_MUTABLE_TRANSFERABLE`, so tfMutable is set.
- Hard limit: an NFT can only reach a player if the **player signs one `NFTokenAcceptOffer`**. There is
  no "mint straight into someone else's wallet." So **pure keyless one-tap adopt cannot be self-custody.**
  → the design must be HYBRID: frictionless custodial start + an explicit claim.

## Design — hybrid (keep one-tap, add real ownership)
1. **`/adopt` unchanged for state** — still mints to issuer, state in URI (so the pet works instantly,
   keyless). **Relabel honestly** in UI/copy: "custodial pet — claim it to your wallet anytime."
2. **At adopt time, also create the claim offer**: issuer submits
   `NFTokenCreateOffer { Account: issuer, NFTokenID: nid, Amount: "0", Flags: tfSellNFToken,
   Destination: owner }` (0-drop, destination-locked to the adopter). The pet is now *claimable* by
   exactly that address. Store the offer index.
3. **New `POST /claim-pet`** — returns the Xaman-signable / unsigned `NFTokenAcceptOffer
   { Account: owner, NFTokenSellOffer: <offerIndex> }`. Player signs once → **owns the pet on-ledger.**
4. **Poller becomes owner-aware** — `reconcile`/`/interact` `NFTokenModify` must set **`Owner`** to the
   pet's CURRENT on-ledger holder (issuer before claim, player after). Read current owner from the
   ledger (or track claim status); never assume issuer. Without this, modify targets the wrong copy
   after a claim and the care loop silently stops.
5. **`/verify` is unaffected** — the URI `owner` field and the replay history don't change on claim
   (an NFTokenAcceptOffer is a transfer, not a state edit), so parity + quorum verify still PASS.

## Migration — make the existing 39 real
Batch-create destination-locked 0-drop claim offers for each of the 39 issuer-held pets, `Destination`
= the URI-named owner. Then the 13 "owners" can claim → "collectors own verifiable pets" becomes TRUE.
(Optional: proactively offer; they still must accept.)

## VERIFY GATES (testnet first — do NOT trust the amendment, test it)
- **G1 (the crux):** mint mutable pet → deliver to player via 0-offer → player accepts → confirm
  `account_nfts(player)` shows it. Then issuer `NFTokenModify { NFTokenID, Owner: player, URI: new }`
  → **must return tesSUCCESS on the player-held token** and the URI must actually change. If this
  fails, self-custody is off the table until it's understood — STOP and reassess.
- **G2:** after a claim, run a normal `/interact` step → poller applies `NFTokenModify(Owner=player)` →
  `/verify` still PASS (parity + quorum), no DIVERGED.
- **G3:** one-living-pet cap + genesis-URI hardening still hold (adopt path logic unchanged).
- **G4:** `account_nfts(player)` includes the pet, and its URI decodes to the same owner — the
  submission claim "player X owns pet Y" is now independently checkable.

## Files to touch
- `build/server.js`: `/adopt` (+claim offer after mint), new `/claim-pet`, poller `NFTokenModify`
  (+`Owner`), a small `currentOwner(nid)` helper (account the NFT is under on-ledger).
- Frontend `app.html`: "Claim to your wallet" button → `/claim-pet` → Xaman accept.
- Copy: mark custodial pets honestly until claimed.
- Migration script: `build/migrate_claim_offers.cjs` (create the 39 destination-locked offers).

## Honest-submission line (only after G1–G4 green)
"Pets are minted on XRPL mainnet and claimable to the player's own wallet; once claimed, the player
holds the NFT and anyone can verify ownership with `account_nfts` — while the provably-fair state stays
independently re-derivable." Do NOT claim player ownership for pets still sitting in the issuer wallet.
