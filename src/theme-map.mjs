/**
 * Pure color math for the Theme Catalog plugin.
 *
 * No SDK imports, no DOM: this module is imported directly by tools/verify.mjs
 * and concatenated into the shipped desktop/plugin.js by tools/build.py.
 */

const rgbToHex = (r, g, b) =>
  '#' +
  [r, g, b]
    .map(n =>
      Math.round(Math.min(255, Math.max(0, n)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')

const hexToRgb = hex => {
  const c = String(hex).trim().replace(/^#/, '')
  if (!/^[0-9a-f]{6}$/i.test(c)) return null
  return [0, 2, 4].map(i => parseInt(c.slice(i, i + 2), 16))
}

const mix = (a, b, t) => {
  const A = hexToRgb(a)
  const B = hexToRgb(b)
  return A && B ? rgbToHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t) : a
}

const lin = c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

const luminance = hex => {
  const rgb = hexToRgb(hex)
  if (!rgb) return 0
  const [r, g, b] = rgb.map(v => lin(v / 255))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const contrast = (a, b) => {
  const la = luminance(a)
  const lb = luminance(b)
  return la >= lb ? (la + 0.05) / (lb + 0.05) : (lb + 0.05) / (la + 0.05)
}

const readableOn = bg => (contrast('#161616', bg) >= contrast('#ffffff', bg) ? '#161616' : '#ffffff')

/**
 * Walk a color toward pure black or white until it clears `min` against `bg`.
 * Both polarities are tried, and the walk targets #000/#fff rather than a
 * near-black: a mid-tone background such as #ea3323 needs pure black to reach
 * 5:1, so targeting #161616 would stall below the floor.
 */
const ensureContrast = (color, bg, min) => {
  if (contrast(color, bg) >= min) return color
  const black = '#000000'
  const white = '#ffffff'
  const best = contrast(black, bg) >= contrast(white, bg) ? black : white
  if (contrast(best, bg) < min) return best // unattainable floor; take the maximum
  for (let t = 0.05; t <= 1.001; t += 0.05) {
    const candidate = mix(color, best, t)
    if (contrast(candidate, bg) >= min) return candidate
  }
  return best
}

/**
 * Every theme needs a description even though the type marks it optional: the
 * app's root ⌘K palette builds its search keywords from `theme.description`
 * unguarded, so a theme without one puts `undefined` into the keyword array and
 * cmdk throws "cannot read properties of undefined (reading 'trim')" the moment
 * the palette renders. Never register a theme without this.
 */
const CATALOG_DESCRIPTION = 'Terminal profile · iTerm2-Color-Schemes'

const TOKEN_KEYS = [
  'background',
  'foreground',
  'card',
  'cardForeground',
  'muted',
  'mutedForeground',
  'popover',
  'popoverForeground',
  'primary',
  'primaryForeground',
  'secondary',
  'secondaryForeground',
  'accent',
  'accentForeground',
  'border',
  'input',
  'ring',
  'midground',
  'midgroundForeground',
  'composerRing',
  'destructive',
  'destructiveForeground',
  'sidebarBackground',
  'sidebarBorder',
  'userBubble',
  'userBubbleBorder'
]

const TERMINAL_KEYS = [
  'foreground',
  'cursor',
  'selectionBackground',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
]

/**
 * Turn a terminal color profile into a Hermes DesktopTheme.
 *
 * The profile is the source of truth: background, foreground and all sixteen
 * ANSI slots land verbatim. The desktop-only tokens (card, border, ring, the
 * sidebar and bubble surfaces) are derived from those colors rather than
 * invented, so a theme built from Gruvbox actually looks like Gruvbox.
 */
const themeFromProfile = (profile, patch) => {
  // `patch` replaces one or both primary colors (profile keys: bg / fg) so the
  // user can repaint a theme and have every derived token recompute from the
  // new pair. Values that are not 6-digit hex are ignored, never trusted.
  const hexOr = (value, fallback) => (/^#[0-9a-f]{6}$/i.test(String(value ?? '')) ? String(value).toLowerCase() : fallback)
  const bg = hexOr(patch?.bg, String(profile.bg).toLowerCase())
  const rawFg = hexOr(patch?.fg, String(profile.fg).toLowerCase())
  // UI text gets the readability floor; the terminal keeps the profile's own
  // foreground verbatim, because the palette is the thing being reproduced.
  const fg = ensureContrast(rawFg, bg, 4.5)
  const ansi = profile.ansi
  const dark = luminance(bg) < 0.5

  const red = ansi[1]
  const blue = ansi[4]
  const cyan = ansi[6]
  const brightBlue = ansi[12]
  const brightCyan = ansi[14]

  // Accent: the palette's own bright blue when it reads on the background,
  // otherwise whichever of blue/cyan/bright cyan has the most contrast.
  const accentPool = [brightBlue, blue, brightCyan, cyan]
  const accentSeed = accentPool.find(c => contrast(c, bg) >= 3) || accentPool.sort((a, b) => contrast(b, bg) - contrast(a, bg))[0]
  const accent = ensureContrast(accentSeed, bg, 4.5)

  const card = mix(bg, fg, dark ? 0.05 : 0.04)
  const muted = mix(bg, fg, dark ? 0.12 : 0.1)
  const secondary = mix(bg, fg, dark ? 0.16 : 0.13)
  const hover = mix(bg, accent, dark ? 0.18 : 0.12)
  const destructive = ensureContrast(red, bg, 3)

  // Every foreground is measured against the surface it paints on. Deriving
  // muted text against the window background instead of the muted surface is
  // how these themes end up at 3.6:1 on hover rows.
  const onSurface = (surface, min) => ensureContrast(fg, surface, min)

  const colors = {
    background: bg,
    foreground: fg,
    card,
    cardForeground: onSurface(card, 4.5),
    muted,
    mutedForeground: onSurface(muted, 4.5),
    popover: card,
    popoverForeground: onSurface(card, 4.5),
    primary: accent,
    primaryForeground: ensureContrast(readableOn(accent), accent, 4.5),
    secondary,
    secondaryForeground: onSurface(secondary, 4.5),
    accent: hover,
    accentForeground: onSurface(hover, 4.5),
    border: mix(bg, fg, dark ? 0.22 : 0.18),
    input: mix(bg, fg, dark ? 0.24 : 0.2),
    ring: accent,
    midground: accent,
    midgroundForeground: ensureContrast(readableOn(accent), accent, 4.5),
    composerRing: accent,
    destructive,
    destructiveForeground: ensureContrast(readableOn(red), destructive, 4.5),
    sidebarBackground: mix(bg, fg, dark ? 0.03 : 0.02),
    sidebarBorder: mix(bg, fg, dark ? 0.24 : 0.2),
    userBubble: mix(bg, accent, dark ? 0.16 : 0.1),
    userBubbleBorder: mix(bg, accent, 0.3)
  }

  const terminal = {
    foreground: rawFg,
    cursor: ensureContrast(ansi[6], bg, 3),
    selectionBackground: dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.14)',
    black: ansi[0],
    red: ansi[1],
    green: ansi[2],
    yellow: ansi[3],
    blue: ansi[4],
    magenta: ansi[5],
    cyan: ansi[6],
    white: ansi[7],
    brightBlack: ansi[8],
    brightRed: ansi[9],
    brightGreen: ansi[10],
    brightYellow: ansi[11],
    brightBlue: ansi[12],
    brightMagenta: ansi[13],
    brightCyan: ansi[14],
    brightWhite: ansi[15]
  }

  return {
    name: profile.slug,
    display: null,
    label: profile.label,
    description: profile.description || CATALOG_DESCRIPTION,
    mode: dark ? 'dark' : 'light',
    colors,
    terminal
  }
}

/**
 * Structural + readability checks. Returns a list of problems (empty = pass).
 * Each foreground token is measured against the surface it actually paints on,
 * not against the window background: muted text sits on `muted`, card text on
 * `card`, hover-label text on `accent`.
 */
const validateTheme = theme => {
  const problems = []
  if (!/^catalog-[a-z0-9-]+$/.test(theme.name)) problems.push(`bad name ${theme.name}`)
  if (!theme.label) problems.push('missing label')
  for (const key of TOKEN_KEYS) {
    const v = theme.colors[key]
    if (!/^#[0-9a-f]{6}$/i.test(String(v))) problems.push(`colors.${key}=${v}`)
  }
  for (const key of TERMINAL_KEYS) {
    if (key === 'selectionBackground') continue
    const v = theme.terminal[key]
    if (!/^#[0-9a-f]{6}$/i.test(String(v))) problems.push(`terminal.${key}=${v}`)
  }
  const pairs = [
    ['foreground', 'background', 4.5],
    ['cardForeground', 'card', 4.5],
    ['popoverForeground', 'popover', 4.5],
    ['mutedForeground', 'muted', 4.5],
    ['secondaryForeground', 'secondary', 4.5],
    ['accentForeground', 'accent', 4.5],
    ['primaryForeground', 'primary', 4.5],
    ['midgroundForeground', 'midground', 4.5],
    ['destructive', 'background', 3],
    ['destructiveForeground', 'destructive', 4.5]
  ]
  for (const [fgKey, bgKey, min] of pairs) {
    const ratio = contrast(theme.colors[fgKey], theme.colors[bgKey])
    if (ratio < min - 0.02) problems.push(`${fgKey} on ${bgKey}: ${ratio.toFixed(2)} < ${min}`)
  }
  return problems
}

export { hexToRgb, rgbToHex, mix, luminance, contrast, readableOn, ensureContrast, themeFromProfile, validateTheme, TOKEN_KEYS, TERMINAL_KEYS }
