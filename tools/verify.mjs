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
  const muted = contrast(theme.colors.mutedForeground, theme.colors.background)
  if (muted < minMuted.ratio) minMuted = { ratio: muted, label: profile.label }

  if (!TOKEN_KEYS.every(k => /^#[0-9a-f]{6}$/i.test(theme.colors[k]))) {
    failures.push(`${profile.label}: token set incomplete`)
  }
}

const modes = profiles.reduce((acc, p) => acc + (themeFromProfile(p).mode === 'dark' ? 1 : 0), 0)

console.log(`profiles checked : ${profiles.length}`)
console.log(`unique names     : ${names.size}`)
console.log(`dark / light     : ${modes} / ${profiles.length - modes}`)
console.log(`min body contrast: ${minBody.ratio.toFixed(2)}:1 (${minBody.label})`)
console.log(`min muted        : ${minMuted.ratio.toFixed(2)}:1 (${minMuted.label})`)
console.log(`failures         : ${failures.length}`)
console.log(`profiles whose own fg is under 4.5:1 (kept verbatim in the terminal palette): ${lowContrast.length}`)
for (const line of lowContrast.slice(0, 8)) console.log('  ·', line)
for (const line of failures.slice(0, 25)) console.log('  ✗', line)

process.exit(failures.length === 0 ? 0 : 1)
