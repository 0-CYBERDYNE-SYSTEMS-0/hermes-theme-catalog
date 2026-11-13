// ── catalog state ───────────────────────────────────────────────────────────

const $query = atom('')
const $lastApplied = atom(null)
/** The open color editor: { name, slot, x, y } in viewport coordinates. */
const $editing = atom(null)
/** Armed lens: { name, slot } — hover a swatch, click to take that color. */
const $lens = atom(null)
const $lastTarget = atom(null)
/** Persisted primary-color overrides: { [themeName]: { bg?, fg? } }. */
const $edits = atom({})
/** Bumped when a theme's colors are mutated in place, so rows re-render. */
const $revision = atom(0)

const EDITS_KEY = 'primary-color-edits'

// Every profile is mapped once at module load. Pure math, no I/O: 606 profiles
// cost a few thousand cheap contrast evaluations.
const THEMES = PROFILES.map(themeFromProfile)
const THEME_BY_NAME = new Map(THEMES.map(t => [t.name, t]))
const PROFILE_BY_NAME = new Map(PROFILES.map(p => [p.slug, p]))

const ANSI_ORDER = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
  'brightMagenta', 'brightCyan', 'brightWhite'
]

const SLOT_PATCH = { background: 'bg', foreground: 'fg' }
const SLOT_LABEL = { background: 'Background', foreground: 'Body text' }

/**
 * Fixed reading order, the same on every row: the page background, the body
 * text, then the sixteen ANSI slots. The first two are editable; every chip
 * carries `data-hex` so the lens can sample it.
 */
const stripCells = theme => [
  {
    key: 'background',
    slot: 'background',
    hex: theme.colors.background,
    title: `Background ${theme.colors.background} — click to edit`
  },
  {
    key: 'foreground',
    slot: 'foreground',
    hex: theme.colors.foreground,
    title: `Body text ${theme.colors.foreground} — click to edit`
  },
  ...ANSI_ORDER.map(key => ({ key, hex: theme.terminal[key], title: `${key} ${theme.terminal[key]}` }))
]

const matches = (theme, q) => {
  if (!q) return true
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  return theme.label.toLowerCase().includes(needle) || theme.name.includes(needle)
}

// ── editing the two primary colors ──────────────────────────────────────────

// Set by register(): re-registering a theme's own id replaces its payload and
// bumps the registry version, which is exactly what repaints the active skin
// live (the ThemeProvider's memo depends on registryVersion).
let republishTheme = null
let persistEdits = () => {}
let revisionTimer = 0

const scheduleRevision = () => {
  clearTimeout(revisionTimer)
  revisionTimer = setTimeout(() => $revision.set($revision.get() + 1), 180)
}

const isHex = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)

const normalizeHex = value => (isHex(value) ? value.toLowerCase() : null)

/**
 * Rebuild a theme's tokens from its profile with one or both primary colors
 * replaced, then mutate the registered object in place. Everything derived —
 * card, borders, muted text, contrast floors — recomputes from the new pair, so
 * an edit produces a coherent theme instead of a patchwork.
 *
 * `patch` uses the profile's own keys (bg / fg).
 */
function applyEdit(name, patch, opts) {
  const theme = THEME_BY_NAME.get(name)
  const profile = PROFILE_BY_NAME.get(name)
  if (!theme || !profile) return false

  const all = { ...$edits.get() }
  const merged = { ...(all[name] || {}), ...patch }
  all[name] = merged
  $edits.set(all)

  const fresh = themeFromProfile(profile, { bg: merged.bg, fg: merged.fg })
  theme.colors = fresh.colors
  theme.terminal = fresh.terminal
  theme.mode = fresh.mode

  if (republishTheme) republishTheme(theme)
  if (opts?.persist !== false) persistEdits()
  scheduleRevision()
  return true
}

function resetEdit(name) {
  const theme = THEME_BY_NAME.get(name)
  const profile = PROFILE_BY_NAME.get(name)
  if (!theme || !profile) return false
  const all = { ...$edits.get() }
  delete all[name]
  $edits.set(all)
  const fresh = themeFromProfile(profile)
  theme.colors = fresh.colors
  theme.terminal = fresh.terminal
  theme.mode = fresh.mode
  if (republishTheme) republishTheme(theme)
  persistEdits()
  scheduleRevision()
  return true
}

const slotValue = (theme, slot) => theme.colors[slot]

