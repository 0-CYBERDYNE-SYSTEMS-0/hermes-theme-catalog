// ── catalog state ───────────────────────────────────────────────────────────

const $query = atom('')
const $lastApplied = atom(null)
/** Row filter: 'all' | 'edited' | 'starred' | 'mine'. */
const $mode = atom('all')
/** Row order: 'catalog' | 'contrast'. */
const $sort = atom('catalog')
/** Starred theme names: { [name]: true }. */
const $stars = atom({})
/** Keyboard cursor index into the visible rows. */
const $cursor = atom(-1)
/** The open color editor: { name, slot, x, y } in viewport coordinates. */
const $editing = atom(null)
/** Armed lens: { name, slot } — hover a swatch, click to take that color. */
const $lens = atom(null)
const $lastTarget = atom(null)
/** Persisted primary-color overrides: { [themeName]: { bg?, fg? } }. */
const $edits = atom({})
/** Saved entries minted from an edit: [{ name, label, base, bg, fg, ansi }]. */
const $custom = atom([])
/** Per-slot undo stacks, in memory: { 'name:slot': [hex, ...] }. */
const $history = atom({})
/** Name currently being A/B compared against its original colors. */
const $compare = atom(null)
/** Skin to offer going back to after the editor switched themes. */
const $returnTo = atom(null)
/** Bumped when a theme's colors are mutated in place, so rows re-render. */
const $revision = atom(0)

const EDITS_KEY = 'primary-color-edits'
const CUSTOM_KEY = 'custom-themes'
const STARS_KEY = 'favorites'

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

// Injected once per page render. Inline styles cannot express :hover, and these
// are the affordances that tell the two editable chips apart from the 16 inert
// ones beside them.
const CHIP_CSS = `
.tc-chip{flex-shrink:0;border-radius:3px;box-shadow:inset 0 0 0 1px rgba(0,0,0,0.25)}
.tc-edit-chip{position:relative;cursor:pointer;border:none;padding:0;transition:transform .08s ease}
.tc-edit-chip:hover,.tc-edit-chip:focus-visible{transform:scale(1.22);outline:1px solid var(--ui-accent);outline-offset:1px}
.tc-edit-chip::after{content:'✎';position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:8px;line-height:1;color:#fff;mix-blend-mode:difference;opacity:0}
.tc-edit-chip:hover::after,.tc-edit-chip:focus-visible::after{opacity:.95}
.tc-row{transition:background .08s ease}
.tc-row:hover{background:var(--ui-row-active-background)}
.tc-row-cursor{outline:2px solid var(--ui-accent);outline-offset:-1px}
.tc-swatch{border:none;padding:0;cursor:pointer;border-radius:4px;transition:transform .08s ease}
.tc-swatch:hover{transform:scale(1.14)}
`

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

const stripHexes = theme => [theme.colors.background, theme.colors.foreground, ...ANSI_ORDER.map(k => theme.terminal[k])]

/** Which skin the page currently believes is applied (set during render). */
let activeTheme = null

/** Saved-entry records, kept in step with $custom so renders can read them. */
const customByName = new Map()

/**
 * Name, mode and colour search. A leading `#` searches the palette itself, so
 * "which theme has this green" is answerable; `dark` / `light` filter by mode.
 */
const matches = (theme, q) => {
  const needle = String(q || '').trim().toLowerCase()
  if (!needle) return true
  if (needle.startsWith('#')) return stripHexes(theme).some(hex => String(hex).toLowerCase().startsWith(needle))
  if (needle === 'dark' || needle === 'light') return theme.mode === needle
  if (needle === 'edited') return Boolean($edits.get()[theme.name])
  if (needle === 'mine' || needle === 'custom') return Boolean(customByName.get(theme.name))
  if (needle === 'starred' || needle === 'star') return Boolean($stars.get()[theme.name])
  return theme.label.toLowerCase().includes(needle) || theme.name.includes(needle)
}

// ── readability stats ───────────────────────────────────────────────────────

const STATS = new Map()

/**
 * Minimum contrast a theme actually ships: body text on the page, muted text on
 * the muted surface. Two dozen profiles ship a foreground their own terminal
 * cannot read, so this number is the difference between a pretty list and a
 * usable one. Memoised on the token pair that produced it.
 */
function statsFor(theme) {
  const key = `${theme.colors.background}|${theme.colors.foreground}|${theme.colors.muted}|${theme.colors.mutedForeground}`
  const hit = STATS.get(theme.name)
  if (hit && hit.key === key) return hit
  const body = contrast(theme.colors.foreground, theme.colors.background)
  const muted = contrast(theme.colors.mutedForeground, theme.colors.muted)
  const value = { key, body, muted, min: Math.min(body, muted) }
  STATS.set(theme.name, value)
  return value
}

