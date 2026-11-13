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

// ── editing a catalog theme mints a copy, never the catalog ─────────────────
// The catalog is immutable: the first colour you paint on a catalog entry saves
// a copy of it and the edit lands there. Everything below drives that contract.
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
const stripKids = tree => findAll(tree, isStrip).map(n => n.props.children)
const isPanel = n => n.props?.['data-lens-panel'] === 'true'
const clickChip = chip =>
  chip.props.onClick({
    currentTarget: { getBoundingClientRect: () => ({ left: 60, top: 120, bottom: 134 }) },
    preventDefault: () => {},
    stopPropagation: () => {}
  })
const panelText = tree => {
  const texts = []
  const collect = node => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(collect)
    if (typeof node.type === 'function') return collect(node.type({ ...node.props }))
    if (typeof node.props?.children === 'string') texts.push(node.props.children)
    collect(node.props?.children)
  }
  collect(findAll(tree, isPanel)[0])
  return texts.join(' · ')
}
const commitHex = (tree, hex) => {
  const panel = findAll(tree, isPanel)[0]
  const input = findAll(panel, n => n.props?.['aria-label'] === 'Hex')[0]
  if (!input) {
    problems.push('editor has no hex input')
    return
  }
  input.props.onChange({ target: { value: hex } })
}

// The dispose check above ran the plugin's disposers, which nulls its republish
// hook (correctly). Re-register so the edit path has a live registry to publish
// into, exactly as it does in the running app.
plugin.register(makeCtx())
const T = plugin.__test

const catalog = themes[0].data
const catalogName = catalog.name
const catalogBg = catalog.colors.background
const catalogFg = catalog.terminal.foreground
const customBefore = T.custom().length

let tree = rerender()
clickChip(stripKids(tree)[0][0])
tree = rerender()
const panels = findAll(tree, isPanel)
if (panels.length !== 1) problems.push(`editor panel rendered ${panels.length} times, expected 1`)
if (!findAll(tree, n => n.props?.type === 'color').length) problems.push('editor has no system color input')
if (!findAll(tree, n => ['R', 'G', 'B'].includes(n.props?.['aria-label'])).length) problems.push('editor has no RGB fields')
if (!findAll(tree, n => n.props?.['data-hex']).length) problems.push('editor has no preset swatches for the lens')

const countBefore = registrations.length
commitHex(tree, '#101014')
const minted = T.custom().slice(customBefore)
if (minted.length !== 1) problems.push(`painting a catalog colour minted ${minted.length} copies, expected 1`)
const copyName = minted[0]?.name
const copy = copyName ? T.theme(copyName) : null

if (catalog.colors.background !== catalogBg) problems.push(`catalog entry changed to ${catalog.colors.background} — it must stay pristine`)
if (catalog.terminal.foreground !== catalogFg) problems.push('catalog entry foreground changed — it must stay pristine')
if (!copy) problems.push('the minted copy is not registered in the lookup')
else {
  if (copy.colors.background !== '#101014') problems.push(`copy background is ${copy.colors.background}, expected the painted colour`)
  if (copy.label !== `${catalog.label} (mine)`) problems.push(`copy label is ${copy.label}`)
  if (copy.description === undefined) problems.push('copy has no description (the ⌘K palette crashes on that)')
  if (T.edits()[catalogName]) problems.push('the catalog name still carries an override')
  if (!T.edits()[copyName]?.bg) problems.push('the copy did not record the override')
}
const published = registrations.slice(countBefore)
if (!published.some(r => r.id === `theme:${copyName}`)) problems.push('the copy was never registered')
if (published.some(r => r.id === `theme:${catalogName}`)) problems.push('the catalog entry was republished — it must not be')
const customWrite = storageWrites.filter(w => w.key === 'custom-themes').pop()
if (!customWrite || !customWrite.value.some(r => r.name === copyName)) problems.push('the copy was not persisted')
if (!/\(mine\)/.test(panelText(rerender()))) problems.push('the editor did not retarget to the copy')

// A second paint lands on the same copy: a drag must not spray entries.
tree = rerender()
clickChip(stripKids(tree)[0][1])
tree = rerender()
const bodyTab = findAll(findAll(tree, isPanel)[0], n => n.type === 'Button' && n.props?.children === 'Body text')[0]
if (!bodyTab) problems.push('editor has no body-text tab')
else bodyTab.props.onClick()
tree = rerender()
commitHex(tree, '#123456')
if (T.custom().length !== customBefore + 1) problems.push(`a second paint minted ${T.custom().length - customBefore} entries, expected 1`)
if (!copy) problems.push('no copy to assert a second paint against')
else {
  if (copy.terminal.foreground !== '#123456') problems.push(`copy terminal foreground is ${copy.terminal.foreground}, expected the picked #123456`)
  if (contrast(copy.colors.foreground, copy.colors.background) < 4.5) problems.push('edited body text breaks the 4.5:1 floor')
  if (catalog.terminal.foreground !== catalogFg) problems.push('a second paint reached the catalog entry')
}

await new Promise(resolve => setTimeout(resolve, 400))
const editsWrite = storageWrites.filter(w => w.key === 'primary-color-edits').pop()
if (!editsWrite) problems.push('overrides were never persisted')
else if (editsWrite.value[catalogName]) problems.push('an override was persisted against a catalog name')
else if (!editsWrite.value?.[copyName]?.fg) problems.push(`persisted record incomplete: ${JSON.stringify(editsWrite.value)}`)

