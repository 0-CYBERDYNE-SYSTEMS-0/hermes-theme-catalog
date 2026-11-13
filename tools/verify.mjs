#!/usr/bin/env node
/**
 * Verify the generated catalog end to end, without the desktop app.
 *
 * Checks, for every profile:
 *   - all 26 desktop tokens and 16 ANSI slots are valid hex
 *   - readability floors (body text 4.5:1, muted text 4.5:1, destructive 3:1)
 *   - the profile's own background/foreground/ANSI survive verbatim
 *   - names are unique and match the catalog-* contract
 *
 * Usage: node tools/verify.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { themeFromProfile, validateTheme, contrast, TOKEN_KEYS, TERMINAL_KEYS } from '../src/theme-map.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const profiles = JSON.parse(readFileSync(join(root, 'build/profiles.json'), 'utf8'))

const failures = []
const lowContrast = []
const names = new Set()
let minBody = { ratio: Infinity, label: '' }
let minMuted = { ratio: Infinity, label: '' }

const ANSI_KEYS = TERMINAL_KEYS.filter(k => !['foreground', 'cursor', 'selectionBackground'].includes(k))

for (const profile of profiles) {
  const theme = themeFromProfile(profile)

  for (const problem of validateTheme(theme)) failures.push(`${profile.label}: ${problem}`)

  if (names.has(theme.name)) failures.push(`${profile.label}: duplicate name ${theme.name}`)
  names.add(theme.name)

  // Fidelity: the profile is the source of truth.
  if (theme.colors.background !== profile.bg) failures.push(`${profile.label}: background not verbatim`)
  for (let i = 0; i < 16; i += 1) {
    if (theme.terminal[ANSI_KEYS[i]] !== profile.ansi[i]) failures.push(`${profile.label}: ansi[${i}] not verbatim`)
  }
  if (theme.terminal.foreground !== profile.fg) failures.push(`${profile.label}: terminal foreground not verbatim`)
  const ownFg = contrast(profile.fg, profile.bg)
  if (ownFg < 4.5) lowContrast.push(`${profile.label} (${ownFg.toFixed(2)}:1)`)

  const body = contrast(theme.colors.foreground, theme.colors.background)
  if (body < minBody.ratio) minBody = { ratio: body, label: profile.label }
  const muted = contrast(theme.colors.mutedForeground, theme.colors.muted)
  if (muted < minMuted.ratio) minMuted = { ratio: muted, label: profile.label }

  if (!TOKEN_KEYS.every(k => /^#[0-9a-f]{6}$/i.test(theme.colors[k]))) {
    failures.push(`${profile.label}: token set incomplete`)
  }
}

const modes = profiles.reduce((acc, p) => acc + (themeFromProfile(p).mode === 'dark' ? 1 : 0), 0)

// ── primary-color repaint ───────────────────────────────────────────────────
// The editor replaces one primary color and the whole token set is rebuilt from
// the profile again. Check the contract every edit has to meet.
const repaintFailures = []
const sample = [profiles[0], profiles[1], profiles[Math.floor(profiles.length / 2)], profiles[profiles.length - 1]]

for (const profile of sample) {
  const bgEdit = themeFromProfile(profile, { bg: '#101014' })
  if (bgEdit.colors.background !== '#101014') repaintFailures.push(`${profile.label}: new background not applied`)
  for (const problem of validateTheme(bgEdit)) repaintFailures.push(`${profile.label} bg edit: ${problem}`)
  // Everything else on the theme must still come from the profile.
  for (let i = 0; i < 16; i += 1) {
    if (bgEdit.terminal[ANSI_KEYS[i]] !== profile.ansi[i]) repaintFailures.push(`${profile.label}: ANSI changed during a bg edit`)
  }

  const fgEdit = themeFromProfile(profile, { fg: '#ff8800' })
  if (fgEdit.terminal.foreground !== '#ff8800') repaintFailures.push(`${profile.label}: terminal foreground not the picked color`)
  if (contrast(fgEdit.colors.foreground, fgEdit.colors.background) < 4.5) repaintFailures.push(`${profile.label}: picked text color breaks the 4.5:1 floor`)

  const lightEdit = themeFromProfile(profile, { bg: '#fdf6e3', fg: '#002b36' })
  if (lightEdit.mode !== 'light') repaintFailures.push(`${profile.label}: switching to a light background did not flip the mode`)
  for (const problem of validateTheme(lightEdit)) repaintFailures.push(`${profile.label} light edit: ${problem}`)

  // Garbage must never reach a theme.
  const junk = themeFromProfile(profile, { bg: 'nope', fg: '#12' })
  if (junk.colors.background !== profile.bg) repaintFailures.push(`${profile.label}: invalid background was applied`)
  if (junk.terminal.foreground !== profile.fg) repaintFailures.push(`${profile.label}: invalid foreground was applied`)
}

console.log(`profiles checked : ${profiles.length}`)
console.log(`unique names     : ${names.size}`)
console.log(`dark / light     : ${modes} / ${profiles.length - modes}`)
console.log(`min body contrast: ${minBody.ratio.toFixed(2)}:1 (${minBody.label})`)
console.log(`min muted        : ${minMuted.ratio.toFixed(2)}:1 on the muted surface (${minMuted.label})`)
console.log(`failures         : ${failures.length}`)
console.log(`profiles whose own fg is under 4.5:1 (kept verbatim in the terminal palette): ${lowContrast.length}`)
for (const line of lowContrast.slice(0, 8)) console.log('  ·', line)
console.log(`repaint checks   : ${repaintFailures.length === 0 ? 'pass' : `${repaintFailures.length} failures`} (${sample.length} sampled profiles x bg/fg/light/junk)`)
for (const line of repaintFailures.slice(0, 15)) console.log('  ✗', line)
for (const line of failures.slice(0, 25)) console.log('  ✗', line)

process.exit(failures.length === 0 && repaintFailures.length === 0 ? 0 : 1)