// ── editing the two primary colors ──────────────────────────────────────────

// Set by register(): re-registering a theme's own id replaces its payload and
// bumps the registry version, which is exactly what repaints the active skin
// live (the ThemeProvider's memo depends on registryVersion).
let republishTheme = null
let dropTheme = null
let persistEdits = () => {}
let persistCustom = () => {}
let persistStars = () => {}
let revisionTimer = 0

const scheduleRevision = () => {
  clearTimeout(revisionTimer)
  revisionTimer = setTimeout(() => $revision.set($revision.get() + 1), 120)
}

const isHex = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
const normalizeHex = value => (isHex(value) ? value.toLowerCase() : null)

function rebuild(theme, profile, patch, opts) {
  const fresh = themeFromProfile(profile, patch)
  theme.colors = fresh.colors
  theme.terminal = fresh.terminal
  theme.mode = fresh.mode
  if (republishTheme) republishTheme(theme)
  if (opts?.persist !== false) persistEdits()
  scheduleRevision()
  return theme
}

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

  rebuild(theme, profile, { bg: merged.bg, fg: merged.fg }, opts)
  return true
}

/** Replace a theme's whole override (used by resets, undo and compare). */
function applyFull(name, patch, opts) {
  const theme = THEME_BY_NAME.get(name)
  const profile = PROFILE_BY_NAME.get(name)
  if (!theme || !profile) return false
  const all = { ...$edits.get() }
  if (patch && Object.keys(patch).length) all[name] = { ...patch }
  else delete all[name]
  $edits.set(all)
  rebuild(theme, profile, patch, opts)
  return true
}

const slotValue = (theme, slot) => theme.colors[slot]

const requestedValue = (name, slot, theme) =>
  $edits.get()[name]?.[SLOT_PATCH[slot]] || PROFILE_BY_NAME.get(name)?.[SLOT_PATCH[slot]] || theme.colors[slot]

/** What the user asked for vs what shipped, when the readability floor moved it. */
function editReport(name, slot) {
  const theme = THEME_BY_NAME.get(name)
  const requested = $edits.get()[name]?.[SLOT_PATCH[slot]]
  if (!theme || !requested) return null
  const applied = slotValue(theme, slot)
  return applied.toLowerCase() === requested.toLowerCase() ? null : { requested, applied }
}

function pushHistory(name, slot, hex) {
  const key = `${name}:${slot}`
  const all = { ...$history.get() }
  const stack = all[key] || []
  if (stack[0] === hex) return
  all[key] = [hex, ...stack].slice(0, 25)
  $history.set(all)
}

function paintSlot(name, slot, hex) {
  const clean = normalizeHex(hex)
  if (!clean) return false
  const theme = THEME_BY_NAME.get(name)
  if (!theme) return false
  pushHistory(name, slot, requestedValue(name, slot, theme))
  return applyEdit(name, { [SLOT_PATCH[slot]]: clean })
}

/** Put one slot back to the profile's own color, leaving the other slot alone. */
function resetSlot(name, slot) {
  const next = { ...($edits.get()[name] || {}) }
  delete next[SLOT_PATCH[slot]]
  return applyFull(name, next)
}

function undoSlot(name, slot) {
  const key = `${name}:${slot}`
  const all = { ...$history.get() }
  const stack = all[key] || []
  if (!stack.length) return false
  const [previous, ...rest] = stack
  all[key] = rest
  $history.set(all)
  const profile = PROFILE_BY_NAME.get(name)
  const next = { ...($edits.get()[name] || {}) }
  if (profile && previous === profile[SLOT_PATCH[slot]]) delete next[SLOT_PATCH[slot]]
  else next[SLOT_PATCH[slot]] = previous
  return applyFull(name, next)
}

function resetEdit(name) {
  return applyFull(name, null)
}

/** Show the profile's own colors while held; restore on release. */
function beginCompare(name) {
  const theme = THEME_BY_NAME.get(name)
  const profile = PROFILE_BY_NAME.get(name)
  if (!theme || !profile) return false
  rebuild(theme, profile, undefined, { persist: false })
  $compare.set(name)
  return true
}

