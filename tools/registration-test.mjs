#!/usr/bin/env node
/**
 * Load the generated plugin under stubbed SDK/react modules and exercise its
 * register() entry point. This is the check that catches what a color-math
 * test cannot: module-init errors, a wrong import surface, malformed
 * registration payloads, or a disposer that never runs.
 *
 * Usage: node tools/registration-test.mjs
 */
import { mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
let disposed = 0
const ctx = {
  register: spec => {
    registrations.push(spec)
    return () => { disposed += 1 }
  },
  onDispose: fn => { ctx._onDispose = fn },
  storage: { get: (k, d) => d, set: () => {} }
}

plugin.register(ctx)

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
  if (!titles[0].startsWith('background ')) problems.push(`strip ${index}: first chip is ${titles[0]}`)
  if (!titles[1].startsWith('body text ')) problems.push(`strip ${index}: second chip is ${titles[1]}`)
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

console.log(`registrations    : ${registrations.length} (606 themes, 1 route, 1 nav, 1 palette)`)
console.log(`disposers run    : ${disposed}`)
console.log(`page render      : ${page ? "ok" : "failed"}`)
console.log(`strips verified  : ${strips.length}`)
console.log(`elements built    : ${nodesBuilt} (all 606 rows, no virtualization)`)
console.log(`problems         : ${problems.length}`)
for (const line of problems.slice(0, 20)) console.log('  ✗', line)

process.exit(problems.length === 0 ? 0 : 1)
