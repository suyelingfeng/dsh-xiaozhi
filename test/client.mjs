// Offline test for the browser half: load the bundle the way the shell's module system
// does, then render it with a stub React and a stub fetch. It cannot prove the panel
// *looks* right, but it proves the bundle loads, registers its two seats, renders, and
// executes the host's UI orders — the part that used to be untestable.
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === '' ? '' : ` — ${detail}`}`)
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 80))

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

// A React small enough to run each component once: hooks return their initial value,
// effects run inline (which is what starts the poller), state changes do nothing.
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: (fn) => { fn() },
  useCallback: (fn) => fn,
  Fragment: 'Fragment',
}

// The host answers `state` with two queued orders, and records the ack it gets back.
const calls = []
const statePayload = {
  version: '0.2.2',
  pid: 1,
  connected: true,
  protocol: '2024-11-05',
  reconnects: 0,
  lastError: '',
  endpointSource: 'file',
  calls: 3,
  sessions: 2,
  approvals: [],
  questions: [],
  recent: [
    { id: 'session-a', name: '小智测试', time: Date.now() - 60_000, running: false },
    { id: 'session-b', name: 'beta', time: Date.now() - 3_600_000, running: true },
  ],
  commands: [
    { id: 7, kind: 'sidebar' },
    { id: 8, kind: 'open_session', sessionId: 'session-a' },
  ],
}
const fetchStub = async (url, options) => {
  const body = JSON.parse(options.body)
  calls.push({ url, body })
  const value = body.action === 'state' ? statePayload : { acked: body.ids?.length ?? 0 }
  return { status: 200, json: async () => ({ ok: true, value }) }
}

let loaded
const sandbox = {
  window: { __ModuleLoader__: { load: (mod) => { loaded = mod } } },
  console,
  fetch: fetchStub,
  // The browser globals the bundle uses for its poller.
  setInterval,
  clearInterval,
  setTimeout,
  clearTimeout,
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
const layout = {
  panel: undefined,
  toggles: 0,
  selectPanel(id) { this.panel = id },
  toggleSidebar() { this.toggles += 1 },
}
const workspace = { opened: undefined, openSession(id) { this.opened = id } }
const services = { layout, uiWorkspace: workspace }
const slots = {
  inject: (name, callback) => callback(),
  register: (meta, component) => {
    registered.push({ meta, component })
    return () => {}
  },
}
plugin.apply({ slots, get: (name) => services[name] })

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

// Rendering the bar starts the page's single poller, which drains the order queue.
const bar = registered[0].component({})
await settle()

check('the order queue toggles the sidebar', layout.toggles === 1, String(layout.toggles))
check('the order queue opens the session', workspace.opened === 'session-a', String(workspace.opened))
const ack = calls.find((entry) => entry.body.action === 'ack')
check('the orders are acknowledged', ack !== undefined && JSON.stringify(ack.body.ids) === '[7,8]', JSON.stringify(ack?.body))

const barText = textOf(bar)
check('the bar names the bridge', barText.includes('小智桥接'), barText)
const barDot = (bar.children ?? []).find((child) => child?.props?.style?.borderRadius === 4)
check('the bar carries a status dot', barDot !== undefined && String(barDot.props.style.background).includes('--dsw-'), JSON.stringify(barDot?.props?.style))

layout.panel = undefined
bar.props.onClick()
check('clicking the bar opens the panel', layout.panel === 'xiaozhi', String(layout.panel))

// A function component is not rendered by createElement; expand them so the tree can be
// read (and clicked) the way React would.
const render = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(render)
  if (typeof node === 'object' && typeof node.type === 'function') return render(node.type(node.props))
  if (typeof node === 'object') return { ...node, children: (node.children ?? []).map(render) }
  return node
}

const panel = render(registered[1].component({}))
const panelText = textOf(panel)
check('the panel has a title', panelText.includes('小智语音桥接'), panelText)
check('the panel lists both waiting sections', panelText.includes('等你批准') && panelText.includes('等你回答'), panelText)
check('the panel explains where config lives', panelText.includes('cordis.patch.yml'), panelText)
check('the panel shows the live status', panelText.includes('已连接') && panelText.includes('2024-11-05'), panelText)
check('the panel can change the address', panelText.includes('接入点') && panelText.includes('保存并重连') && panelText.includes('token 不回显'), panelText)

// The recent list is the panel's own way to switch sessions: a click goes straight to
// the shell, with no confirmation and no poll delay.
check('the panel lists recent sessions', panelText.includes('最近会话') && panelText.includes('小智测试') && panelText.includes('beta'), panelText)
const nodesOf = (node, out = []) => {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { for (const item of node) nodesOf(item, out); return out }
  if (typeof node === 'object') { out.push(node); nodesOf(node.children, out) }
  return out
}
const rowFor = (value) => nodesOf(panel).find((element) => typeof element.props?.onClick === 'function'
  && (element.children ?? []).some((child) => child?.children?.[0] === value))
rowFor('beta')?.props?.onClick?.()
check('clicking a session row opens it', workspace.opened === 'session-b' && layout.panel === null, `${workspace.opened} / ${layout.panel}`)

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
