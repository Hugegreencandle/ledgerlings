# Ledgerlings — Provably-Fair Battles + Wager (Make Waves #10)

Two owners duel their Ledgerlings, optionally staking XRP; the winner takes the pot minus a platform fee.
The outcome is a **checkable on-ledger fact** — nobody, not even the issuer, can rig it, and anyone can re-derive it.

## Unriggable randomness = a FUTURE ledger hash, counted from the LAST commitment
**seed = SHA-256( ledgerHash(N) ‖ battleId ‖ petA ‖ petB )**, where `N` is **derived at resolution**, not taken
from the challenge memo: `N = (the ledger the ACCEPT landed in) + K` (K = `BATTLE_LEDGER_MARGIN`, default 20).
No player and no issuer controls a future XRPL ledger's hash, and anyone can fetch it once it closes → unbiasable
at commit, re-derivable forever. This beats commit-reveal (a losing party can grief by not revealing) and any
issuer-chosen seed (riggable).

Counting from the ACCEPT, not the challenge, is load-bearing. A challenge memo pins `N` when the payload is
BUILT, but a human signs whenever they get round to it — on 2026-07-30 a real challenge pinned 105955044 and
landed in 105955051, so its "unknowable" seed was already public before the challenge was recorded. PvP has two
commitments, and the acceptor moves second: if the seed came from the challenger's `N`, an acceptor could read
the hash, compute the winner, and accept only when they win. Field 4 of a PvP challenge memo is therefore an
accept **expiry**, not a seed commitment; the ladder's field 4 is the margin. `/verify-battle` re-derives `N` the
same way and flags `STALE_COMMITMENT` when a memo pinned a ledger that had already closed.

## The rules (pure, open, versioned — `build/battle_rules.js`)
`resolveBattle(seed, stateA@N, stateB@N, nidA, nidB) -> winner`:
- `power(pet)` = 100 + bounded bonuses from care, form, stage → range **100..212**.
- seeded roll per pet (0..999) from the seed → `score = roll + power`; higher wins; dead pet forfeits; exact tie → lexicographic nid.
- **Seed-dominant on purpose**: the roll (0..999) outweighs the power spread (max ~112), so care/form give an edge,
  not a lock — a weak pet still wins ~40% of random seeds (measured). No pay-to-win, same HARD RULE as `loadout`.
- States used = each pet's state **as of ledger N**, re-derived from its own on-ledger history.

## Flow (memo'd Payments on the issuer — reuses the marketplace unsigned-tx pattern)
1. **Challenge** — `POST /battle/challenge {owner, aNid, stakeXrp, N?}` → unsigned stake Payment (owner signs via Xaman).
   `battleId` = that Payment's tx hash. `stakeXrp` omitted / 0 → friendly (1-drop) battle.
2. **Accept** — `POST /battle/accept {owner, battleId, bNid}` → unsigned Payment for `matchStakeDrops`, which is the
   challenger's `stakeDrops`. (Fight Club's in-app path is `/sign {kind:'accept'}`, hard-coded to 1 drop.)
3. **Resolve** — `POST /battle/resolve {battleId}` (admin, idempotent) after N closes → fetch `ledgerHash(N)`, re-derive
   both states@N + seed + winner, pay the winner `pot - fee`, mint a soulbound "battle card" keepsake. (Draw → refund both.)
4. **Status / verify** — `GET /battle/:battleId` (OPEN/LIVE/RESOLVED) · `GET /verify-battle/:battleId` (the fairness proof).

## Verification (why it's *provably* fair)
`/verify-battle` reads the three memos, re-derives stateA@N + stateB@N from each pet's on-ledger history, fetches
`ledgerHash(N)`, recomputes seed + `resolveBattle`, and asserts the recorded winner + scores match **and** the payout
Payment went to the winner's owner. A rigged record → FAIL. Same trust model as pets/achievements: detectable, ruleset-anchored.

## Settlement — MVP vs non-custodial (honest scope)
- **MVP (shipped): issuer-settled, publicly verifiable.** Stakes go to the issuer; on resolve it pays the winner. Custody
  is brief and the payout is on-ledger, so a wrong/absent payout is *detectable by anyone* (detectable-not-preventable).
- **v2 (stronger): non-custodial** via crypto-condition Escrow keyed to the result, or atomic `Batch` (when live on mainnet).

## Who may write a battle's history (enforced in the PARSER, not the endpoints)
Every fact above lives in a memo on an ordinary Payment. The format is public, so **anyone can emit any of these
memos for one drop without touching our endpoints** — the checks inside `POST /battle/accept` and `/sign` only
shape the payloads *we* build, and are advice to honest clients. Authority is decided in `loadBattle` /
`pickAccept` (`build/server.js`), where all of it is a function of ledger data alone, so a third party re-deriving
the fight reaches the same answer:

- **Settlement is issuer-only.** A `result` or `refund` memo counts only if the ISSUER signed it. Otherwise a
  forged `result` freezes the pot behind the idempotence short-circuit (winner never paid) and flips
  `/verify-battle` to FAIL on an honest fight.
- **Commitments must be delivered TO the issuer** — the Payment *is* the stake.
- **First valid accept wins; later accept memos are inert.** The seed ledger is a function of the accept, so a
  movable accept is re-rollable dice: a loser could read the outcome and buy fresh ones for a drop, repeatedly.
- **A valid accept** = not the challenger's own pet · stake actually delivered (`meta.delivered_amount`) · the
  sender OWNS the nominated pet (owner replayed from that pet's history at the accept's ledger) · within the
  challenge expiry (+ one margin of grace for a signed tx in flight).
- **tec is not success.** A failed Payment sits in the ledger with its memos intact and moves nothing, so it is
  never a commitment, a refund or a settlement.
- Plus: one resolution per battleId (idempotent) · power bounded (no whale auto-win) · both pets alive is a
  builder-side courtesy, not an invariant — a passed pet forfeits under the open rules either way.

VOID and DRAW settle in three transactions: refund leg A, refund leg B (each carrying `refund|<battleId>|A|B`),
then the `result` memo LAST. A leg already on the ledger is skipped on retry, so a failed leg leaves the battle
UNRESOLVED and retryable instead of permanently settled with someone unpaid.

## Tests / evidence
- `build/battle_rules.test.js` — pure: determinism, oracle-match over 200 seeds, **seed-dominance (weak wins ~41%)**, power
  bounds, forfeit/draw/tiebreak. `node build/battle_rules.test.js` → ALL PASS.
- `build/battle_smoke.js` — XRPL testnet end-to-end: challenge → accept → pinned-ledger wait → resolve (winner paid, card
  minted) → verify PASS; a **tampered result (winner flipped) → verify FAIL**. Ran green (real battleId on altnet).
- `build/battle_seed_test.cjs` — the seed ledger is strictly after the LAST commitment, and no set of later accept
  memos can move it. `node build/battle_seed_test.cjs`.
- `build/battle_authority_test.cjs` — drives the real `loadBattle` / `pickAccept` / `resolveBattleTx` / `verifyBattle`
  against a stubbed ledger: re-roll, forged result, refund theft, self-battle, conscription, ghost pet, tec'd memo,
  refund idempotence, expiry, poller target. 32 checks. `node build/battle_authority_test.cjs`.

## Non-goals (v1)
Non-custodial escrow settlement, matchmaking/brackets/ELO, spectator wagers, mainnet action. Card is a cosmetic keepsake
(authoritative result = the on-ledger result memo).