/** What the user asked for vs what shipped, when the readability floor moved it. */
function editReport(name, slot) {
  const theme = THEME_BY_NAME.get(name)
  const requested = $edits.get()[name]?.[SLOT_PATCH[slot]]
  if (!theme || !requested) return null
  const applied = slotValue(theme, slot)
  return applied.toLowerCase() === requested.toLowerCase() ? null : { requested, applied }
}

function paintSlot(name, slot, hex) {
  const clean = normalizeHex(hex)
  if (!clean) return false
  return applyEdit(name, { [SLOT_PATCH[slot]]: clean })
}

function copyHex(hex) {
  try {
    void navigator.clipboard?.writeText(hex)
    host.notify(`Copied ${hex}`)
  } catch {
    host.notifyError('Clipboard unavailable')
  }
}

// ── lens: hover a color anywhere on the page and take it ────────────────────

const sampleUnder = (x, y) => {
  const node = typeof document !== 'undefined' ? document.elementFromPoint(x, y) : null
  const hit = node && node.closest ? node.closest('[data-hex]') : null
  return hit ? normalizeHex(hit.getAttribute('data-hex')) : null
}

/** Full-screen sampling through Chromium's EyeDropper, when the app has it. */
async function screenLens(name, slot) {
  if (typeof window === 'undefined' || typeof window.EyeDropper !== 'function') {
    host.notifyError('This build has no screen lens — use Hover pick instead')
    return false
  }
  try {
    const result = await new window.EyeDropper().open()
    if (result?.sRGBHex) return paintSlot(name, slot, result.sRGBHex)
  } catch {
    // The user pressed Esc in the system magnifier: not an error.
  }
  return false
}

// ── rows ────────────────────────────────────────────────────────────────────

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

const chipStyle = (hex, size) => ({
  width: size,
  height: size,
  borderRadius: 3,
  background: hex,
  boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.25)',
  border: 'none',
  padding: 0,
  flexShrink: 0
})

function Strip({ theme, size = 14, onEdit }) {
  const cells = stripCells(theme)
  const out = []
  cells.forEach((cell, i) => {
    if (i === 2) {
      out.push(jsx('span', { key: 'divider', style: { width: 1, height: size + 2, background: 'var(--ui-border)', margin: '0 5px' } }))
    }
    if (cell.slot && onEdit) {
      out.push(
        jsx('button', {
          'aria-label': `Edit ${SLOT_LABEL[cell.slot].toLowerCase()} — ${cell.hex}`,
          'data-hex': cell.hex,
          key: cell.key,
          onClick: ev => {
            const rect = ev.currentTarget.getBoundingClientRect()
            onEdit(theme.name, cell.slot, rect)
          },
          style: { ...chipStyle(cell.hex, size + 3), cursor: 'pointer', outline: 'none' },
          title: cell.title,
          type: 'button'
        })
      )
      return
    }
    out.push(jsx('span', { 'data-hex': cell.hex, key: cell.key, style: chipStyle(cell.hex, size), title: cell.title }))
  })
  return jsx('div', { style: { display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }, children: out })
}

function CatalogRow({ theme, active, onEdit }) {
  const edits = useValue($edits)
  const edited = Boolean(edits[theme.name])
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
          edited ? jsx('span', { style: { fontSize: 10, color: 'var(--ui-accent)' }, children: '✎ edited' }) : null,
          active ? jsx('span', { style: { fontSize: 10, color: 'var(--ui-accent)' }, children: '● applied' }) : null
        ] }),
        jsx(Strip, { theme, onEdit })
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

// ── the editor panel ────────────────────────────────────────────────────────

const PANEL_WIDTH = 268

// Node-side harness renders this module without a DOM; keep the geometry helpers
// total instead of sprinkling `typeof window` checks through the components.
const viewport = () => ({
  w: typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1200,
  h: typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 800
})

function RgbField({ channel, value, onCommit }) {
  return jsx('label', {
    style: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 9, color: 'var(--ui-text-tertiary)', textTransform: 'uppercase' },
    children: [
      channel,
      jsx(Input, {
        'aria-label': channel,
        max: 255,
        min: 0,
        onChange: ev => {
          const n = Math.round(Number(ev.target.value))
          if (Number.isFinite(n)) onCommit(channel, Math.min(255, Math.max(0, n)))
        },
        style: { width: 56 },
        type: 'number',
        value: String(value)
      })
    ]
  })
}

