#!/usr/bin/env node
/**
 * Load the generated plugin under stubbed SDK/react modules and exercise its
 * register() entry point. This is the check that catches what a color-math
 * test cannot: module-init errors, a wrong import surface, malformed
 * registration payloads, or a disposer that never runs.
 *
 * Usage: node tools/registration-test.mjs
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { contrast, themeFromProfile } from '../src/theme-map.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sandbox = join(root, 'build/stub-run')

const sdk = `
export const Button = 'Button'
export const Input = 'Input'
export const ScrollArea = 'ScrollArea'
export const SegmentedControl = 'SegmentedControl'
export const PALETTE_AREA = 'palette'
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar-nav'
export const THEMES_AREA = 'themes'
export const cn = (...a) => a.filter(Boolean).join(' ')
export const haptic = () => {}
export const icons = {}
export const atom = initial => {
  let value = initial
  return { get: () => value, set: v => { value = v }, subscribe: () => () => {} }
}
export const useValue = a => a.get()
export const useTheme = () => ({ themeName: null, theme: { colors: {} } })
export const requestTheme = () => true
export const host = { notify: () => {}, notifyError: () => {}, navigate: () => {}, onEvent: () => () => {} }
`
const react = `
export const useMemo = (fn) => fn()
export const useState = (v) => [typeof v === 'function' ? v() : v, () => {}]
export const useEffect = () => {}
export const useRef = (v) => ({ current: v })
export const useCallback = (fn) => fn
export const createElement = (type, props, ...children) => ({ type, props, children })
`
const jsxRuntime = `
export const jsx = (type, props) => ({ type, props })
export const jsxs = (type, props) => ({ type, props })
export const Fragment = 'Fragment'
`

const write = (path, body) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}

rmSync(sandbox, { recursive: true, force: true })
write(join(sandbox, 'node_modules/@hermes/plugin-sdk/package.json'), JSON.stringify({ name: '@hermes/plugin-sdk', type: 'module', main: 'index.mjs' }))
write(join(sandbox, 'node_modules/@hermes/plugin-sdk/index.mjs'), sdk)
write(join(sandbox, 'node_modules/react/package.json'), JSON.stringify({ name: 'react', type: 'module', main: 'index.mjs' }))
write(join(sandbox, 'node_modules/react/index.mjs'), react)
write(join(sandbox, 'node_modules/react/jsx-runtime.mjs'), jsxRuntime)
write(join(sandbox, 'node_modules/react/package.json'), JSON.stringify({ name: 'react', type: 'module', main: 'index.mjs', exports: { '.': './index.mjs', './jsx-runtime': './jsx-runtime.mjs' } }))

copyFileSync(join(root, 'desktop/plugin.js'), join(sandbox, 'plugin.mjs'))

const problems = []
const mod = await import(pathToFileURL(join(sandbox, 'plugin.mjs')).href)
const plugin = mod.default

if (plugin?.id !== 'theme-catalog') problems.push(`plugin id is ${plugin?.id}`)
if (typeof plugin?.register !== 'function') problems.push('no register(ctx)')

const registrations = []
const storageWrites = []
let disposed = 0
const makeCtx = (initial = {}) => {
  const ctx = {
    register: spec => {
      registrations.push(spec)
      return () => { disposed += 1 }
    },
    onDispose: fn => { ctx._onDispose = fn },
    storage: {
      get: (k, d) => (k in initial ? initial[k] : d),
      set: (k, v) => { storageWrites.push({ key: k, value: v }) }
    }
  }
  return ctx
}
const ctx = makeCtx()

plugin.register(ctx)
/** Registration count after the first load pass, so the report can separate that
 *  from the re-registrations the edit/boot-restore paths perform. */
const firstPass = registrations.length

const themes = registrations.filter(r => r.area === 'themes')
const routes = registrations.filter(r => r.area === 'routes')
const nav = registrations.filter(r => r.area === 'sidebar-nav')
const palette = registrations.filter(r => r.area === 'palette')

if (themes.length !== 606) problems.push(`registered ${themes.length} themes, expected 606`)
if (routes.length !== 1) problems.push(`registered ${routes.length} routes, expected 1`)
if (nav.length !== 1) problems.push(`registered ${nav.length} nav rows, expected 1`)
if (palette.length !== 1) problems.push(`registered ${palette.length} palette commands, expected 1`)

