#!/usr/bin/env node
/**
 * generate-community-themes.mjs - convert Noctalia community palettes into
 * Claude Desktop theme token maps, and render SVG palette swatches.
 *
 * Usage:
 *   node scripts/generate-community-themes.mjs [/path/to/community-palettes]
 *
 * Zero external dependencies. Deterministic: the same input tree always
 * produces byte-identical output.
 *
 * Outputs:
 *   js/community_themes.json   - { "<slug>": { name, spinner, light, dark } }
 *   themes/palettes/<slug>.svg - one swatch card per community theme, per
 *                                built-in theme (parsed out of the Nim patch)
 *                                and per gaming theme (js/gaming_themes.json)
 *
 * ---------------------------------------------------------------------------
 * SPINNERS
 * ---------------------------------------------------------------------------
 * scripts/community-spinners.json is the CURATED, hand-authored map of the
 * per-theme loading glyph: { "<slug>": { concept, viewBox, animation, paths,
 * paths2? } }. The generator merges each spec into its theme entry verbatim
 * except for `concept`, which is curator-side documentation and is NOT emitted.
 * Theme families deliberately share one glyph (every catppuccin-* is the same
 * curled cat, every everforest-* the same fir); uniquely named themes get a
 * unique glyph derived from the NAME first and the palette second.
 *
 * Validation is a hard gate (the build fails, it never warns): the slug sets on
 * both sides must match exactly, the spec schema must be well formed, every
 * `d` must tokenize as SVG path data, `paths2` exists if and only if the
 * animation is the 2-frame `flip`, and any explicit `fill` must clear 2.5:1
 * against BOTH that theme's light and dark --bg-100 (a glyph is only ever shown
 * on those two surfaces). Fill-less paths inherit --accent-brand at runtime and
 * are the default: single-colour glyphs must omit `fill`.
 *
 * ---------------------------------------------------------------------------
 * CONVERSION MAPPING (community Material-ish roles -> our CSS tokens)
 * ---------------------------------------------------------------------------
 * Each community palette variant provides mPrimary/mOnPrimary/mSecondary/
 * mTertiary/mError/mSurface/mOnSurface/mSurfaceVariant/mOnSurfaceVariant/
 * mOutline/mShadow/mHover/mOnHover plus a `terminal` ANSI block.
 *
 * Polarity: decided per variant from the MEASURED surface lightness
 * (mSurface L < 50 => dark polarity), not from the variant's key name. A
 * handful of community palettes declare a "light" variant whose surface is
 * actually dark; honoring the measurement keeps borders and the background
 * ladder correct. Mismatches are listed in the report.
 *
 * Backgrounds. mSurface is the --bg-100 anchor (content panes). The rest of
 * the ladder is built around it with a palette-informed step unit
 * `step = clamp(|L(mSurfaceVariant) - L(mSurface)|, 1.5, 3.5)`, keeping the
 * surface hue/saturation:
 *   dark : bg-000 = L+1.40*step (panels float ABOVE the pane), then
 *          bg-200 = L-0.85*step, bg-300 = L-1.55*step,
 *          bg-400 = L-2.35*step, bg-500 = L-3.05*step
 *   light: bg-000 = pure white when L >= 92, else L+max(1.6*step, 5), then
 *          bg-200 = L-0.85*step, bg-300 = L-1.60*step,
 *          bg-400 = L-2.40*step, bg-500 = L-3.40*step
 * This reproduces the built-ins' surface hierarchy: the content backdrop
 * (bg-400/500) is the deepest level and bg-000 is the lightest.
 *
 * Text. mOnSurface -> --text-000/--text-100; mOnSurfaceVariant ->
 * --text-400/--text-500; --text-200/--text-300 are a linear HSL mix of the
 * two (t=0.40 dark, t=0.50 light, matching the built-ins' ramps).
 * --pictogram-100/200/300 = text-000/200/400. --pictogram-400 is a
 * background tone: dark = surface at L+6 (like the built-ins' slightly
 * raised illustration fill), light = --bg-300.
 *
 * Accents. mPrimary -> --accent-brand and --accent-100/--accent-200 verbatim
 * (100 == 200 == brand, as in stock). --accent-000 = brand at L+5 (dark) /
 * L+3 (light). --brand-100/200 = brand, --brand-000 = --accent-000,
 * --brand-900 = "0 0% 0%" (it is --always-black upstream).
 * mSecondary (falling back to mTertiary) drives --accent-pro-000/100/200 the
 * same way. The -900 shades of every ramp use one shared recipe: keep the
 * hue, damp saturation to 0.55-0.60x, and force a surface-appropriate
 * lightness (L=24 dark, L=90 light) - the range the built-ins use.
 *
 * Status colors. mError -> --danger-*. terminal yellow -> --warning-*,
 * terminal green -> --success-* (bright.* preferred for dark variants,
 * normal.* for light ones, since that is the shade meant to read against
 * that background). Each family: -100 == -200 == base, -000 slightly
 * lighter/legible, -900 via the shared muted recipe.
 *
 * --oncolor-100/200/300 = mOnPrimary (text on a filled accent button). Some
 * community palettes ship an mOnPrimary that is unreadable on their own
 * mPrimary (they use it as a tint, not as button-label text). Since these
 * tokens ARE the label color on our filled accent buttons, mOnPrimary is
 * replaced when it falls below 3.0:1 against mPrimary (the WCAG floor for UI
 * components) by a near-black or near-white in the accent's own hue family,
 * whichever wins the contrast. Between 3.0 and the 4.5 the built-ins hold to,
 * the palette author's choice is kept - overriding there would throw away
 * conventional pairings like white-on-mid-blue. Substitutions are listed as
 * warnings, and anything still under 4.5 as a quality note.
 *
 * BORDER POLARITY (the #1 authoring gotcha). claude.ai applies borders at a
 * low alpha at the use site, so --border-100..400 must be the OPPOSITE
 * polarity of the surface. Community mOutline follows surface polarity, so
 * it is NOT mapped directly: we take its hue/saturation family (falling back
 * to mOnSurface when mOutline is achromatic) and force the polarity-correct
 * lightness - L=74 for dark variants, L=26 for light ones.
 *
 * Legacy --claude-* hex chrome. --claude-accent-clay = mPrimary,
 * --claude-background-color = mSurface, --claude-foreground-color =
 * mOnSurface, --claude-secondary-color = mOnSurfaceVariant,
 * --claude-border / -300 / -300-more = mPrimary + "18"/"30"/"55" alpha,
 * --claude-text-100 = mOnSurface, --claude-text-200 = hex(--text-200),
 * --claude-text-400/-500 = mOnSurfaceVariant, --claude-description-text =
 * the onSurface->onSurfaceVariant mix at t=0.60 (a touch dimmer than
 * --text-200).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SELF), '..');
const DEFAULT_PALETTES = '/home/patrickjaja/development/community-palettes';

const OUT_JSON = path.join(REPO, 'js', 'community_themes.json');
const OUT_SVG_DIR = path.join(REPO, 'themes', 'palettes');
const THEME_PATCH = path.join(REPO, 'patches', 'core', 'add_feature_custom_themes.nim');
const SPINNERS_JSON = path.join(REPO, 'scripts', 'community-spinners.json');
const GAMING_JSON = path.join(REPO, 'js', 'gaming_themes.json');
const LINUX_JSON = path.join(REPO, 'js', 'linux_themes.json');
const LOLLIPOP_JSON = path.join(REPO, 'js', 'lollipop_themes.json');

const BUILTIN_NAMES = new Set([
  'catppuccin-frappe', 'catppuccin-latte', 'catppuccin-macchiato',
  'catppuccin-mocha', 'mario', 'nord', 'sweet',
]);
const BUILTIN_ALIASES = new Set(['nordic']);

/* ------------------------------------------------------------------ color */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clampL = (v) => clamp(v, 0, 100);

