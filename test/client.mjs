// Offline test for the browser half: load the bundle the way the shell's module system
// does, then execute the registered components with a stub React. It cannot prove the
// panel *looks* right, but it proves the bundle loads, registers the two seats, and
// renders without touching anything it should not.
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === '' ? '' : ` — ${detail}`}`)
}

// A React small enough to run the components once: hooks return their initial value.
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  Fragment: 'Fragment',
}

let loaded
const sandbox = {
  window: { __ModuleLoader__: { load: (mod) => { loaded = mod } } },
  console,
  fetch: async () => { throw new Error('offline') },
}
vm.runInNewContext(source, sandbox, { filename: 'client.js' })

check('the bundle registers one module', loaded !== undefined && loaded.id === 'dsh-xiaozhi', JSON.stringify(loaded?.id))

const plugin = loaded.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})
check('it exports a client plugin', typeof plugin.apply === 'function' && Array.isArray(plugin.inject), typeof plugin.apply)
check('it only injects what it needs', JSON.stringify(plugin.inject) === '["slots"]', JSON.stringify(plugin.inject))

const registered = []
const layout = { panel: undefined, selectPanel(id) { this.panel = id } }
const slots = {
  inject: (name, callback) => callback(),
  register: (meta, component) => {
    registered.push({ meta, component })
    return () => {}
  },
}
plugin.apply({ slots, get: (name) => (name === 'layout' ? layout : undefined) })

check('it takes two seats', registered.length === 2, JSON.stringify(registered.map((entry) => entry.meta.name)))
check('the bar lives in shell.bottom', registered[0]?.meta?.name === 'shell.bottom', JSON.stringify(registered[0]?.meta))
check('the panel lives in main', registered[1]?.meta?.name === 'main' && registered[1]?.meta.key === 'xiaozhi', JSON.stringify(registered[1]?.meta))

const textOf = (node) => {
  const out = []
  const walk = (current) => {
    if (current === null || current === undefined || current === false) return
    if (typeof current === 'string' || typeof current === 'number') { out.push(String(current)); return }
    if (Array.isArray(current)) { for (const item of current) walk(item); return }
    if (typeof current === 'object') walk(current.children)
  }
  walk(node)
  return out.join(' ')
}

const bar = registered[0].component({})
const barText = textOf(bar)
check('the bar names the bridge', barText.includes('小智桥接'), barText)
const barDot = (bar.children ?? []).find((child) => child?.props?.style?.borderRadius === 4)
check('the bar carries a status dot', barDot !== undefined && String(barDot.props.style.background).includes('--dsw-'), JSON.stringify(barDot?.props?.style))
bar.props.onClick()
check('clicking the bar opens the panel', layout.panel === 'xiaozhi', String(layout.panel))

const panel = registered[1].component({})
const panelText = textOf(panel)
check('the panel has a title', panelText.includes('小智语音桥接'), panelText)
check('the panel lists both waiting sections', panelText.includes('等你批准') && panelText.includes('等你回答'), panelText)
check('the panel explains where config lives', panelText.includes('cordis.patch.yml'), panelText)

// Get at a rendered element by the text it shows, then press it.
const nodes = (node, out = []) => {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { for (const item of node) nodes(item, out); return out }
  if (typeof node === 'object') { out.push(node); nodes(node.children, out) }
  return out
}
const closeButton = nodes(panel).find((element) => element.children?.[0] === '关闭')
closeButton?.props?.onClick?.()
check('closing the panel returns to the conversation', layout.panel === null, String(layout.panel))

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