const ids = new Set()
for (const t of themes) {
  const d = t.data
  if (!d?.name || !d?.label) problems.push(`theme missing name/label: ${t.id}`)
  // Reproduce the app's root ⌘K palette keyword construction and assert every
  // element is a string: it passes theme.name and theme.description straight
  // into a keywords array, and cmdk calls .trim() on each element.
  const paletteKeywords = ['theme', 'appearance', 'color', 'skin', d?.name, d?.description]
  if (paletteKeywords.some(k => typeof k !== 'string' || !k.trim())) {
    problems.push(`${d?.name}: palette keywords would crash the ⌘K list (${paletteKeywords.map(k => typeof k).join(',')})`)
  }
  if (ids.has(d.name)) problems.push(`duplicate registration ${d.name}`)
  ids.add(d.name)
  if (t.id !== `theme:${d.name}`) problems.push(`id/name mismatch ${t.id} vs ${d.name}`)
  const tokenCount = Object.keys(d.colors || {}).length
  if (tokenCount !== 26) problems.push(`${d.name}: ${tokenCount} tokens, expected 26`)
  if (Object.keys(d.terminal || {}).length !== 19) problems.push(`${d.name}: terminal keys ${Object.keys(d.terminal || {}).length}, expected 19`)
}
// Shipped artifact vs source: re-derive every theme from the committed fixtures
// and compare with what desktop/plugin.js actually registers. A stale build (or
// a hand-edited bundle) fails here instead of shipping.
{
  const fixtures = JSON.parse(readFileSync(join(root, 'fixtures/profiles.json'), 'utf8'))
  let mismatches = 0
  for (const profile of fixtures) {
    const derived = themeFromProfile(profile)
    const shipped = plugin.__test?.theme(profile.slug)
    if (!shipped) {
      mismatches += 1
      continue
    }
    for (const key of Object.keys(derived.colors)) if (shipped.colors[key] !== derived.colors[key]) mismatches += 1
    for (const key of Object.keys(derived.terminal)) if (shipped.terminal[key] !== derived.terminal[key]) mismatches += 1
  }
  if (mismatches) problems.push(`plugin.js drifted from src/theme-map.mjs + fixtures/profiles.json (${mismatches} mismatches)`)
}

if (!routes[0]?.render) problems.push('route has no render function')
if (nav[0]?.data?.path !== '/theme-catalog') problems.push(`nav path ${nav[0]?.data?.path}`)

ctx._onDispose?.()
if (disposed !== themes.length) problems.push(`dispose ran ${disposed} times for ${themes.length} theme registrations`)

// Render the page once under the stubs: this executes the component body, the
// filter, the row cap and the swatch mapping, so a typo or a bad prop shape
// fails here instead of in the user's sidebar.
let page = null
let renderMs = 0
try {
  const t0 = performance.now()
  const element = routes[0].render()
  // render() returns <CatalogPage/>, so invoke the component itself to run its body.
  page = typeof element?.type === 'function' ? element.type(element.props) : element
  renderMs = performance.now() - t0
} catch (err) {
  problems.push(`page render threw: ${err?.message || err}`)
}
if (page && !page.props?.children) problems.push('page rendered no children')

// Walk the rendered tree and check the strip contract on every row: chip 1 is
// the page background, chip 2 is the body text, then a divider, then 16 ANSI.
const strips = []
let nodesBuilt = 0
const walk = (node, depth = 0) => {
  if (!node || typeof node !== 'object' || depth > 12) return
  if (Array.isArray(node)) {
    node.forEach(child => walk(child, depth))
    return
  }
  // Sub-components are elements whose type is still a function under the stub
  // renderer: invoke them so their subtree (the strip) actually exists.
  if (typeof node.type === 'function') {
    walk(node.type({ ...node.props }), depth + 1)
    return
  }
  nodesBuilt++
  const kids = node.props?.children
  if (Array.isArray(kids) && kids.length === 19 && kids[0]?.props?.title) strips.push(kids)
  walk(kids, depth + 1)
}
walk(page)