function PrimaryEditor({ target, onClose }) {
  const theme = THEME_BY_NAME.get(target.name)
  // Derived, not state: switching tabs rewrites $editing and re-renders with
  // the new slot. A useState copy here would go stale on the first switch.
  const slot = target.slot
  const lens = useValue($lens)
  const edits = useValue($edits)
  const panel = useRef(null)

  const current = theme ? slotValue(theme, slot) : '#000000'
  const [draft, setDraft] = useState(current)

  // Follow the applied value: a lens pick, a preset, or a contrast adjustment
  // all land here. Partial typing never applies, so this does not fight input.
  useEffect(() => {
    if (theme) setDraft(slotValue(theme, slot))
  }, [slot, edits, theme])

  useEffect(() => {
    const onDown = ev => {
      if (panel.current && !panel.current.contains(ev.target)) onClose()
    }
    const onKey = ev => {
      if (ev.key !== 'Escape') return
      if ($lens.get()) $lens.set(null)
      else onClose()
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  if (!theme) return null

  const report = editReport(target.name, slot)
  const rgb = hexToRgb(normalizeHex(draft) || current) || [0, 0, 0]

  const commit = hex => paintSlot(target.name, slot, hex)

  const presetHexes = []
  for (const key of ANSI_ORDER) {
    if (!presetHexes.includes(theme.terminal[key])) presetHexes.push(theme.terminal[key])
  }
  for (const extra of ['#000000', '#ffffff', theme.colors.background, theme.colors.foreground]) {
    if (!presetHexes.includes(extra)) presetHexes.push(extra)
  }

  const { w, h } = viewport()
  const left = Math.max(8, Math.min(target.x - 40, w - PANEL_WIDTH - 12))
  const top = Math.max(12, Math.min(target.y + 10, h - 330))

  const rgbCommit = (channel, value) => {
    const next = [...rgb]
    next[['R', 'G', 'B'].indexOf(channel)] = value
    commit(rgbToHex(next[0], next[1], next[2]))
  }

  return jsxs('div', {
    ref: panel,
    'data-lens-panel': 'true',
    style: {
      position: 'fixed',
      left,
      top,
      width: PANEL_WIDTH,
      zIndex: 90,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      padding: 10,
      borderRadius: 10,
      border: '1px solid var(--ui-border)',
      background: 'var(--ui-bg-elevated)',
      boxShadow: '0 16px 40px rgba(0,0,0,0.32)'
    },
    children: [
      jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 6 }, children: [
        jsx('span', {
          style: { flex: 1, fontSize: 11, fontWeight: 600, color: 'var(--ui-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          children: theme.label
        }),
        jsx('button', {
          'aria-label': 'Close',
          onClick: onClose,
          style: { border: 'none', background: 'transparent', color: 'var(--ui-text-tertiary)', cursor: 'pointer', fontSize: 13, padding: 2 },
          title: 'Close',
          type: 'button',
          children: '✕'
        })
      ] }),
      jsxs('div', { style: { display: 'flex', gap: 4 }, children: [
        ...['background', 'foreground'].map(key =>
          jsx(Button, {
            key,
            onClick: () => setSlotTarget(target.name, key),
            size: 'sm',
            variant: key === slot ? 'secondary' : 'ghost',
            children: SLOT_LABEL[key]
          })
        )
      ] }),
      jsx('div', {
        'data-hex': current,
        style: {
          height: 54,
          borderRadius: 8,
          background: slot === 'background' ? current : theme.colors.background,
          color: slot === 'background' ? theme.colors.foreground : current,
          border: '1px solid var(--ui-border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 17,
          fontWeight: 500
        },
        title: current,
        children: 'Aa · sample text'
      }),
      jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 6 }, children: [
        jsx(Input, {
          'aria-label': 'Hex',
          onChange: ev => {
            const raw = ev.target.value.startsWith('#') ? ev.target.value : `#${ev.target.value}`
            setDraft(raw)
            const clean = normalizeHex(raw)
            if (clean) commit(clean)
          },
          style: { flex: 1, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11 },
          value: draft
        }),
        jsx('input', {
          'aria-label': 'System color picker',
          onChange: ev => commit(ev.target.value),
          style: { width: 38, height: 28, padding: 2, borderRadius: 6, border: '1px solid var(--ui-border)', background: 'transparent', cursor: 'pointer' },
          title: 'System color picker — wheel, sliders, palettes',
          type: 'color',
          value: normalizeHex(draft) || current
        })
      ] }),
      jsxs('div', { style: { display: 'flex', gap: 6 }, children: [
        jsx(RgbField, { channel: 'R', onCommit: rgbCommit, value: rgb[0] }),
        jsx(RgbField, { channel: 'G', onCommit: rgbCommit, value: rgb[1] }),
        jsx(RgbField, { channel: 'B', onCommit: rgbCommit, value: rgb[2] })
      ] }),
      jsx('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(9, 1fr)', gap: 3 },
        children: presetHexes.map(hex =>
          jsx('button', {
            'aria-label': `Use ${hex}`,
            'data-hex': hex,
            key: hex,
            onClick: () => commit(hex),
            title: hex,
            type: 'button',
            style: { ...chipStyle(hex, 18), cursor: 'pointer', borderRadius: 4 }
          })
        )
      }),
      jsxs('div', { style: { display: 'flex', gap: 4 }, children: [
        jsx(Button, {
          onClick: () => {
            const next = { name: target.name, slot }
            $lens.set(next)
            $lastTarget.set(next)
          },
          size: 'sm',
          variant: lens ? 'secondary' : 'default',
          children: lens ? 'Picking…' : 'Hover pick'
        }),
        jsx(Button, {
          onClick: () => void screenLens(target.name, slot),
          size: 'sm',
          variant: 'ghost',
          children: 'Screen lens'
        }),
        jsx('div', { style: { flex: 1 } }),
        jsx(Button, { onClick: () => resetEdit(target.name), size: 'sm', variant: 'ghost', children: 'Reset' })
      ] }),
      report
        ? jsx('p', { style: { margin: 0, fontSize: 10, color: 'var(--ui-text-tertiary)' }, children: `Contrast floor moved ${report.requested} → ${report.applied} so the text stays readable.` })
        : null
    ]
  })
}