function endCompare(name) {
  const theme = THEME_BY_NAME.get(name)
  const profile = PROFILE_BY_NAME.get(name)
  if (!theme || !profile) return false
  const merged = $edits.get()[name] || {}
  rebuild(theme, profile, { bg: merged.bg, fg: merged.fg }, { persist: false })
  $compare.set(null)
  return true
}

// ── saving, exporting, importing ────────────────────────────────────────────

const uniqueName = base => {
  let slug = base
  let n = 2
  while (THEME_BY_NAME.has(slug)) {
    slug = `${base}-${n}`
    n += 1
  }
  return slug
}

const uniqueLabel = base => {
  let label = base
  let n = 2
  while (THEMES.some(t => t.label === label)) {
    label = `${base} ${n}`
    n += 1
  }
  return label
}

/** The four inputs every theme is reproducible from. */
function entryFor(name) {
  const theme = THEME_BY_NAME.get(name)
  const profile = PROFILE_BY_NAME.get(name)
  if (!theme || !profile) return null
  const merged = $edits.get()[name] || {}
  return {
    base: customByName.get(name)?.base || name,
    bg: theme.colors.background,
    fg: merged.fg || profile.fg,
    ansi: profile.ansi.slice(),
    label: theme.label
  }
}

function registerEntry(entry, opts) {
  if (!entry || !isHex(entry.bg) || !isHex(entry.fg)) return null
  const ansi = Array.isArray(entry.ansi) ? entry.ansi.slice(0, 16).map(c => String(c).toLowerCase()) : []
  if (ansi.length !== 16 || !ansi.every(isHex)) return null

  const fallback = String(entry.label || 'saved').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  const slug = uniqueName(entry.name && /^catalog-[a-z0-9-]+$/.test(entry.name) ? entry.name : `catalog-${fallback || 'saved'}-custom`)
  const label = uniqueLabel(String(entry.label || 'Saved theme').slice(0, 60))
  const description = String(entry.description || `Saved from ${entry.base || 'the catalog'}`)
  const profile = { slug, label, description, bg: entry.bg.toLowerCase(), fg: entry.fg.toLowerCase(), ansi }
  const theme = themeFromProfile(profile)

  THEME_BY_NAME.set(slug, theme)
  PROFILE_BY_NAME.set(slug, profile)
  THEMES.push(theme)
  const record = { name: slug, label, base: entry.base || null, bg: profile.bg, fg: profile.fg, ansi, description }
  customByName.set(slug, record)
  $custom.set([...$custom.get(), record])
  if (republishTheme) republishTheme(theme)
  if (opts?.persist !== false) persistCustom()
  scheduleRevision()
  return theme
}

/** Mint the current (edited) look as a permanent entry of its own. */
function saveAsEntry(name, label) {
  const source = entryFor(name)
  if (!source) return null
  const theme = registerEntry({
    label: label && label.trim() ? label.trim() : `${source.label} (mine)`,
    description: `Saved from ${source.label}`,
    base: source.base,
    bg: source.bg,
    fg: source.fg,
    ansi: source.ansi
  })
  return theme ? theme.name : null
}

function deleteEntry(name) {
  if (!customByName.get(name)) return false
  customByName.delete(name)
  THEME_BY_NAME.delete(name)
  PROFILE_BY_NAME.delete(name)
  const index = THEMES.findIndex(t => t.name === name)
  if (index >= 0) THEMES.splice(index, 1)
  $custom.set($custom.get().filter(r => r.name !== name))
  const stars = { ...$stars.get() }
  delete stars[name]
  $stars.set(stars)
  persistStars()
  const edits = { ...$edits.get() }
  delete edits[name]
  $edits.set(edits)
  persistEdits()
  if (dropTheme) dropTheme(name)
  if ($editing.get() && $editing.get().name === name) $editing.set(null)
  persistCustom()
  scheduleRevision()
  return true
}

const exportPayload = names => ({
  version: 1,
  exportedAt: new Date().toISOString(),
  themes: names
    .map(entryFor)
    .filter(Boolean)
    .map(entry => ({ label: entry.label, base: entry.base, bg: entry.bg, fg: entry.fg, ansi: entry.ansi }))
})

function download(filename, text) {
  try {
    const blob = new Blob([text], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1500)
    host.notify(`Exported ${filename}`)
  } catch (err) {
    host.notifyError(`Export failed: ${err?.message || err}`)
  }
}

function exportThemes(names) {
  const payload = exportPayload(names)
  if (!payload.themes.length) return false
  const file =
    payload.themes.length === 1
      ? `${payload.themes[0].label.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-|-$/g, '')}.json`
      : 'theme-catalog-export.json'
  download(file, JSON.stringify(payload, null, 2))
  return true
}