if (strips.length === 0) problems.push('no swatch strips found in the rendered page')
else if (strips.length !== 606) problems.push(`rendered ${strips.length} rows with no filter, expected all 606`)
for (const [index, kids] of strips.entries()) {
  const titles = kids.map(k => (k?.props?.title ? String(k.props.title) : 'divider'))
  if (!/^background /i.test(titles[0])) problems.push(`strip ${index}: first chip is ${titles[0]}`)
  if (!/^body text /i.test(titles[1])) problems.push(`strip ${index}: second chip is ${titles[1]}`)
  if (kids[0]?.type !== 'button' || kids[1]?.type !== 'button') problems.push(`strip ${index}: BG/FG chips are not editable buttons`)
  if (!kids[0]?.props?.['data-hex'] || !kids[1]?.props?.['data-hex']) problems.push(`strip ${index}: primary chips have no data-hex for the lens`)
  if (titles[2] !== 'divider') problems.push(`strip ${index}: missing divider after BG/FG`)
  const ansi = titles.slice(3)
  if (ansi.length !== 16) problems.push(`strip ${index}: ${ansi.length} ANSI chips`)
  if (!titles.every(t => /^#?[a-z]|[0-9a-f]{6}/.test(t))) problems.push(`strip ${index}: unlabeled chip`)
}

// No truncation anywhere: an unfiltered page must not tell the user to narrow
// its filter, and must not hide rows behind a cap.
const texts = []
const collectText = node => {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach(collectText)
    return
  }
  if (typeof node.type === 'function') {
    collectText(node.type({ ...node.props }))
    return
  }
  if (typeof node.props?.children === 'string') texts.push(node.props.children)
  collectText(node.props?.children)
}
collectText(page)
for (const text of texts) {
  if (/narrow the filter|\d+ more/i.test(text)) problems.push(`truncation notice still rendered: "${text}"`)
}

// ── primary-color editing, end to end ───────────────────────────────────────
// Click the BG chip the way a user does, render the panel, drive the same
// onChange the hex field calls, and assert what actually reached the registry.
const rerender = () => {
  const element = routes[0].render()
  return typeof element?.type === 'function' ? element.type(element.props) : element
}

const findAll = (node, pred, out = [], depth = 0) => {
  if (!node || typeof node !== 'object' || depth > 16) return out
  if (Array.isArray(node)) {
    node.forEach(child => findAll(child, pred, out, depth))
    return out
  }
  if (typeof node.type === 'function') {
    findAll(node.type({ ...node.props }), pred, out, depth + 1)
    return out
  }
  if (pred(node)) out.push(node)
  findAll(node.props?.children, pred, out, depth + 1)
  return out
}

const isStrip = n => Array.isArray(n.props?.children) && n.props.children.length === 19 && n.props.children[0]?.props?.title
/** findAll matches the strip's container node; the chips are its children. */
const stripKids = tree => findAll(tree, isStrip).map(n => n.props.children)
const isPanel = n => n.props?.['data-lens-panel'] === 'true'

// The dispose check above ran the plugin's disposers, which nulls its republish
// hook (correctly). Re-register so the edit path has a live registry to publish
// into, exactly as it does in the running app.
plugin.register(makeCtx())

const target0 = themes[0].data
const originalBg = target0.colors.background
const originalFg = target0.terminal.foreground

const clickChip = chip =>
  chip.props.onClick({
    currentTarget: { getBoundingClientRect: () => ({ left: 60, top: 120, bottom: 134 }) },
    preventDefault: () => {},
    stopPropagation: () => {}
  })

let tree = rerender()
clickChip(stripKids(tree)[0][0])
tree = rerender()
const panels = findAll(tree, isPanel)
if (panels.length !== 1) problems.push(`editor panel rendered ${panels.length} times, expected 1`)
const panel = panels[0] || { props: { children: [] } }
if (!findAll(panel, n => n.props?.type === 'color').length) problems.push('editor has no system color input')
if (!findAll(panel, n => n.props?.['aria-label'] === 'Hex').length) problems.push('editor has no hex input')
if (!findAll(panel, n => ['R', 'G', 'B'].includes(n.props?.['aria-label'])).length) problems.push('editor has no RGB fields')
if (!findAll(panel, n => n.props?.['data-hex']).length) problems.push('editor has no preset swatches for the lens')

const countBefore = registrations.length
findAll(panel, n => n.props?.['aria-label'] === 'Hex')[0].props.onChange({ target: { value: '#101014' } })
const republished = registrations.slice(countBefore).filter(r => r.id === `theme:${target0.name}`)
if (republished.length !== 1) problems.push(`editing republished ${republished.length} registrations for ${target0.name}, expected 1`)
else {
  if (republished[0].data.colors.background !== '#101014') problems.push(`edit did not land: background ${republished[0].data.colors.background}`)
  if (republished[0].data !== target0) problems.push('edit replaced the theme object instead of mutating the registered one')
}

tree = rerender()
if (stripKids(tree)[0]?.[0]?.props?.['data-hex'] !== '#101014') problems.push('row chip did not follow the edit')

// Foreground: the UI token has a readability floor, the terminal keeps what you picked.
clickChip(stripKids(tree)[0][1])
tree = rerender()
const bodyTab = findAll(findAll(tree, isPanel)[0], n => n.type === 'Button' && n.props?.children === 'Body text')[0]
if (!bodyTab) problems.push('editor has no body-text tab')
else bodyTab.props.onClick()
tree = rerender()
findAll(findAll(tree, isPanel)[0], n => n.props?.['aria-label'] === 'Hex')[0].props.onChange({ target: { value: '#123456' } })
if (target0.terminal.foreground !== '#123456') problems.push(`terminal foreground is ${target0.terminal.foreground}, expected the picked #123456`)
if (contrast(target0.colors.foreground, target0.colors.background) < 4.5) problems.push('edited body text breaks the 4.5:1 floor')

await new Promise(resolve => setTimeout(resolve, 400))
const persisted = storageWrites.filter(w => w.key === 'primary-color-edits').pop()
if (!persisted) problems.push('color edits were never persisted to ctx.storage')
else if (!persisted.value?.[target0.name]?.bg || !persisted.value?.[target0.name]?.fg) {
  problems.push(`persisted record incomplete: ${JSON.stringify(persisted.value[target0.name])}`)
}

// Reset puts the profile's own colors back.
tree = rerender()
const resetButton = findAll(findAll(tree, isPanel)[0], n => n.type === 'Button' && n.props?.children === 'Reset both')[0]
if (!resetButton) problems.push('editor has no reset button')
else resetButton.props.onClick()
if (target0.colors.background !== originalBg) problems.push(`reset left background at ${target0.colors.background}`)
if (target0.terminal.foreground !== originalFg) problems.push(`reset left foreground at ${target0.terminal.foreground}`)

// Boot restore: a saved edit must be folded in before the theme registers.
const bootCtx = makeCtx({ 'primary-color-edits': { [target0.name]: { bg: '#101014', fg: '#123456' } } })
plugin.register(bootCtx)
if (target0.colors.background !== '#101014') problems.push(`boot restore did not apply the saved background (${target0.colors.background})`)
if (target0.terminal.foreground !== '#123456') problems.push('boot restore did not apply the saved foreground')
const bootTheme = bootCtx._onDispose && registrations.slice(-3).find(r => r.id === `theme:${target0.name}`)
if (bootTheme && bootTheme.data.colors.background !== '#101014') problems.push('boot restore registered unedited colors')

// ── entry authoring, import/export, undo, compare, stars ────────────────────
// Driven through the plugin's own test surface, so these are the shipping code
// paths, not a reimplementation of them.
const T = plugin.__test
if (!T) problems.push('plugin exposes no __test surface')
else {
  const before = T.themes().length
  const created = T.saveAsEntry(target0.name, 'Gruvbox Test')
  if (!created) problems.push('saveAsEntry returned nothing')
  else {
    if (!/^catalog-[a-z0-9-]+-custom$/.test(created)) problems.push(`saved entry name is ${created}`)
    if (T.themes().length !== before + 1) problems.push(`save-as added ${T.themes().length - before} themes, expected 1`)
    const saved = T.theme(created)
    if (!saved) problems.push('saved entry is not registered in the lookup')
    else {
      if (saved.colors.background !== target0.colors.background) problems.push('saved entry did not capture the edited background')
      if (saved.label !== 'Gruvbox Test') problems.push(`saved entry label is ${saved.label}`)
    }
    if (!registrations.some(r => r.id === `theme:${created}`)) problems.push('saved entry was never registered')
    const customWrite = storageWrites.filter(w => w.key === 'custom-themes').pop()
    if (!customWrite || !customWrite.value.some(r => r.name === created)) problems.push('saved entry was not persisted')
  }

  // Import: a payload with 16 ANSI slots becomes a registered theme.
  const ansi = ['#000000', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf',
    '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec']
  const imported = T.readImport(JSON.stringify({ version: 1, themes: [{ label: 'Imported Test', bg: '#202020', fg: '#e0e0e0', ansi }] }))
  if (imported.length !== 1) problems.push(`import created ${imported.length} themes, expected 1`)
  else {
    const t = T.theme(imported[0])
    if (!t) problems.push('imported theme missing from the lookup')
    else if (t.terminal.red !== '#cc0000') problems.push('imported palette did not survive')
  }
  if (T.readImport(JSON.stringify({ themes: [{ label: 'bad', bg: 'nope', fg: '#ffffff', ansi }] })).length !== 0) {
    problems.push('import accepted an invalid background')
  }

  // Export payload shape.
  const payload = T.exportPayload([target0.name])
  if (payload.themes.length !== 1) problems.push('exportPayload dropped the theme')
  else {
    const entry = payload.themes[0]
    if (!/^#[0-9a-f]{6}$/.test(entry.bg) || !/^#[0-9a-f]{6}$/.test(entry.fg)) problems.push('export payload has no usable pair')
    if (!Array.isArray(entry.ansi) || entry.ansi.length !== 16) problems.push('export payload has no 16-colour palette')
  }

  // Undo walks back one step per slot; compare swaps in the original pair.
  T.paintSlot(target0.name, 'background', '#111111')
  T.paintSlot(target0.name, 'background', '#222222')
  T.undoSlot(target0.name, 'background')
  if (target0.colors.background !== '#111111') problems.push(`undo left background at ${target0.colors.background}`)
  T.paintSlot(target0.name, 'background', '#333333')
  T.beginCompare(target0.name)
  if (target0.colors.background !== originalBg) problems.push('compare did not show the original colours')
  T.endCompare(target0.name)
  if (target0.colors.background !== '#333333') problems.push('compare did not restore the edit')

  // Reset one slot leaves the other alone.
  T.paintSlot(target0.name, 'foreground', '#abcdef')
  T.resetSlot(target0.name, 'background')
  if (target0.colors.background !== originalBg) problems.push('resetSlot kept the background edit')
  if (target0.terminal.foreground !== '#abcdef') problems.push('resetSlot also cleared the foreground edit')

  // Stats and search.
  const stats = T.statsFor(target0)
  if (!(stats.min > 0 && stats.min <= stats.body + 1e-9)) problems.push('statsFor produced a nonsense minimum')
  const darkCount = T.themes().filter(t => T.matches(t, 'dark')).length
  if (darkCount === 0 || darkCount === T.themes().length) problems.push(`mode search matched ${darkCount} themes`)
  const hexHits = T.themes().filter(t => T.matches(t, '#2e3440')).length
  if (hexHits === 0) problems.push('hex search found nothing')

  // Export writes a file through the browser download path.
  {
    const realDoc = globalThis.document
    let clicked = 0
    globalThis.document = {
      createElement: () => ({ set href(_v) {}, set download(_v) {}, click: () => { clicked += 1 } })
    }
    try {
      const ok = T.exportThemes([target0.name])
      if (!ok) problems.push('exportThemes refused to export a real theme')
      if (clicked !== 1) problems.push(`exportThemes clicked ${clicked} download anchors, expected 1`)
    } finally {
      if (realDoc === undefined) delete globalThis.document
      else globalThis.document = realDoc
    }
  }

  // Screen lens: the EyeDropper path must paint the sampled colour.
  {
    const realWin = globalThis.window
    globalThis.window = { innerWidth: 1200, innerHeight: 800, EyeDropper: class { open() { return Promise.resolve({ sRGBHex: '#123123' }) } } }
    try {
      await T.screenLens(target0.name, 'background')
      if (target0.colors.background !== '#123123') problems.push(`screen lens painted ${target0.colors.background}`)
      globalThis.window = { innerWidth: 1200, innerHeight: 800 }
      await T.screenLens(target0.name, 'background')
    } finally {
      if (realWin === undefined) delete globalThis.window
      else globalThis.window = realWin
    }
  }

  // Delete removes the registration it created.
  const disposedBefore = disposed
  if (created) {
    T.deleteEntry(created)
    if (T.theme(created)) problems.push('deleteEntry left the theme in the lookup')
    if (T.themes().length !== before + 1) problems.push(`deleteEntry left ${T.themes().length - (before + 1)} extra themes`)
    if (disposed === disposedBefore) problems.push('deleteEntry did not dispose the registration')
  }

  // Stars persist.
  T.toggleStar(target0.name)
  if (!T.stars()[target0.name]) problems.push('star did not stick')
  await new Promise(resolve => setTimeout(resolve, 320))
  const starWrite = storageWrites.filter(w => w.key === 'favorites').pop()
  if (!starWrite || !starWrite.value[target0.name]) problems.push('stars were never persisted')
  T.toggleStar(target0.name)
}

// The page shows the affordances the new features depend on.
const chipByText = (tree, rx) =>
  findAll(tree, n => n.type === 'button' && typeof n.props?.children === 'string' && rx.test(n.props.children))[0]
const rowThemes = tree => findAll(tree, n => typeof n.props?.['data-theme'] === 'string').map(n => n.props['data-theme'])

{
  const tree2 = rerender()
  if (!findAll(tree2, n => n.props?.['data-star']).length) problems.push('rows render no star button')
  if (!findAll(tree2, n => typeof n.props?.children === 'string' && /^\d+\.\d\d:1$/.test(n.props.children)).length) {
    problems.push('rows render no contrast badge')
  }
  if (!findAll(tree2, n => n.props?.className === 'tc-chip tc-edit-chip').length) problems.push('editable chips carry no affordance class')

  // Mode filter: the Edited chip must show exactly the edited themes.
  const editedChip = chipByText(tree2, /^Edited \d+$/)
  if (!editedChip) problems.push('toolbar has no Edited filter')
  else {
    editedChip.props.onClick()
    const editedRows = rowThemes(rerender()).length
    const expected = Object.keys(T.edits()).length
    if (editedRows !== expected) problems.push(`Edited filter shows ${editedRows} rows, expected ${expected}`)
    const allChip = chipByText(rerender(), /^All$/)
    if (allChip) allChip.props.onClick()
  }

  // Sort by contrast must be monotonic.
  const sortChip = chipByText(rerender(), /^Sort: catalog$/)
  if (!sortChip) problems.push('toolbar has no sort toggle')
  else {
    sortChip.props.onClick()
    const sorted = rowThemes(rerender())
    if (sorted.length !== T.themes().length) problems.push(`contrast sort rendered ${sorted.length} rows`)
    let previous = Infinity
    for (const name of sorted.slice(0, 40)) {
      const value = T.statsFor(T.theme(name)).min
      if (value > previous + 1e-9) {
        problems.push('contrast sort is not descending')
        break
      }
      previous = value
    }
    const backChip = chipByText(rerender(), /^Sort: contrast$/)
    if (backChip) backChip.props.onClick()
  }
}

console.log(`registrations    : ${themes.length} themes + 1 route + 1 nav + 1 palette (first pass)`)
console.log(`re-registered    : ${registrations.length - firstPass} theme publishes (re-register, edit, reset, boot restore)`)
console.log(`disposers run    : ${disposed}`)
console.log(`page render      : ${page ? "ok" : "failed"}`)
console.log(`strips verified  : ${strips.length}`)
console.log(`authoring        : save/import/export/undo/compare/delete exercised (${plugin.__test?.themes().length} themes, ${plugin.__test?.custom().length} saved)`)
console.log(`elements built    : ${nodesBuilt} (all 606 rows, no virtualization)`)
console.log(`problems         : ${problems.length}`)
for (const line of problems.slice(0, 20)) console.log('  ✗', line)

process.exit(problems.length === 0 ? 0 : 1)
