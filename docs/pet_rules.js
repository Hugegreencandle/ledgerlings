/* Ledgerlings rules engine — shared JS (Node + browser). FAITHFUL to pet_rules.py and app.html.
 * The issuer (server.js) and the replay verifier MUST use this exact logic. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetRules = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const DAY = 21600, DECAY = 60, RESTORE = 50, COOLDOWN = DAY / 6, LIFESPAN = 40 * DAY;
  // Mainnet ledger at which the care-award rule changes. Chosen ~32h ahead of the fix being written
  // (validated ledger was 106,111,098) so the deploy lands comfortably first: any interaction that
  // happens BEFORE this ledger must keep scoring under the old rule, because the issuer already
  // wrote those awards into NFT URIs and the public verifier replays them. A fork that arrives
  // before the code does would make the server and the verifier disagree.
  const CARE_FORK = 106140000;
  // Egg hatches in-session (~60 ledgers ≈ 3-4 min) so a first-time player/judge sees the pet come alive
  // immediately instead of a 24h dead egg. Later stages keep the longer cadence. DAY is the master pacing dial.
  const HATCH = 60;
  const STAGE_AGE = [0, HATCH, 3 * DAY, 7 * DAY, 21 * DAY];
  const EGG = 0, BABY = 1, TEEN = 2, ADULT = 3, ELDER = 4, PASSED = 5;
  const FEED = 1, PLAY = 2, CLEAN = 3, HEAL = 4;
  const STAGE = ['egg', 'baby', 'teen', 'adult', 'elder', 'passed'];
  const FORM = ['-', 'runt', 'standard', 'rare', 'legendary'];
  const OP = { feed: FEED, play: PLAY, clean: CLEAN, heal: HEAL };
  const clamp = (v, lo = 0, hi = 100) => v < lo ? lo : v > hi ? hi : v;

  function stageForAge(a) {
    return a < STAGE_AGE[1] ? EGG : a < STAGE_AGE[2] ? BABY : a < STAGE_AGE[3] ? TEEN
      : a < STAGE_AGE[4] ? ADULT : a < LIFESPAN ? ELDER : PASSED;
  }
  function evolve(c, m) { if (m <= 0) return 1; const r = Math.floor(c * 100 / m); return r < 40 ? 1 : r < 75 ? 2 : r < 92 ? 3 : 4; }
  // `name` is OPTIONAL and, when absent, is left off the object entirely rather than set to "".
  // That keeps an unnamed pet's encoded URI byte-identical to one minted before names existed, so
  // adding the field cannot make an existing pet DIVERGE. step() copies state, so a name set at
  // genesis survives every interaction untouched without step() needing to know about it.
  function genesis(birth, owner, name) {
    const g = { v: 1, owner, birth, last_ix: birth, hunger: 80, happiness: 80, health: 100, stage: EGG,
      form: 0, alive: 1, age: 0, care: 0, care_max: 0, death_cause: 0, last_feed: 0, last_play: 0, loadout: [] };
    if (name) g.name = name;
    return g;
  }
  function step(state, op, now, sender) {
    const s = Object.assign({}, state);
    if (sender !== s.owner) return s;
    if (s.alive === 0) return s;
    const age = now - s.birth, ns = stageForAge(age);
    const drop = Math.min(100, Math.floor(Math.max(0, now - s.last_ix) * DECAY / DAY));
    s.hunger = clamp(s.hunger - drop); s.happiness = clamp(s.happiness - drop);
    let drain = 0; for (const st of [s.hunger, s.happiness]) { if (st === 0) drain += drop; else if (st < 20) drain += Math.floor(drop / 2); }
    s.health = clamp(s.health - drain);
    if (age >= LIFESPAN) { s.alive = 0; s.death_cause = 2; s.stage = PASSED; s.age = age; s.last_ix = now; return s; }
    if (s.health === 0) { s.alive = 0; s.death_cause = 1; s.age = age; s.last_ix = now; return s; }
    // CARE AWARD. Before CARE_FORK the rule paid MORE for feeding a pet that had already fallen
    // below 50 ("full credit only when the pet actually needed it"). The intent was anti-spam, but
    // COOLDOWN already blocks spam, so in practice the rule paid players to let the pet decay:
    // feeding promptly scored 5/10 and feeding a starving pet scored 10/10. Measured on the live
    // data, that is 20 points of a 112-point battle-power spread handed to the more neglectful
    // player, in a game whose entire claim is that care is provable and matters. Every pet in the
    // gallery with care > 0 sat at 50-59% quality because everyone fed on time.
    //
    // After the fork the credit is inverted: full credit for acting while the pet is still WELL
    // (>= 50), half for a late rescue. Quality then means "how consistently you kept it well".
    //
    // THE FORK IS WHY THIS IS NOT A ONE-CHARACTER CHANGE. /verify compares the stored NFT URI
    // against replay(history). Changing the rule outright would re-derive every pet differently
    // from what the issuer wrote at the time, and all 14 mainnet pets would report DIVERGED on
    // honest history. Gating on the interaction's own ledger keeps every past award byte-identical
    // and applies the new rule only to interactions that have not happened yet.
    const award = low => {
      s.care_max += 10;
      s.care += (now >= CARE_FORK) ? (low ? 5 : 10) : (low ? 10 : 5);
    };
    if (op === FEED && (s.last_feed === 0 || now - s.last_feed >= COOLDOWN)) { award(s.hunger < 50); s.hunger = clamp(s.hunger + RESTORE); s.last_feed = now; }
    else if (op === PLAY && (s.last_play === 0 || now - s.last_play >= COOLDOWN)) { award(s.happiness < 50); s.happiness = clamp(s.happiness + RESTORE); s.last_play = now; }
    else if (op === CLEAN) s.health = clamp(s.health + 20);
    else if (op === HEAL) s.health = clamp(s.health + 30);
    s.stage = ns; if (ns >= ADULT && s.form === 0) s.form = evolve(s.care, s.care_max);
    s.age = age; s.last_ix = now; return s;
  }
  return { DAY, DECAY, RESTORE, COOLDOWN, LIFESPAN, STAGE_AGE, CARE_FORK, clamp,
    EGG, BABY, TEEN, ADULT, ELDER, PASSED,
    genesis, step, stageForAge, evolve, STAGE, FORM, OP, FEED, PLAY, CLEAN, HEAL };
}));