/** Accepts { themes: [...] }, a bare entry, or an array of entries. */
function readImport(text) {
  const parsed = JSON.parse(text)
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.themes) ? parsed.themes : [parsed]
  const created = []
  for (const entry of list) {
    const theme = registerEntry({
      label: entry.label || entry.name || 'Imported theme',
      description: entry.description,
      base: entry.base || entry.name || null,
      bg: entry.bg || entry.background,
      fg: entry.fg || entry.foreground,
      ansi: entry.ansi || entry.palette
    })
    if (theme) created.push(theme.name)
  }
  if (created.length) host.notify(`Imported ${created.length} theme${created.length === 1 ? '' : 's'}`)
  else host.notifyError('Nothing importable in that file')
  return created
}

function toggleStar(name) {
  const stars = { ...$stars.get() }
  if (stars[name]) delete stars[name]
  else stars[name] = true
  $stars.set(stars)
  persistStars()
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

/**
 * The editor only pays off if you can see the result, so opening it applies the
 * theme — and remembers what you were wearing, so a glance does not cost you
 * your skin.
 */
function openEditor(name, slot, rect) {
  const theme = THEME_BY_NAME.get(name)
  $lastTarget.set({ name, slot })
  if (theme) {
    if (activeTheme && activeTheme !== name) $returnTo.set(activeTheme)
    applyTheme(theme)
  }
  $editing.set({ name, slot, x: rect.left, y: rect.bottom })
}

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
          className: 'tc-chip tc-edit-chip',
          key: cell.key,
          onClick: ev => {
            ev.stopPropagation()
            onEdit(theme.name, cell.slot, ev.currentTarget.getBoundingClientRect())
          },
          style: chipStyle(cell.hex, size + 3),
          title: cell.title,
          type: 'button'
        })
      )
      return
    }
    out.push(jsx('span', { 'data-hex': cell.hex, className: 'tc-chip', key: cell.key, style: chipStyle(cell.hex, size), title: cell.title }))
  })
  return jsx('div', { style: { display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }, children: out })
}

const ratioTone = ratio => (ratio >= 4.5 ? 'var(--ui-text-tertiary)' : ratio >= 3 ? '#c08a2e' : '#c0553e')

function CatalogRow({ theme, active, index, cursor, onEdit }) {
  const edits = useValue($edits)
  const stars = useValue($stars)
  const edited = Boolean(edits[theme.name])
  const mine = Boolean(customByName.get(theme.name))
  const starred = Boolean(stars[theme.name])
  const stats = statsFor(theme)

  return jsxs('div', {
    'data-row': String(index),
    'data-theme': theme.name,
    className: cursor ? 'tc-row tc-row-cursor' : 'tc-row',
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
      jsx('button', {
        'aria-label': starred ? 'Unstar' : 'Star',
        'data-star': theme.name,
        onClick: () => toggleStar(theme.name),
        style: {
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          padding: 0,
          fontSize: 13,
          lineHeight: 1,
          color: starred ? '#d9a521' : 'var(--ui-text-tertiary)'
        },
        title: starred ? 'Unstar' : 'Star — keeps it in the Starred filter',
        type: 'button',
        children: starred ? '★' : '☆'
      }),
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
          jsx('span', {
            style: { fontSize: 10, color: ratioTone(stats.min), fontVariantNumeric: 'tabular-nums' },
            title: `Body ${stats.body.toFixed(2)}:1 · muted ${stats.muted.toFixed(2)}:1`,
            children: `${stats.min.toFixed(2)}:1`
          }),
          edited ? jsx('span', { style: { fontSize: 10, color: 'var(--ui-accent)' }, children: '✎ edited' }) : null,
          mine ? jsx('span', { style: { fontSize: 10, color: 'var(--ui-text-tertiary)' }, children: 'mine' }) : null,
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
        jsx(Button, { onClick: () => exportThemes([theme.name]), size: 'sm', variant: 'ghost', children: 'Export' })
      ] })
    ]
  })
}

// ── the editor panel ────────────────────────────────────────────────────────

