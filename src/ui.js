// ── catalog state ───────────────────────────────────────────────────────────

const $query = atom('')
const $lastApplied = atom(null)

// Every profile is mapped once at module load. Pure math, no I/O: 606 profiles
// cost a few thousand cheap contrast evaluations.
const THEMES = PROFILES.map(themeFromProfile)
const THEME_BY_NAME = new Map(THEMES.map(t => [t.name, t]))

const ANSI_ORDER = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
  'brightMagenta', 'brightCyan', 'brightWhite'
]

/**
 * Fixed reading order, the same on every row: the page background, the body
 * text, then the sixteen ANSI slots. Derived in the view rather than stored,
 * so `plugin.js` does not carry 606 copies of a list it can compute.
 */
const stripCells = theme => [
  { key: 'background', hex: theme.colors.background, title: `background ${theme.colors.background}` },
  { key: 'foreground', hex: theme.colors.foreground, title: `body text ${theme.colors.foreground}` },
  ...ANSI_ORDER.map(key => ({ key, hex: theme.terminal[key], title: `${key} ${theme.terminal[key]}` }))
]

const matches = (theme, q) => {
  if (!q) return true
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  return theme.label.toLowerCase().includes(needle) || theme.name.includes(needle)
}

function applyTheme(theme) {
  const ok = typeof requestTheme === 'function' && Boolean(requestTheme(theme.name))
  $lastApplied.set(ok ? theme.name : `${theme.label} ✗`)
  if (!ok) host.notifyError(`Desktop refused "${theme.label}" — is it registered in Appearance?`)
  return ok
}

function copyTheme(theme) {
  try {
    const payload = JSON.stringify(
      { name: theme.name, label: theme.label, description: theme.description, colors: theme.colors, terminal: theme.terminal },
      null,
      2
    )
    void navigator.clipboard?.writeText(payload)
    host.notify(`Copied ${theme.label} as JSON`)
  } catch (err) {
    host.notifyError(`Copy failed: ${err?.message || err}`)
  }
}

function Strip({ theme, size = 14 }) {
  const cells = stripCells(theme)
  const out = []
  cells.forEach((cell, i) => {
    if (i === 2) {
      out.push(jsx('span', { key: 'divider', style: { width: 1, height: size + 2, background: 'var(--ui-border)', margin: '0 5px' } }))
    }
    out.push(
      jsx('span', {
        title: cell.title,
        style: {
          width: size,
          height: size,
          borderRadius: 3,
          background: cell.hex,
          boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.25)'
        }
      })
    )
  })
  return jsx('div', { style: { display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }, children: out })
}

function CatalogRow({ theme, active }) {
  return jsxs('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '7px 10px',
      borderRadius: 6,
      border: `1px solid ${active ? 'var(--ui-accent)' : 'var(--ui-border)'}`,
      background: active ? 'var(--ui-row-active-background)' : 'var(--ui-bg-secondary)'
    },
    children: [
      jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 }, children: [
        jsxs('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }, children: [
          jsx('span', {
            style: { fontSize: 12, fontWeight: 500, color: 'var(--ui-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            children: theme.label
          }),
          jsx('span', {
            style: { fontSize: 10, color: 'var(--ui-text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.4 },
            children: theme.mode
          }),
          active ? jsx('span', { style: { fontSize: 10, color: 'var(--ui-accent)' }, children: '● applied' }) : null
        ] }),
        jsx(Strip, { theme })
      ] }),
      jsxs('div', { style: { display: 'flex', gap: 6, flexShrink: 0 }, children: [
        jsx(Button, {
          size: 'sm',
          variant: active ? 'secondary' : 'default',
          onClick: () => applyTheme(theme),
          children: active ? 'Applied' : 'Apply'
        }),
        jsx(Button, { size: 'sm', variant: 'ghost', onClick: () => copyTheme(theme), children: 'Copy' })
      ] })
    ]
  })
}

function CatalogPage() {
  const q = useValue($query)
  const { themeName } = useTheme()
  const lastApplied = useValue($lastApplied)

  const filtered = useMemo(() => THEMES.filter(t => matches(t, q)), [q])

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 12, height: '100%', padding: 16, minHeight: 0 },
    children: [
      jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 }, children: [
        jsx('h1', { style: { fontSize: 16, fontWeight: 600, color: 'var(--ui-text-primary)', margin: 0 }, children: 'Theme Catalog' }),
        jsx('p', {
          style: { fontSize: 12, color: 'var(--ui-text-secondary)', margin: 0 },
          children: `${THEMES.length} terminal profiles from iTerm2-Color-Schemes, mapped to full desktop themes. Every row reads BG · FG first, then the 16 ANSI slots. Apply pins one as your skin; it survives restart.`
        })
      ] }),
      jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 10 }, children: [
        jsx(Input, {
          value: q,
          placeholder: 'Filter by name — gruvbox, nord, tokyo…',
          onChange: ev => $query.set(ev.target.value),
          style: { maxWidth: 380 }
        }),
        jsx('span', { style: { fontSize: 11, color: 'var(--ui-text-tertiary)' }, children: `${filtered.length} match${filtered.length === 1 ? '' : 'es'}` }),
        lastApplied ? jsx('span', { style: { fontSize: 11, color: 'var(--ui-text-tertiary)' }, children: `last: ${lastApplied}` }) : null
      ] }),
      jsx(ScrollArea, {
        style: { flex: 1, minHeight: 0 },
        children: jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 5, paddingRight: 6 }, children: [
          filtered.map(theme => jsx(CatalogRow, { theme, active: themeName === theme.name }, theme.name)),
        ] })
      })
    ]
  })
}

// ── plugin entry ────────────────────────────────────────────────────────────

export default {
  id: 'theme-catalog',
  name: 'Theme Catalog',

  register(ctx) {
    const disposers = []
    for (const theme of THEMES) {
      disposers.push(ctx.register({ id: `theme:${theme.name}`, area: THEMES_AREA, data: theme }))
    }

    // A page, not a pane: closing a plugin's only pane disables the plugin and
    // would unregister every catalog theme with it.
    ctx.register({ id: 'page', area: ROUTES_AREA, data: { path: '/theme-catalog' }, render: () => jsx(CatalogPage, {}) })
    ctx.register({ id: 'nav', area: SIDEBAR_NAV_AREA, data: { path: '/theme-catalog', label: 'Theme Catalog', codicon: 'symbol-color' } })
    ctx.register({
      id: 'palette-open',
      area: PALETTE_AREA,
      data: {
        id: 'theme-catalog-open',
        label: 'Theme Catalog: browse 606 terminal themes',
        keywords: ['theme', 'skin', 'color', 'palette', 'catalog', 'iterm'],
        run: () => host.navigate('/theme-catalog')
      }
    })

    ctx.onDispose(() => {
      for (const dispose of disposers) dispose()
      disposers.length = 0
    })
  }
}