/**
 * Slot switching inside the open panel re-anchors the same theme, so the panel
 * does not jump across the page when you flip between the two colors.
 */
function setSlotTarget(name, slot) {
  const open = $editing.get()
  if (open && open.name === name) $editing.set({ ...open, slot })
}

function openEditor(name, slot, rect) {
  const target = { name, slot, x: rect.left, y: rect.bottom }
  $lastTarget.set({ name, slot })
  $editing.set(target)
}

// ── lens layer ──────────────────────────────────────────────────────────────

function LensLayer() {
  const lens = useValue($lens)
  const [sample, setSample] = useState(null)

  useEffect(() => {
    if (!lens) {
      setSample(null)
      return undefined
    }
    const onMove = ev => {
      const hex = sampleUnder(ev.clientX, ev.clientY)
      setSample(hex ? { hex, x: ev.clientX, y: ev.clientY } : null)
    }
    const onClick = ev => {
      // Modal while armed: a stray click must not hit Apply or a row button.
      ev.preventDefault()
      ev.stopPropagation()
      const hex = sampleUnder(ev.clientX, ev.clientY)
      if (!hex) return
      paintSlot(lens.name, lens.slot, hex)
      $lens.set(null)
    }
    const onKey = ev => {
      if (ev.key === 'Escape') $lens.set(null)
    }
    const body = typeof document !== 'undefined' ? document.body : null
    const previousCursor = body ? body.style.cursor : ''
    if (body) body.style.cursor = 'crosshair'
    // capture: the page's own handlers must not run while the lens is armed
    window.addEventListener('mousemove', onMove, true)
    window.addEventListener('click', onClick, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousemove', onMove, true)
      window.removeEventListener('click', onClick, true)
      window.removeEventListener('keydown', onKey, true)
      if (body) body.style.cursor = previousCursor
    }
  }, [lens])

  if (!lens) return null

  const theme = THEME_BY_NAME.get(lens.name)
  const label = theme ? theme.label : lens.name
  const { w, h } = viewport()

  return jsxs('div', { children: [
    jsx('div', {
      style: { position: 'fixed', inset: 0, zIndex: 120, pointerEvents: 'none' },
      title: 'Esc cancels'
    }),
    jsx('div', {
      style: {
        position: 'fixed',
        top: 10,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 130,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        borderRadius: 8,
        border: '1px solid var(--ui-border)',
        background: 'var(--ui-bg-elevated)',
        boxShadow: '0 10px 26px rgba(0,0,0,0.28)',
        fontSize: 11,
        color: 'var(--ui-text-primary)'
      },
      children: [
        jsx('span', { style: { color: 'var(--ui-accent)' }, children: '◉ Lens' }),
        jsx('span', {
          style: { color: 'var(--ui-text-secondary)' },
          children: `${SLOT_LABEL[lens.slot]} · ${label} — hover a swatch, click to take it`
        }),
        jsx('span', { style: { color: 'var(--ui-text-tertiary)' }, children: 'Esc to cancel' })
      ]
    }),
    sample
      ? jsxs('div', {
          style: {
            position: 'fixed',
            left: Math.min(sample.x + 14, w - 96),
            top: Math.min(sample.y + 18, h - 46),
            zIndex: 131,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 7px',
            borderRadius: 6,
            border: '1px solid var(--ui-border)',
            background: 'var(--ui-bg-elevated)',
            fontSize: 10,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            color: 'var(--ui-text-primary)',
            pointerEvents: 'none'
          },
          children: [
            jsx('span', { style: { ...chipStyle(sample.hex, 14), borderRadius: 3 } }),
            jsx('span', { children: sample.hex })
          ]
        })
      : null
  ] })
}