const PANEL_WIDTH = 292

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
  const compare = useValue($compare)
  const history = useValue($history)
  const returnTo = useValue($returnTo)
  const panel = useRef(null)

  const current = theme ? slotValue(theme, slot) : '#000000'
  const [draft, setDraft] = useState(current)
  const [saveName, setSaveName] = useState('')

  // Follow the applied value: a lens pick, a preset, a contrast adjustment or an
  // undo all land here. Partial typing never applies, so this does not fight input.
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
  const requestedFg = requestedValue(target.name, 'foreground', theme)
  const requestedBg = requestedValue(target.name, 'background', theme)
  const liveRatio = contrast(requestedFg, requestedBg)
  const modeWillBe = luminance(requestedBg) < 0.5 ? 'dark' : 'light'
  const rgb = hexToRgb(normalizeHex(draft) || current) || [0, 0, 0]
  const stack = history[`${target.name}:${slot}`] || []
  const meta = customByName.get(target.name)

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
  const top = Math.max(12, Math.min(target.y + 10, h - 560))

  const rgbCommit = (channel, value) => {
    const next = [...rgb]
    next[['R', 'G', 'B'].indexOf(channel)] = value
    commit(rgbToHex(next[0], next[1], next[2]))
  }

  return jsxs('div', {
    ref: panel,
    'aria-label': 'Edit theme colours',
    'data-lens-panel': 'true',
    role: 'dialog',
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
      jsx('div', { style: { display: 'flex', gap: 4 }, children: ['background', 'foreground'].map(key =>
        jsx(Button, {
          key,
          onClick: () => setSlotTarget(target.name, key),
          size: 'sm',
          variant: key === slot ? 'secondary' : 'ghost',
          children: SLOT_LABEL[key]
        })
      ) }),
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
      jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: 'var(--ui-text-tertiary)' }, children: [
        jsx('span', {
          style: { color: ratioTone(liveRatio), fontVariantNumeric: 'tabular-nums' },
          title: 'Contrast of the picked pair, before the readability floor',
          children: `${liveRatio.toFixed(2)}:1${liveRatio < 4.5 ? ' — low' : liveRatio < 7 ? ' — ok' : ' — strong'}`
        }),
        jsx('span', { children: `· ${modeWillBe} mode` }),
        report ? jsx('span', { children: '· floor applied' }) : null
      ] }),
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
            className: 'tc-swatch',
            key: hex,
            onClick: () => commit(hex),
            title: hex,
            type: 'button',
            style: { ...chipStyle(hex, 18), borderRadius: 4 }
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
        jsx(Button, { onClick: () => void screenLens(target.name, slot), size: 'sm', variant: 'ghost', children: 'Screen lens' }),
        jsx('div', { style: { flex: 1 } }),
        jsx(Button, {
          onClick: () => undoSlot(target.name, slot),
          size: 'sm',
          variant: 'ghost',
          children: stack.length ? `Undo ${stack.length}` : 'Undo'
        }),
        jsx(Button, { onClick: () => resetSlot(target.name, slot), size: 'sm', variant: 'ghost', children: 'Reset slot' })
      ] }),
      jsxs('div', { style: { display: 'flex', gap: 4, alignItems: 'center' }, children: [
        jsx(Button, {
          onMouseDown: () => beginCompare(target.name),
          onMouseLeave: () => compare === target.name && endCompare(target.name),
          onMouseUp: () => compare === target.name && endCompare(target.name),
          size: 'sm',
          variant: compare === target.name ? 'secondary' : 'ghost',
          children: compare === target.name ? 'Original' : 'Hold: original'
        }),
        jsx(Button, { onClick: () => exportThemes([target.name]), size: 'sm', variant: 'ghost', children: 'Export' }),
        jsx(Button, { onClick: () => resetEdit(target.name), size: 'sm', variant: 'ghost', children: 'Reset both' }),
        jsx('div', { style: { flex: 1 } }),
        returnTo
          ? jsx(Button, {
              onClick: () => {
                const back = THEME_BY_NAME.get(returnTo)
                if (back) applyTheme(back)
              },
              size: 'sm',
              variant: 'ghost',
              children: '← back'
            })
          : null
      ] }),
      jsxs('div', { style: { display: 'flex', gap: 4, alignItems: 'center' }, children: [
        jsx(Input, {
          'aria-label': 'New theme name',
          onChange: ev => setSaveName(ev.target.value),
          placeholder: `${theme.label} (mine)`,
          style: { flex: 1, fontSize: 11 },
          value: saveName
        }),
        jsx(Button, {
          onClick: () => {
            const created = saveAsEntry(target.name, saveName || `${theme.label} (mine)`)
            if (created) {
              host.notify(`Saved as ${THEME_BY_NAME.get(created).label}`)
              setSaveName('')
              $editing.set({ ...target, name: created })
            }
          },
          size: 'sm',
          children: 'Save as'
        })
      ] }),
      report
        ? jsx('p', { style: { margin: 0, fontSize: 10, color: 'var(--ui-text-tertiary)' }, children: `Contrast floor moved ${report.requested} → ${report.applied} so the text stays readable.` })
        : null,
      meta
        ? jsxs('div', { style: { display: 'flex', gap: 4, alignItems: 'center' }, children: [
            jsx('span', { style: { flex: 1, fontSize: 10, color: 'var(--ui-text-tertiary)' }, children: `saved from ${meta.base || 'the catalog'}` }),
            jsx(Button, { onClick: () => deleteEntry(target.name), size: 'sm', variant: 'ghost', children: 'Delete' })
          ] })
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
    jsx('div', { style: { position: 'fixed', inset: 0, zIndex: 120, pointerEvents: 'none' } }),
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
        color: 'var(--ui-text-primary)',
        pointerEvents: 'none'
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