function parseHex(s, where) {
  if (typeof s !== 'string') throw new Error(`${where}: not a string: ${JSON.stringify(s)}`);
  let h = s.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length === 8) h = h.slice(0, 6);
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`${where}: not a hex color: ${JSON.stringify(s)}`);
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function normHex(s, where) {
  const { r, g, b } = parseHex(s, where);
  return rgbToHex(r, g, b);
}

function rgbToHex(r, g, b) {
  const p = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${p(r)}${p(g)}${p(b)}`;
}

/** hex -> { h: 0..360, s: 0..100, l: 0..100 }; achromatic yields h=0, s=0. */
function hexToHsl(hex, where) {
  const { r, g, b } = parseHex(hex, where);
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0, s = 0;
  if (d > 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: s * 100, l: l * 100 };
}

function hslToHex({ h, s, l }) {
  const hn = ((h % 360) + 360) % 360, sn = clamp(s, 0, 100) / 100, ln = clampL(l) / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = ln - c / 2;
  const seg = Math.floor(hn / 60) % 6;
  const t = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg];
  return rgbToHex((t[0] + m) * 255, (t[1] + m) * 255, (t[2] + m) * 255);
}

/** Format as our token value: "H S% L%", H integer, S/L one decimal. */
function hsl(c) {
  const h = c.s <= 0.05 ? 0 : Math.round(((c.h % 360) + 360) % 360) % 360;
  const s = c.s <= 0.05 ? 0 : clamp(c.s, 0, 100);
  const l = clampL(c.l);
  const f = (v) => (Object.is(v, -0) ? 0 : v).toFixed(1);
  return `${h} ${f(s)}% ${f(l)}%`;
}

/** Linear HSL mix, hue along the shortest arc. */
function mix(a, b, t) {
  let dh = ((b.h - a.h + 540) % 360) - 180;
  if (a.s <= 0.05) dh = 0;
  if (b.s <= 0.05) dh = 0;
  return { h: a.h + dh * t, s: a.s + (b.s - a.s) * t, l: a.l + (b.l - a.l) * t };
}

const tone = (c, l, s) => ({ h: c.h, s: s === undefined ? c.s : s, l: clampL(l) });

/** The shared -900 recipe: keep the hue, damp saturation, force surface-side L. */
function shade900(c, isDark) {
  return {
    h: c.h,
    s: c.s <= 0.05 ? 0 : clamp(c.s * (isDark ? 0.55 : 0.6), 10, 70),
    l: isDark ? 24 : 90,
  };
}

/** WCAG relative luminance / contrast, for the quality report only. */
function luminance(hex) {
  const { r, g, b } = parseHex(hex, 'luminance');
  const ch = (v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}
function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/* ------------------------------------------------------- token generation */

const TOKEN_ORDER = [
  '--bg-000', '--bg-100', '--bg-200', '--bg-300', '--bg-400', '--bg-500',
  '--text-000', '--text-100', '--text-200', '--text-300', '--text-400', '--text-500',
  '--accent-brand', '--accent-000', '--accent-100', '--accent-200', '--accent-900',
  '--accent-pro-000', '--accent-pro-100', '--accent-pro-200', '--accent-pro-900',
  '--brand-000', '--brand-100', '--brand-200', '--brand-900',
  '--border-100', '--border-200', '--border-300', '--border-400',
  '--danger-000', '--danger-100', '--danger-200', '--danger-900',
  '--warning-000', '--warning-100', '--warning-200', '--warning-900',
  '--success-000', '--success-100', '--success-200', '--success-900',
  '--oncolor-100', '--oncolor-200', '--oncolor-300',
  '--pictogram-100', '--pictogram-200', '--pictogram-300', '--pictogram-400',
  '--claude-accent-clay', '--claude-background-color', '--claude-foreground-color',
  '--claude-secondary-color', '--claude-border', '--claude-border-300',
  '--claude-border-300-more', '--claude-text-100', '--claude-text-200',
  '--claude-text-400', '--claude-text-500', '--claude-description-text',
];

/** Pick an ANSI status base: bright shades read better on dark surfaces. */
function ansi(variant, key, isDark) {
  const t = variant.terminal || {};
  const n = t.normal || {}, b = t.bright || {};
  const c = isDark ? (b[key] || n[key]) : (n[key] || b[key]);
  return typeof c === 'string' ? c : null;
}

function statusFamily(prefix, baseHsl, isDark) {
  const out = {};
  if (isDark) {
    out[`${prefix}-000`] = hsl(tone(baseHsl, Math.min(baseHsl.l + 7, 90)));
    out[`${prefix}-100`] = hsl(baseHsl);
    out[`${prefix}-200`] = hsl(baseHsl);
  } else {
    const base = tone(baseHsl, Math.min(baseHsl.l, 48));
    out[`${prefix}-000`] = hsl(base);
    out[`${prefix}-100`] = hsl(tone(baseHsl, Math.min(baseHsl.l + 12, 62)));
    out[`${prefix}-200`] = hsl(base);
  }
  out[`${prefix}-900`] = hsl(shade900(baseHsl, isDark));
  return out;
}

/**
 * Convert one community variant into our token map.
 * Returns { tokens, warnings, isDark }.
 */
function convertVariant(variant, label, where) {
  const warn = [];
  const need = (key, fallbacks = []) => {
    for (const k of [key, ...fallbacks]) {
      if (typeof variant[k] === 'string' && variant[k].trim()) {
        if (k !== key) warn.push(`${label}: ${key} missing, used ${k}`);
        return variant[k];
      }
    }
    throw new Error(`${where} [${label}]: missing required role ${key}`);
  };

  const surfHex = normHex(need('mSurface'), where);
  const onSurfHex = normHex(need('mOnSurface'), where);
  const onSurfVarHex = normHex(need('mOnSurfaceVariant', ['mOnSurface']), where);
  const surfVarHex = normHex(need('mSurfaceVariant', ['mSurface']), where);
  const primHex = normHex(need('mPrimary'), where);
  const onPrimHex = normHex(need('mOnPrimary', ['mOnHover']), where);
  const secHex = normHex(need('mSecondary', ['mTertiary', 'mPrimary']), where);
  const errHex = normHex(need('mError'), where);
  const outlineHex = normHex(need('mOutline', ['mOnSurfaceVariant']), where);

  const surf = hexToHsl(surfHex, where);
  const surfVar = hexToHsl(surfVarHex, where);
  const onSurf = hexToHsl(onSurfHex, where);
  const onSurfVar = hexToHsl(onSurfVarHex, where);
  const prim = hexToHsl(primHex, where);
  const sec = hexToHsl(secHex, where);
  const err = hexToHsl(errHex, where);
  const outline = hexToHsl(outlineHex, where);

  const isDark = surf.l < 50;

  /* backgrounds */
  const step = clamp(Math.abs(surfVar.l - surf.l), 1.5, 3.5);
  const bgTone = (l) => tone(surf, l);
  const bg = {};
  if (isDark) {
    bg['--bg-000'] = bgTone(surf.l + step * 1.4);
    bg['--bg-100'] = bgTone(surf.l);
    bg['--bg-200'] = bgTone(surf.l - step * 0.85);
    bg['--bg-300'] = bgTone(surf.l - step * 1.55);
    bg['--bg-400'] = bgTone(surf.l - step * 2.35);
    bg['--bg-500'] = bgTone(surf.l - step * 3.05);
  } else {
    bg['--bg-000'] = surf.l >= 92 ? { h: 0, s: 0, l: 100 } : bgTone(surf.l + Math.max(step * 1.6, 5));
    bg['--bg-100'] = bgTone(surf.l);
    bg['--bg-200'] = bgTone(surf.l - step * 0.85);
    bg['--bg-300'] = bgTone(surf.l - step * 1.6);
    bg['--bg-400'] = bgTone(surf.l - step * 2.4);
    bg['--bg-500'] = bgTone(surf.l - step * 3.4);
  }

  /* text ramp */
  const text200 = mix(onSurf, onSurfVar, isDark ? 0.4 : 0.5);
  const descr = mix(onSurf, onSurfVar, 0.6);

  /* accents */
  const accent000 = tone(prim, clamp(prim.l + (isDark ? 5 : 3), 0, 95));
  const pro000 = tone(sec, clamp(sec.l + (isDark ? 5 : 3), 0, 95));

  /* borders: forced opposite polarity of the surface */
  const bHueSrc = outline.s > 3 ? outline : onSurf;
  const borderSat = bHueSrc.s <= 0.05 ? 0 : clamp((outline.s + onSurf.s) / 2, 8, 45);
  const border = { h: bHueSrc.h, s: borderSat, l: isDark ? 74 : 26 };

  /* status bases */
  const yellowHex = ansi(variant, 'yellow', isDark);
  const greenHex = ansi(variant, 'green', isDark);
  if (!yellowHex) warn.push(`${label}: no terminal yellow, synthesized --warning-*`);
  if (!greenHex) warn.push(`${label}: no terminal green, synthesized --success-*`);
  const warnBase = yellowHex
    ? hexToHsl(yellowHex, where)
    : { h: 45, s: 82, l: isDark ? 62 : 44 };
  const okBase = greenHex
    ? hexToHsl(greenHex, where)
    : { h: 140, s: 60, l: isDark ? 60 : 36 };

  /* oncolor: it labels a filled accent button, so readability wins over fidelity */
  let onColorHex = onPrimHex;
  const onColorContrast = contrast(onColorHex, primHex);
  if (onColorContrast < 3.0) {
    const dark0 = hslToHex({ h: prim.h, s: Math.min(prim.s, 20), l: 9 });
    const light0 = hslToHex({ h: prim.h, s: Math.min(prim.s, 14), l: 98 });
    const pick = contrast(dark0, primHex) >= contrast(light0, primHex) ? dark0 : light0;
    warn.push(
      `${label}: mOnPrimary ${onPrimHex} on mPrimary ${primHex} is ${onColorContrast.toFixed(2)}:1, `
      + `used ${pick} (${contrast(pick, primHex).toFixed(2)}:1) for --oncolor-*`,
    );
    onColorHex = pick;
  }

  const tokens = {
    '--bg-000': hsl(bg['--bg-000']),
    '--bg-100': hsl(bg['--bg-100']),
    '--bg-200': hsl(bg['--bg-200']),
    '--bg-300': hsl(bg['--bg-300']),
    '--bg-400': hsl(bg['--bg-400']),
    '--bg-500': hsl(bg['--bg-500']),

    '--text-000': hsl(onSurf),
    '--text-100': hsl(onSurf),
    '--text-200': hsl(text200),
    '--text-300': hsl(text200),
    '--text-400': hsl(onSurfVar),
    '--text-500': hsl(onSurfVar),

    '--accent-brand': hsl(prim),
    '--accent-000': hsl(accent000),
    '--accent-100': hsl(prim),
    '--accent-200': hsl(prim),
    '--accent-900': hsl(shade900(prim, isDark)),

    '--accent-pro-000': hsl(pro000),
    '--accent-pro-100': hsl(sec),
    '--accent-pro-200': hsl(sec),
    '--accent-pro-900': hsl(shade900(sec, isDark)),

    '--brand-000': hsl(accent000),
    '--brand-100': hsl(prim),
    '--brand-200': hsl(prim),
    '--brand-900': '0 0% 0%',

    '--border-100': hsl(border),
    '--border-200': hsl(border),
    '--border-300': hsl(border),
    '--border-400': hsl(border),

    ...statusFamily('--danger', err, isDark),
    ...statusFamily('--warning', warnBase, isDark),
    ...statusFamily('--success', okBase, isDark),

    '--oncolor-100': hsl(hexToHsl(onColorHex, where)),
    '--oncolor-200': hsl(hexToHsl(onColorHex, where)),
    '--oncolor-300': hsl(hexToHsl(onColorHex, where)),

    '--pictogram-100': hsl(onSurf),
    '--pictogram-200': hsl(text200),
    '--pictogram-300': hsl(onSurfVar),
    '--pictogram-400': hsl(isDark ? tone(surf, surf.l + 6) : bg['--bg-300']),

    '--claude-accent-clay': primHex,
    '--claude-background-color': surfHex,
    '--claude-foreground-color': onSurfHex,
    '--claude-secondary-color': onSurfVarHex,
    '--claude-border': `${primHex}18`,
    '--claude-border-300': `${primHex}30`,
    '--claude-border-300-more': `${primHex}55`,
    '--claude-text-100': onSurfHex,
    '--claude-text-200': hslToHex(text200),
    '--claude-text-400': onSurfVarHex,
    '--claude-text-500': onSurfVarHex,
    '--claude-description-text': hslToHex(descr),
  };

  /* emit in the canonical order so output is stable and diff-friendly */
  const ordered = {};
  for (const k of TOKEN_ORDER) ordered[k] = tokens[k];

  return { tokens: ordered, warnings: warn, isDark, surfL: surf.l, onSurfL: onSurf.l };
}

/* ------------------------------------------------------------- validation */

const HSL_RE = /^\d{1,3}(\.\d)? \d{1,3}(\.\d)?% \d{1,3}(\.\d)?%$/;
const HEX_RE = /^#[0-9a-f]{6}([0-9a-f]{2})?$/;

function validateVariant(tokens, expectedKeys, where, errors) {
  const got = new Set(Object.keys(tokens));
  for (const k of expectedKeys) if (!got.has(k)) errors.push(`${where}: missing token ${k}`);
  for (const k of got) if (!expectedKeys.has(k)) errors.push(`${where}: unexpected token ${k}`);
  for (const [k, v] of Object.entries(tokens)) {
    if (k.startsWith('--claude-')) {
      if (!HEX_RE.test(v)) errors.push(`${where}: ${k} is not a lowercase hex color: ${JSON.stringify(v)}`);
    } else if (!HSL_RE.test(v)) {
      errors.push(`${where}: ${k} is not an HSL triplet: ${JSON.stringify(v)}`);
    }
  }
}

/* --------------------------------------------------------------- spinners */

const ANIMATIONS = new Set(['pulse', 'spin', 'bounce', 'flip']);
const VIEWBOX_RE = /^-?\d+(?:\.\d+)? -?\d+(?:\.\d+)? \d+(?:\.\d+)? \d+(?:\.\d+)?$/;
const FILL_RE = /^#[0-9a-f]{6}$/;
const SPEC_KEYS = new Set(['concept', 'viewBox', 'animation', 'paths', 'paths2']);
/* argument count per SVG path command (lowercase key = both cases) */
const PATH_ARGS = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

/**
 * Tokenize SVG path data and check the command/argument grammar. Catches the
 * failure that matters here - a truncated or malformed `d` that silently
 * renders as nothing (or as a garbage blob) inside the running app.
 */
function validatePathData(d, where, errors) {
  if (typeof d !== 'string' || !d.trim()) {
    errors.push(`${where}: empty path data`);
    return;
  }
  const toks = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [];
  if (toks.join('') !== d.replace(/[\s,]/g, '')) {
    errors.push(`${where}: path data has characters that are not commands or numbers`);
    return;
  }
  let i = 0, cmd = null, isFirst = true;
  while (i < toks.length) {
    if (/[A-Za-z]/.test(toks[i])) {
      cmd = toks[i];
      i += 1;
      if (isFirst && cmd !== 'M' && cmd !== 'm') errors.push(`${where}: path must start with M`);
      isFirst = false;
    } else if (cmd === null) {
      errors.push(`${where}: path starts with a number, not a command`);
      return;
    }
    const n = PATH_ARGS[cmd.toLowerCase()];
    if (n === undefined) {
      errors.push(`${where}: unknown path command ${JSON.stringify(cmd)}`);
      return;
    }
    if (n === 0) continue;
    for (let k = 0; k < n; k += 1) {
      const v = toks[i + k];
      if (v === undefined || /[A-Za-z]/.test(v) || !Number.isFinite(Number(v))) {
        errors.push(`${where}: command ${cmd} needs ${n} numbers`);
        return;
      }
    }
    i += n;
  }
  if (isFirst) errors.push(`${where}: path has no commands`);
}

function validatePathList(list, where, errors, bgHexes) {
  if (!Array.isArray(list) || list.length === 0) {
    errors.push(`${where}: must be a non-empty array`);
    return;
  }
  if (list.length > 6) errors.push(`${where}: ${list.length} paths, keep it to 6 (readability at 32px)`);
  list.forEach((p, i) => {
    const at = `${where}[${i}]`;
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      errors.push(`${at}: must be an object {d, fill?}`);
      return;
    }
    for (const k of Object.keys(p)) {
      if (k !== 'd' && k !== 'fill') errors.push(`${at}: unexpected key ${JSON.stringify(k)}`);
    }
    validatePathData(p.d, at, errors);
    if (p.fill === undefined) return;
    if (typeof p.fill !== 'string' || !FILL_RE.test(p.fill)) {
      errors.push(`${at}: fill must be a lowercase 6-digit hex, got ${JSON.stringify(p.fill)}`);
      return;
    }
    // an explicit fill is fixed, so it has to read on BOTH of the theme's surfaces
    for (const [variant, bg] of bgHexes) {
      const c = contrast(p.fill, bg);
      if (c < 2.5) {
        errors.push(`${at}: fill ${p.fill} is ${c.toFixed(2)}:1 on the ${variant} --bg-100 `
          + `(${bg}), needs 2.5 - drop the fill so it inherits the accent`);
      }
    }
  });
}

/**
 * Read + validate the curated spinner map against the generated theme set.
 * Returns { <slug>: <spec without concept> }. Fails loud on any problem.
 */
function readSpinners(themes, errors) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(SPINNERS_JSON, 'utf8'));
  } catch (e) {
    errors.push(`${SPINNERS_JSON}: ${e.message}`);
    return {};
  }
  const themeSlugs = new Set(Object.keys(themes));
  const specSlugs = new Set(Object.keys(raw));
  for (const s of [...themeSlugs].sort()) {
    if (!specSlugs.has(s)) errors.push(`community-spinners.json: no spinner for theme ${JSON.stringify(s)}`);
  }
  for (const s of [...specSlugs].sort()) {
    if (!themeSlugs.has(s)) errors.push(`community-spinners.json: spinner for unknown theme ${JSON.stringify(s)}`);
  }

  const out = {};
  for (const slug of [...specSlugs].sort()) {
    const spec = raw[slug];
    const where = `spinner ${slug}`;
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      errors.push(`${where}: must be an object`);
      continue;
    }
    for (const k of Object.keys(spec)) {
      if (!SPEC_KEYS.has(k)) errors.push(`${where}: unexpected key ${JSON.stringify(k)}`);
    }
    const words = typeof spec.concept === 'string' ? spec.concept.trim().split(/\s+/) : [];
    if (words.length < 2 || words.length > 8) {
      errors.push(`${where}: concept must be a short phrase, got ${JSON.stringify(spec.concept)}`);
    }
    if (typeof spec.viewBox !== 'string' || !VIEWBOX_RE.test(spec.viewBox)) {
      errors.push(`${where}: viewBox must be four numbers, got ${JSON.stringify(spec.viewBox)}`);
    }
    if (!ANIMATIONS.has(spec.animation)) {
      errors.push(`${where}: animation must be one of ${[...ANIMATIONS].join('|')}, `
        + `got ${JSON.stringify(spec.animation)}`);
    }
    const t = themes[slug];
    const bgHexes = t
      ? [['light', tokenHex(t.light['--bg-100'], `${where} light bg`)],
        ['dark', tokenHex(t.dark['--bg-100'], `${where} dark bg`)]]
      : [];
    validatePathList(spec.paths, `${where}.paths`, errors, bgHexes);
    if (spec.animation === 'flip') {
      if (spec.paths2 === undefined) errors.push(`${where}: animation "flip" needs a second frame (paths2)`);
      else validatePathList(spec.paths2, `${where}.paths2`, errors, bgHexes);
    } else if (spec.paths2 !== undefined) {
      errors.push(`${where}: paths2 is only valid with animation "flip"`);
    }

    const emit = { viewBox: spec.viewBox, animation: spec.animation, paths: spec.paths };
    if (spec.paths2 !== undefined) emit.paths2 = spec.paths2;
    out[slug] = emit;
  }
  return out;
}

/* ------------------------------------------------------------------ input */

function slugify(name) {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function readPalettes(root) {
  if (!fs.existsSync(root)) throw new Error(`palette repo not found: ${root}`);
  const out = [];
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
  for (const dir of entries) {
    const name = dir.replace(/\.json$/i, '');
    const dirPath = path.join(root, dir);
    const jsons = fs.readdirSync(dirPath).filter((f) => f.toLowerCase().endsWith('.json')).sort();
    if (jsons.length === 0) throw new Error(`${dirPath}: no .json palette file`);
    const file = jsons.includes(`${name}.json`) ? `${name}.json` : jsons[0];
    const full = path.join(dirPath, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (e) {
      throw new Error(`${full}: invalid JSON: ${e.message}`);
    }
    out.push({ name, slug: slugify(name), file: full, data, extraFiles: jsons.length - 1 });
  }
  return out;
}

/** Parse the __cdb_builtins object out of the theme patch (one theme per line). */
function readBuiltins() {
  const src = fs.readFileSync(THEME_PATCH, 'utf8').split('\n');
  const start = src.findIndex((l) => l.startsWith('var __cdb_builtins='));
  if (start < 0) throw new Error(`${THEME_PATCH}: __cdb_builtins not found`);
  const out = {};
  for (let i = start + 1; i < src.length; i++) {
    let line = src[i].trim();
    if (line.startsWith('};')) break;
    if (!line.startsWith('"')) throw new Error(`${THEME_PATCH}:${i + 1}: unexpected builtin line`);
    if (line.endsWith(',')) line = line.slice(0, -1);
    Object.assign(out, JSON.parse(`{${line}}`));
  }
  if (Object.keys(out).length === 0) throw new Error(`${THEME_PATCH}: parsed 0 built-ins`);
  return out;
}

/* -------------------------------------------------------------------- svg */

const SVG_FONT = 'ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif';
const BUBBLES = [
  ['--bg-000', 'elevated surface'],
  ['--text-000', 'text'],
  ['--accent-brand', 'primary'],
  ['--accent-pro-100', 'secondary'],
  ['--danger-100', 'error'],
  ['--warning-100', 'warning'],
  ['--success-100', 'success'],
  ['--border-100', 'border'],
];

const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** HSL token value -> hex, for SVG fills. */
function tokenHex(value, where) {
  const m = /^(\d+(?:\.\d+)?) (\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%$/.exec(value);
  if (!m) throw new Error(`${where}: cannot render token value ${JSON.stringify(value)}`);
  return hslToHex({ h: Number(m[1]), s: Number(m[2]), l: Number(m[3]) });
}

/**
 * One swatch row. Tolerant of a partial token map (the gaming themes are
 * hand-authored and may define only a subset): a token that is absent renders
 * as an empty outlined slot instead of aborting the whole run.
 */
function svgRow(tokens, label, y, where) {
  const pick = (...keys) => keys.map((k) => tokens[k]).find((v) => typeof v === 'string');
  const bgVal = pick('--bg-100', '--bg-000');
  const fgVal = pick('--text-000', '--text-100');
  if (!bgVal || !fgVal) throw new Error(`${where}: needs at least --bg-100 and --text-000`);
  const bg = tokenHex(bgVal, where);
  const fg = tokenHex(fgVal, where);
  const parts = [
    `<rect x="8" y="${y}" width="624" height="50" rx="10" fill="${bg}"/>`,
    `<text x="22" y="${y + 30}" font-family="${SVG_FONT}" font-size="13" font-weight="600" fill="${fg}">${label}</text>`,
  ];
  BUBBLES.forEach(([token, title], i) => {
    const cx = 158 + i * 58;
    const value = tokens[token];
    if (typeof value !== 'string') {
      parts.push(
        `<circle cx="${cx}" cy="${y + 25}" r="18" fill="none" stroke="${fg}" stroke-opacity=".28" stroke-dasharray="3 3"><title>${xmlEscape(title)}: not defined</title></circle>`,
      );
      return;
    }
    const hex = tokenHex(value, `${where} ${token}`);
    parts.push(
      `<circle cx="${cx}" cy="${y + 25}" r="18" fill="${hex}" stroke="${fg}" stroke-opacity=".28"><title>${xmlEscape(title)}: ${hex}</title></circle>`,
    );
  });
  return parts.join('');
}

function renderSvg(displayName, theme, where) {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 120" width="640" height="120" role="img">',
    `<title>${xmlEscape(displayName)} palette (dark and light)</title>`,
    svgRow(theme.dark, 'dark', 8, `${where} dark`),
    svgRow(theme.light, 'light', 62, `${where} light`),
    '</svg>',
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------- main */

function serialize(themes, spinners) {
  const slugs = Object.keys(themes).sort();
  const body = slugs.map((slug) => {
    const t = themes[slug];
    const variant = (v) => `    ${JSON.stringify(v)}: {`
      + TOKEN_ORDER.map((k) => `${JSON.stringify(k)}: ${JSON.stringify(t[v][k])}`).join(', ')
      + '}';
    return `  ${JSON.stringify(slug)}: {\n`
      + `    "name": ${JSON.stringify(t.name)},\n`
      + `    "spinner": ${JSON.stringify(spinners[slug])},\n`
      + `${variant('light')},\n`
      + `${variant('dark')}\n`
      + '  }';
  }).join(',\n');
  return `{\n${body}\n}\n`;
}

/** Hand-authored themed collections (gaming, linux, lollipop), consumed read-only for swatch cards. */
function readThemeCollection(file, label, warnings, errors) {
  if (!fs.existsSync(file)) return {};
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    errors.push(`${file}: invalid JSON: ${e.message}`);
    return {};
  }
  const out = {};
  for (const slug of Object.keys(data).sort()) {
    const t = data[slug];
    if (!t || typeof t.light !== 'object' || typeof t.dark !== 'object') {
      warnings.push(`${label} theme "${slug}": no light/dark token maps, no swatch emitted`);
      continue;
    }
    out[slug] = { name: t.name || slug, light: t.light, dark: t.dark };
  }
  return out;
}

function main() {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_PALETTES;
  const errors = [];
  const warnings = [];
  const quality = [];

  const builtins = readBuiltins();
  const expectedKeys = new Set(Object.keys(builtins[Object.keys(builtins).sort()[0]].light));
  if (expectedKeys.size !== TOKEN_ORDER.length) {
    errors.push(`built-in key set has ${expectedKeys.size} tokens, TOKEN_ORDER has ${TOKEN_ORDER.length}`);
  }
  for (const k of TOKEN_ORDER) {
    if (!expectedKeys.has(k)) errors.push(`TOKEN_ORDER has ${k} which no built-in defines`);
  }

  const palettes = readPalettes(root);
  const themes = {};
  const bySlug = new Map();

  for (const p of palettes) {
    const where = p.file;
    if (p.extraFiles > 0) warnings.push(`${p.name}: directory holds ${p.extraFiles + 1} json files, used ${path.basename(p.file)}`);
    if (!p.slug) { errors.push(`${p.name}: slug is empty`); continue; }
    if (bySlug.has(p.slug)) {
      errors.push(`slug collision: ${JSON.stringify(p.slug)} from both "${bySlug.get(p.slug)}" and "${p.name}"`);
      continue;
    }
    bySlug.set(p.slug, p.name);

    for (const v of ['dark', 'light']) {
      if (!p.data || typeof p.data[v] !== 'object' || p.data[v] === null) {
        errors.push(`${where}: missing "${v}" variant`);
      }
    }
    if (errors.length && (!p.data?.dark || !p.data?.light)) continue;

    let dark, light;
    try {
      dark = convertVariant(p.data.dark, 'dark', where);
      light = convertVariant(p.data.light, 'light', where);
    } catch (e) {
      errors.push(String(e.message));
      continue;
    }
    warnings.push(...dark.warnings.map((w) => `${p.name}: ${w}`));
    warnings.push(...light.warnings.map((w) => `${p.name}: ${w}`));

    if (!dark.isDark) quality.push(`${p.name}: "dark" variant surface is light (L=${dark.surfL.toFixed(1)}) - polarity taken from the measurement`);
    if (light.isDark) quality.push(`${p.name}: "light" variant surface is dark (L=${light.surfL.toFixed(1)}) - polarity taken from the measurement`);
    for (const [vn, v] of [['dark', dark], ['light', light]]) {
      const delta = Math.abs(v.onSurfL - v.surfL);
      if (delta < 20) quality.push(`${p.name} (${vn}): low onSurface/surface lightness delta ${delta.toFixed(1)}`);
      const ladder = ['--bg-100', '--bg-200', '--bg-300', '--bg-400', '--bg-500']
        .map((k) => Number(v.tokens[k].split(' ')[2].replace('%', '')));
      if (Math.abs(ladder[0] - ladder[4]) < 1) {
        quality.push(`${p.name} (${vn}): surface clamps at L=${ladder[0].toFixed(1)}, so bg-100..500 are flat (expected for AMOLED palettes; panels still lift at bg-000)`);
      }
      if (!v.isDark && v.surfL < 80) {
        quality.push(`${p.name} (${vn}): surface is a mid tone (L=${v.surfL.toFixed(1)}) - reads as a dim theme rather than a light one`);
      }
      const cText = contrast(v.tokens['--claude-foreground-color'], v.tokens['--claude-background-color']);
      if (cText < 4.5) quality.push(`${p.name} (${vn}): text on surface contrast ${cText.toFixed(2)} (< 4.5)`);
      const cOn = contrast(
        tokenHex(v.tokens['--accent-brand'], `${p.name} ${vn} --accent-brand`),
        tokenHex(v.tokens['--oncolor-100'], `${p.name} ${vn} --oncolor-100`),
      );
      if (cOn < 4.5) quality.push(`${p.name} (${vn}): emitted oncolor on accent contrast ${cOn.toFixed(2)} (< 4.5)`);
    }

    validateVariant(dark.tokens, expectedKeys, `${p.slug}/dark`, errors);
    validateVariant(light.tokens, expectedKeys, `${p.slug}/light`, errors);

    themes[p.slug] = { name: p.name, light: light.tokens, dark: dark.tokens };
  }

  /* curated spinner glyphs (hard gate: every theme, every spec well formed) */
  const spinners = readSpinners(themes, errors);
  const gaming = readThemeCollection(GAMING_JSON, 'gaming', warnings, errors);
  const linux = readThemeCollection(LINUX_JSON, 'linux', warnings, errors);
  const lollipop = readThemeCollection(LOLLIPOP_JSON, 'lollipop', warnings, errors);

  if (errors.length) {
    console.error('[generate-community-themes] FAILED:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  /* write the token map */
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, serialize(themes, spinners));
  JSON.parse(fs.readFileSync(OUT_JSON, 'utf8')); // re-parse guard

  /* write swatches: community themes + built-ins + gaming + linux + lollipop */
  fs.mkdirSync(OUT_SVG_DIR, { recursive: true });
  const svgWritten = [];
  const svgTargets = new Map();
  for (const slug of Object.keys(themes).sort()) {
    svgTargets.set(slug, { name: themes[slug].name, theme: themes[slug] });
  }
  for (const slug of Object.keys(builtins).sort()) {
    if (svgTargets.has(slug)) {
      warnings.push(`swatch name collision: community slug "${slug}" also names a built-in; built-in swatch wins`);
    }
    svgTargets.set(slug, { name: slug, theme: builtins[slug] });
  }
  for (const [label, col] of [['gaming', gaming], ['linux', linux], ['lollipop', lollipop]]) {
    for (const slug of Object.keys(col).sort()) {
      if (svgTargets.has(slug)) {
        warnings.push(`swatch name collision: ${label} slug "${slug}" already exists; ${label} swatch wins`);
      }
      svgTargets.set(slug, { name: col[slug].name, theme: col[slug] });
    }
  }
  for (const [slug, t] of [...svgTargets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const file = path.join(OUT_SVG_DIR, `${slug}.svg`);
    fs.writeFileSync(file, renderSvg(t.name, t.theme, slug));
    svgWritten.push(file);
  }

  /* report */
  const slugs = Object.keys(themes).sort();
  console.log(`[generate-community-themes] source: ${root}`);
  console.log(`[generate-community-themes] themes: ${slugs.length}`);
  console.log(`[generate-community-themes] wrote:  ${path.relative(REPO, OUT_JSON)} (${fs.statSync(OUT_JSON).size} bytes)`);
  console.log(`[generate-community-themes] wrote:  ${svgWritten.length} swatches in ${path.relative(REPO, OUT_SVG_DIR)}/`
    + ` (${slugs.length} community + ${Object.keys(builtins).length} built-in + ${Object.keys(gaming).length} gaming + ${Object.keys(linux).length} linux + ${Object.keys(lollipop).length} lollipop)`);
  const flips = slugs.filter((s) => spinners[s].animation === 'flip');
  const fills = slugs.filter((s) => spinners[s].paths.some((p) => p.fill));
  console.log(`[generate-community-themes] spinners: ${slugs.length} validated`
    + `, ${new Set(slugs.map((s) => JSON.stringify(spinners[s].paths))).size} distinct glyphs`
    + `, ${flips.length} flip (${flips.join(', ') || 'none'})`
    + `, ${fills.length} with explicit fills (${fills.join(', ') || 'none'})`);

  const collisions = slugs.filter((s) => BUILTIN_NAMES.has(s) || BUILTIN_ALIASES.has(s));
  console.log(`[generate-community-themes] built-in name collisions: ${collisions.length ? collisions.join(', ') : 'none'}`);

  if (warnings.length) {
    console.log('[generate-community-themes] warnings:');
    for (const w of warnings) console.log(`  - ${w}`);
  }
  if (quality.length) {
    console.log('[generate-community-themes] quality notes:');
    for (const q of quality) console.log(`  - ${q}`);
  }
  console.log('[generate-community-themes] slugs:');
  for (const s of slugs) console.log(`  ${s}  (${themes[s].name})`);
}

main();