// ── page ────────────────────────────────────────────────────────────────────

function CatalogPage() {
  const q = useValue($query)
  const { themeName } = useTheme()
  const lastApplied = useValue($lastApplied)
  const editing = useValue($editing)
  const lastTarget = useValue($lastTarget)
  useValue($revision) // rows read mutated theme objects; this is their re-render trigger

  const filtered = useMemo(() => THEMES.filter(t => matches(t, q)), [q])

  const lensTarget = lastTarget || (themeName ? { name: themeName, slot: 'background' } : null)

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 12, height: '100%', padding: 16, minHeight: 0 },
    children: [
      jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 }, children: [
        jsx('h1', { style: { fontSize: 16, fontWeight: 600, color: 'var(--ui-text-primary)', margin: 0 }, children: 'Theme Catalog' }),
        jsx('p', {
          style: { fontSize: 12, color: 'var(--ui-text-secondary)', margin: 0 },
          children: `${THEMES.length} terminal profiles from iTerm2-Color-Schemes, mapped to full desktop themes. Every row reads BG · FG first — click either one to repaint it with the system picker, hex, RGB or the lens — then the 16 ANSI slots.`
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
        lastApplied ? jsx('span', { style: { fontSize: 11, color: 'var(--ui-text-tertiary)' }, children: `last: ${lastApplied}` }) : null,
        jsx('div', { style: { flex: 1 } }),
        lensTarget
          ? jsx(Button, {
              onClick: () => $lens.set(lensTarget),
              size: 'sm',
              variant: 'ghost',
              children: `Lens → ${SLOT_LABEL[lensTarget.slot]}`
            })
          : null
      ] }),
      jsx(ScrollArea, {
        style: { flex: 1, minHeight: 0 },
        children: jsx('div', {
          style: { display: 'flex', flexDirection: 'column', gap: 5, paddingRight: 6 },
          children: filtered.map(theme =>
            jsx(CatalogRow, { theme, active: themeName === theme.name, onEdit: openEditor }, theme.name)
          )
        })
      }),
      editing ? jsx(PrimaryEditor, { target: editing, onClose: () => $editing.set(null) }) : null,
      jsx(LensLayer, {})
    ]
  })
}

// ── plugin entry ────────────────────────────────────────────────────────────

export default {
  id: 'theme-catalog',
  name: 'Theme Catalog',

  register(ctx) {
    // Saved edits are folded into the theme objects BEFORE they register, so the
    // first paint of an edited theme is already the edited one.
    const saved = ctx.storage.get(EDITS_KEY, {}) || {}
    for (const [name, patch] of Object.entries(saved)) {
      if (!THEME_BY_NAME.has(name) || !patch) continue
      $edits.set({ ...$edits.get(), [name]: patch })
      const fresh = themeFromProfile(PROFILE_BY_NAME.get(name), { bg: patch.bg, fg: patch.fg })
      const theme = THEME_BY_NAME.get(name)
      theme.colors = fresh.colors
      theme.terminal = fresh.terminal
      theme.mode = fresh.mode
    }

    let saveTimer = 0
    persistEdits = () => {
      clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        try {
          ctx.storage.set(EDITS_KEY, $edits.get())
        } catch (err) {
          host.notifyError(`Could not save your color edits: ${err?.message || err}`)
        }
      }, 250)
    }

    const disposers = new Map()
    const registerTheme = theme => {
      const id = `theme:${theme.name}`
      // Replace, never dispose: the disposer removes by id, so disposing the old
      // one after republishing would delete the new registration.
      disposers.set(id, ctx.register({ id, area: THEMES_AREA, data: theme }))
    }
    republishTheme = registerTheme

    for (const theme of THEMES) registerTheme(theme)

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
      for (const dispose of disposers.values()) dispose()
      disposers.clear()
      republishTheme = null
    })
  }
}