// ── toolbar ─────────────────────────────────────────────────────────────────

const MODES = [
  { key: 'all', label: 'All' },
  { key: 'edited', label: 'Edited' },
  { key: 'starred', label: '★' },
  { key: 'mine', label: 'Mine' }
]

function ModeChip({ active, children, onClick, title }) {
  return jsx('button', {
    onClick,
    style: {
      border: '1px solid var(--ui-border)',
      background: active ? 'var(--ui-accent)' : 'transparent',
      color: active ? 'var(--ui-accent-foreground, #fff)' : 'var(--ui-text-secondary)',
      borderRadius: 999,
      padding: '2px 9px',
      fontSize: 11,
      cursor: 'pointer'
    },
    title,
    type: 'button',
    children
  })
}

// ── page ────────────────────────────────────────────────────────────────────

function CatalogPage() {
  const q = useValue($query)
  const { themeName } = useTheme()
  const lastApplied = useValue($lastApplied)
  const editing = useValue($editing)
  const mode = useValue($mode)
  const sort = useValue($sort)
  const cursor = useValue($cursor)
  const lastTarget = useValue($lastTarget)
  const custom = useValue($custom)
  const edits = useValue($edits)
  const stars = useValue($stars)
  const revision = useValue($revision) // rows read mutated theme objects; this is their re-render trigger

  activeTheme = themeName || null

  const filterRef = useRef(null)
  const fileRef = useRef(null)

  const editedCount = Object.keys(edits).length
  const starredCount = Object.keys(stars).length

  const visible = useMemo(() => {
    const base = THEMES.filter(theme => {
      if (mode === 'edited' && !edits[theme.name]) return false
      if (mode === 'starred' && !stars[theme.name]) return false
      if (mode === 'mine' && !customByName.get(theme.name)) return false
      return matches(theme, q)
    })
    if (sort === 'contrast') return base.slice().sort((a, b) => statsFor(b).min - statsFor(a).min)
    // The skin you are wearing is the one row you always care about.
    if (!q && themeName) {
      const index = base.findIndex(t => t.name === themeName)
      if (index > 0) base.unshift(...base.splice(index, 1))
    }
    return base
  }, [q, mode, sort, edits, stars, custom, themeName, lastApplied, revision])

  // Keyboard: `/` filter, ↑↓ (or j/k) move, ↵ apply, e edit, s star, Esc clear.
  useEffect(() => {
    const onKey = ev => {
      const el = ev.target
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if (ev.key === '/' && !typing) {
        ev.preventDefault()
        if (filterRef.current && filterRef.current.focus) filterRef.current.focus()
        else if (typeof document !== 'undefined') {
          const node = document.querySelector('input[placeholder^="Filter"]')
          if (node && node.focus) node.focus()
        }
        return
      }
      if (typing) return
      const index = Math.max(0, Math.min(visible.length - 1, cursor))
      const row = visible[index]
      if (ev.key === 'ArrowDown' || ev.key === 'j') {
        ev.preventDefault()
        $cursor.set(Math.min(visible.length - 1, cursor + 1))
        return
      }
      if (ev.key === 'ArrowUp' || ev.key === 'k') {
        ev.preventDefault()
        $cursor.set(Math.max(0, cursor - 1))
        return
      }
      if (ev.key === 'Enter' && row && !$editing.get()) {
        ev.preventDefault()
        applyTheme(row)
        return
      }
      if (ev.key === 'e' && row) {
        ev.preventDefault()
        const node = typeof document !== 'undefined' ? document.querySelector('[data-row="' + index + '"]') : null
        const rect = node ? node.getBoundingClientRect() : { left: 80, top: 120, bottom: 140 }
        openEditor(row.name, 'background', rect)
        return
      }
      if (ev.key === 's' && row) {
        ev.preventDefault()
        toggleStar(row.name)
        return
      }
      if (ev.key === 'Escape') {
        $query.set('')
        $cursor.set(-1)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [visible, cursor])

  useEffect(() => {
    if (cursor < 0 || typeof document === 'undefined') return
    const node = document.querySelector('[data-row="' + cursor + '"]')
    if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const lensTarget = lastTarget || (themeName ? { name: themeName, slot: 'background' } : null)

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 12, height: '100%', padding: 16, minHeight: 0 },
    children: [
      jsx('style', { children: CHIP_CSS }),
      jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 }, children: [
        jsx('h1', { style: { fontSize: 16, fontWeight: 600, color: 'var(--ui-text-primary)', margin: 0 }, children: 'Theme Catalog' }),
        jsx('p', {
          style: { fontSize: 12, color: 'var(--ui-text-secondary)', margin: 0 },
          children: `${THEMES.length} themes. The first two chips are the background and body text — click either to repaint it. ${editedCount} edited · ${custom.length} saved · ${starredCount} starred.  / filter · ↑↓ move · ↵ apply · e edit · s star`
        })
      ] }),
      jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }, children: [
        jsx('div', { style: { flex: '1 1 220px', maxWidth: 340 }, children: jsx(Input, {
          ref: filterRef,
          value: q,
          placeholder: 'Filter — name, dark, #2e3440…',
          onChange: ev => {
            $query.set(ev.target.value)
            $cursor.set(-1)
          },
          style: { width: '100%' }
        }) }),
        ...MODES.map(m =>
          jsx(ModeChip, {
            active: mode === m.key,
            key: m.key,
            onClick: () => {
              $mode.set(m.key)
              $cursor.set(-1)
            },
            title: m.key === 'starred' ? 'Starred only' : m.key === 'mine' ? 'Saved by you' : undefined,
            children: m.key === 'edited' ? `Edited ${editedCount}` : m.key === 'starred' ? `★ ${starredCount}` : m.key === 'mine' ? `Mine ${custom.length}` : m.label
          })
        ),
        jsx(ModeChip, {
          active: sort === 'contrast',
          onClick: () => $sort.set(sort === 'contrast' ? 'catalog' : 'contrast'),
          title: 'Sort by guaranteed readability',
          children: sort === 'contrast' ? 'Sort: contrast' : 'Sort: catalog'
        }),
        jsx('span', { style: { fontSize: 11, color: 'var(--ui-text-tertiary)' }, children: `${visible.length} shown` }),
        jsx('div', { style: { flex: 1 } }),
        jsx('input', {
          accept: '.json,application/json',
          'aria-label': 'Import themes',
          onChange: ev => {
            const file = ev.target.files && ev.target.files[0]
            if (!file) return
            const reader = new FileReader()
            reader.onload = () => {
              try {
                readImport(String(reader.result || ''))
              } catch (err) {
                host.notifyError(`Import failed: ${err?.message || err}`)
              }
            }
            reader.readAsText(file)
            ev.target.value = ''
          },
          ref: fileRef,
          style: { display: 'none' },
          type: 'file'
        }),
        jsx(Button, { onClick: () => fileRef.current?.click?.(), size: 'sm', variant: 'ghost', children: 'Import' }),
        jsx(Button, { onClick: () => exportThemes(visible.map(t => t.name)), size: 'sm', variant: 'ghost', children: 'Export list' }),
        lensTarget
          ? jsx(Button, { onClick: () => $lens.set(lensTarget), size: 'sm', variant: 'ghost', children: `Lens → ${SLOT_LABEL[lensTarget.slot]}` })
          : null,
        lastApplied ? jsx('span', { style: { fontSize: 11, color: 'var(--ui-text-tertiary)' }, children: `last: ${lastApplied}` }) : null
      ] }),
      jsx(ScrollArea, {
        style: { flex: 1, minHeight: 0 },
        children: jsx('div', {
          style: { display: 'flex', flexDirection: 'column', gap: 5, paddingRight: 6 },
          children: visible.length
            ? visible.map((theme, index) =>
                jsx(
                  CatalogRow,
                  { theme, active: themeName === theme.name, index, cursor: index === cursor, onEdit: openEditor },
                  theme.name
                )
              )
            : jsx('p', { style: { fontSize: 12, color: 'var(--ui-text-tertiary)', padding: 12 }, children: 'Nothing matches that filter.' })
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

  // Read-only-ish handles for tools/registration-test.mjs. The app never reads
  // this key; it keeps the pure paths (import, export, undo, compare, search)
  // testable in Node instead of only through the DOM.
  __test: {
    themes: () => THEMES,
    theme: name => THEME_BY_NAME.get(name),
    edits: () => $edits.get(),
    custom: () => $custom.get(),
    stars: () => $stars.get(),
    applyEdit,
    paintSlot,
    undoSlot,
    resetSlot,
    beginCompare,
    endCompare,
    saveAsEntry,
    deleteEntry,
    readImport,
    exportPayload,
    exportThemes,
    screenLens,
    matches,
    statsFor,
    toggleStar,
    entries: () => Object.fromEntries(customByName)
  },

  register(ctx) {
    const savedEdits = ctx.storage.get(EDITS_KEY, {}) || {}
    const savedCustom = ctx.storage.get(CUSTOM_KEY, []) || []
    const savedStars = ctx.storage.get(STARS_KEY, {}) || {}
    $stars.set(savedStars && typeof savedStars === 'object' ? savedStars : {})

    let saveTimer = 0
    persistEdits = () => {
      clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        try {
          ctx.storage.set(EDITS_KEY, $edits.get())
        } catch (err) {
          host.notifyError(`Could not save your color edits: ${err?.message || err}`)
        }
      }, 200)
    }

    let starTimer = 0
    persistStars = () => {
      clearTimeout(starTimer)
      starTimer = setTimeout(() => {
        try {
          ctx.storage.set(STARS_KEY, $stars.get())
        } catch (err) {
          host.notifyError(`Could not save your stars: ${err?.message || err}`)
        }
      }, 200)
    }

    persistCustom = () => {
      try {
        ctx.storage.set(CUSTOM_KEY, $custom.get())
      } catch (err) {
        host.notifyError(`Could not save your theme: ${err?.message || err}`)
      }
    }

    const disposers = new Map()
    const registerTheme = theme => {
      const id = `theme:${theme.name}`
      // Replace, never dispose: the disposer removes by id, so disposing the old
      // one after republishing would delete the new registration.
      disposers.set(id, ctx.register({ id, area: THEMES_AREA, data: theme }))
    }
    republishTheme = registerTheme
    dropTheme = name => {
      const id = `theme:${name}`
      const dispose = disposers.get(id)
      if (dispose) dispose()
      disposers.delete(id)
    }

    // Saved entries first, then edits on top, so the first paint matches storage.
    for (const record of Array.isArray(savedCustom) ? savedCustom : []) {
      if (!record || !/^catalog-[a-z0-9-]+$/.test(String(record.name || '')) || THEME_BY_NAME.has(record.name)) continue
      const ansi = Array.isArray(record.ansi) ? record.ansi.map(c => String(c).toLowerCase()) : []
      if (!isHex(record.bg) || !isHex(record.fg) || ansi.length !== 16 || !ansi.every(isHex)) continue
      const profile = {
        slug: record.name,
        label: record.label || record.name,
        description: record.description || `Saved from ${record.base || 'the catalog'}`,
        bg: String(record.bg).toLowerCase(),
        fg: String(record.fg).toLowerCase(),
        ansi
      }
      const theme = themeFromProfile(profile)
      THEME_BY_NAME.set(profile.slug, theme)
      PROFILE_BY_NAME.set(profile.slug, profile)
      THEMES.push(theme)
      const saved = { name: profile.slug, label: profile.label, base: record.base || null, bg: profile.bg, fg: profile.fg, ansi, description: profile.description }
      customByName.set(profile.slug, saved)
      $custom.set([...$custom.get(), saved])
    }

    for (const [name, patch] of Object.entries(savedEdits)) {
      if (!THEME_BY_NAME.has(name) || !patch) continue
      $edits.set({ ...$edits.get(), [name]: patch })
      const theme = THEME_BY_NAME.get(name)
      const fresh = themeFromProfile(PROFILE_BY_NAME.get(name), { bg: patch.bg, fg: patch.fg })
      theme.colors = fresh.colors
      theme.terminal = fresh.terminal
      theme.mode = fresh.mode
    }

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
        label: `Theme Catalog: browse ${THEMES.length} terminal themes`,
        keywords: ['theme', 'skin', 'color', 'palette', 'catalog', 'iterm'],
        run: () => host.navigate('/theme-catalog')
      }
    })

    ctx.onDispose(() => {
      for (const dispose of disposers.values()) dispose()
      disposers.clear()
      republishTheme = null
      dropTheme = null
    })
  }
}
