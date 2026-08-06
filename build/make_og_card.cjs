#!/usr/bin/env node
/* Generate the static link-preview image for the app itself.
 *
 *   node build/make_og_card.cjs        # writes build/og.png AND docs/og.png
 *
 * WHY THIS EXISTS. app.html had ZERO og: tags, and the pet/fight pages pointed og:image at an SVG.
 * No social platform rasterises SVG, so every link this project has ever posted — including the
 * launch post on 2026-08-05 — previewed as a blank box or a bare URL.
 *
 * The image is committed rather than rendered per-request because the app is served by GitHub
 * Pages, which runs no code. It must exist in BOTH build/ and docs/ and be byte-identical: the
 * docs-sync gate compares every file in docs/ against its build/ counterpart.
 *
 * NO EMOJI. resvg tofus an ENTIRE <text> element if one glyph is missing from the font, and the
 * bundled DejaVu subset has no emoji. Verified by rendering and looking: "with emoji ✅ here" came
 * out as 17 empty boxes. ✓ ✕ → · are all present and safe.
 */
'use strict';
const fs = require('fs'), path = require('path');

const W = 1200, H = 630;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs><radialGradient id="bg" cx="42%" cy="32%" r="88%">
    <stop offset="0%" stop-color="#0e3a4a"/><stop offset="100%" stop-color="#05141a"/></radialGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <g transform="translate(300,315)">
    <circle cx="0" cy="0" r="150" fill="none" stroke="#6ff0ff" stroke-width="4" opacity="0.55"/>
    <circle cx="0" cy="0" r="112" fill="#7CD89A"/>
    <circle cx="-42" cy="-14" r="15" fill="#0b1e26"/><circle cx="42" cy="-14" r="15" fill="#0b1e26"/>
    <ellipse cx="0" cy="34" rx="23" ry="16" fill="#0b1e26"/>
  </g>
  <text x="560" y="238" font-family="DejaVu Sans" font-size="66" font-weight="700" fill="#6ff0ff">Ledgerlings</text>
  <text x="560" y="300" font-family="DejaVu Sans" font-size="30" fill="#eaf6f9">A pet that lives on the XRP Ledger.</text>
  <text x="560" y="346" font-family="DejaVu Sans" font-size="30" fill="#eaf6f9">Feed it, fight it, and check the maths.</text>
  <text x="560" y="416" font-family="DejaVu Sans" font-size="25" fill="#7CFFB2">✓ every result re-derives from ledger history</text>
  <text x="560" y="456" font-family="DejaVu Sans" font-size="25" fill="#7CFFB2">✓ you can catch the operator cheating</text>
  <text x="560" y="524" font-family="DejaVu Sans" font-size="22" fill="#8fb3bd">Free to adopt · no wallet needed · it dies if you ignore it</text>
</svg>`;

// TTF, not woff2 — a woff2 rendered fine locally and produced entirely blank text on Railway,
// because woff2 needs brotli compiled into the resvg binary and the linux build lacks it.
const fontPath = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
// fontFiles by path, and every generic family mapped onto the one font we ship. fontBuffers is
// what the server used when it rendered entirely blank text in production, so it is not trusted
// here either. The size assertion at the bottom is the real guard.
const { Resvg } = require('@resvg/resvg-js');
const FAM = 'DejaVu Sans';
const png = new Resvg(svg, {
  font: { fontFiles: [fontPath], loadSystemFonts: false,
          defaultFontFamily: FAM, sansSerifFamily: FAM, serifFamily: FAM, monospaceFamily: FAM },
}).render().asPng();

const targets = [path.join(__dirname, 'og.png'), path.join(__dirname, '..', 'docs', 'og.png')];
for (const t of targets) { fs.writeFileSync(t, png); console.log(`wrote ${t} (${png.length} bytes)`); }

// A blank-ish render means the font did not load — the exact failure this file exists to prevent.
if (png.length < 8000) { console.error('SUSPICIOUSLY SMALL — the font probably did not load'); process.exit(1); }