// Undo, compare, per-slot reset and reset-both all work on your own entry.
// Guarded with `?.` so a broken mint reports instead of taking the harness down.
if (!copyName) problems.push('no copy to exercise undo/reset against')
else {
  T.paintSlot(copyName, 'background', '#111111')
  T.paintSlot(copyName, 'background', '#222222')
  T.undoSlot(copyName, 'background')
  if (copy?.colors.background !== '#111111') problems.push(`undo left background at ${copy?.colors.background}`)
  T.paintSlot(copyName, 'background', '#333333')
  T.beginCompare(copyName)
  if (copy?.colors.background !== catalogBg) problems.push('compare did not show the pre-edit colours')
  T.endCompare(copyName)
  if (copy?.colors.background !== '#333333') problems.push('compare did not restore the edit')
  T.resetSlot(copyName, 'background')
  if (copy?.colors.background !== catalogBg) problems.push('resetSlot kept the background edit')
  if (copy?.terminal.foreground !== '#123456') problems.push('resetSlot also cleared the foreground edit')
  T.resetEdit(copyName)
  if (copy?.terminal.foreground !== catalogFg) problems.push('reset both kept a colour')
}

// Export writes a file through the browser download path.
{
  const realDoc = globalThis.document
  let clicked = 0
  globalThis.document = { createElement: () => ({ set href(_v) {}, set download(_v) {}, click: () => { clicked += 1 } }) }
  try {
    if (!T.exportThemes([copyName])) problems.push('exportThemes refused a real entry')
    if (clicked !== 1) problems.push(`exportThemes clicked ${clicked} download anchors, expected 1`)
  } finally {
    if (realDoc === undefined) delete globalThis.document
    else globalThis.document = realDoc
  }
}

// Screen lens routes through the same mint: painted colour lands on the copy.
{
  const realWin = globalThis.window
  globalThis.window = { innerWidth: 1200, innerHeight: 800, EyeDropper: class { open() { return Promise.resolve({ sRGBHex: '#123123' }) } } }
  try {
    await T.screenLens(catalogName, 'background')
    if (copy?.colors.background !== '#123123') problems.push(`screen lens painted the copy ${copy?.colors.background}`)
    if (catalog.colors.background !== catalogBg) problems.push('screen lens painted the catalog entry')
  } finally {
    if (realWin === undefined) delete globalThis.window
    else globalThis.window = realWin
  }
}

// Import: a payload with 16 ANSI slots becomes a registered theme; junk is refused.
{
  const ansi = ['#000000', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf',
    '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec']
  const imported = T.readImport(JSON.stringify({ version: 1, themes: [{ label: 'Imported Test', bg: '#202020', fg: '#e0e0e0', ansi }] }))
  if (imported.length !== 1) problems.push(`import created ${imported.length} themes, expected 1`)
  else if (T.theme(imported[0])?.terminal.red !== '#cc0000') problems.push('imported palette did not survive')
  if (T.readImport(JSON.stringify({ themes: [{ label: 'bad', bg: 'nope', fg: '#ffffff', ansi }] })).length !== 0) {
    problems.push('import accepted an invalid background')
  }
  const payload = T.exportPayload([imported[0]])
  if (payload.themes[0]?.ansi?.length !== 16) problems.push('export payload has no 16-colour palette')
}

// Migration: an override saved against a catalog name becomes a copy, and the
// catalog entry goes back to what it ships as.
{
  const victim = themes[1].data
  const victimBg = victim.colors.background
  const beforeCount = T.custom().length
  plugin.register(makeCtx({ 'primary-color-edits': { [victim.name]: { bg: '#0a0a0a' } } }))
  const migrated = T.custom().find(r => r.base === victim.name)
  if (!migrated) problems.push('migration did not mint a copy for the saved override')
  else if (T.theme(migrated.name).colors.background !== '#0a0a0a') problems.push('migrated copy lost the saved colour')
  if (T.custom().length !== beforeCount + 1) problems.push(`migration minted ${T.custom().length - beforeCount} entries, expected 1`)
  if (victim.colors.background !== victimBg) problems.push('migration left the catalog entry modified')
  if (T.edits()[victim.name]) problems.push('migration left the override on the catalog name')
  await new Promise(resolve => setTimeout(resolve, 350))
  const trimmed = storageWrites.filter(w => w.key === 'primary-color-edits').pop()
  if (trimmed && trimmed.value?.[victim.name]) problems.push('migration did not clear the stored override')
}

// Delete removes the registration it created.
{
  const disposedBefore = disposed
  const before = T.custom().length
  if (!copyName) problems.push('no copy to delete')
  else T.deleteEntry(copyName)
  if (T.theme(copyName)) problems.push('deleteEntry left the theme in the lookup')
  if (T.custom().length !== before - 1) problems.push('deleteEntry left the record behind')
  if (disposed === disposedBefore) problems.push('deleteEntry did not dispose the registration')
}

// Stars persist.
T.toggleStar(catalogName)
if (!T.stars()[catalogName]) problems.push('star did not stick')
await new Promise(resolve => setTimeout(resolve, 320))
const starWrite = storageWrites.filter(w => w.key === 'favorites').pop()
if (!starWrite || !starWrite.value[catalogName]) problems.push('stars were never persisted')
T.toggleStar(catalogName)

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

  // Mode filter: the Mine chip must show exactly your saved entries.
  const mineChip = chipByText(tree2, /^Mine \d+$/)
  if (!mineChip) problems.push('toolbar has no Mine filter')
  else {
    mineChip.props.onClick()
    const mineRows = rowThemes(rerender()).length
    const expected = T.custom().length
    if (mineRows !== expected) problems.push(`Mine filter shows ${mineRows} rows, expected ${expected}`)
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
