// Offline smoke test: a fake WebSocket plays the XiaoZhi broker, a fake ctx plays
// the DSH host. No network, no DSH, no writes outside .test-home.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
process.env.DSH_HOME = join(here, '..', '.test-home')

class FakeSocket {
  constructor(url) {
    this.url = url
    this.sent = []
    this.listeners = new Map()
    FakeSocket.last = this
  }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }
  emit(type, event) {
    for (const fn of this.listeners.get(type) ?? []) fn(event)
  }
  send(data) { this.sent.push(JSON.parse(data)) }
  close() { this.emit('close', { code: 1000, reason: 'test' }) }
}
globalThis.WebSocket = FakeSocket

const never = () => {}
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === '' ? '' : ` — ${detail}`}`)
}

const handlers = new Map()
const jobs = [
  { id: 'job-abc123', label: 'pnpm test', status: 'running', owner: 'session-a' },
  { id: 'job-done', label: 'old build', status: 'done', owner: 'session-a' },
]
// Late questions live in the `userQuestions` projection of a Session.
const projectionState = {
  session: { seq: 9 },
  view: { questions: { active: [], settled: [] } },
}
const routes = []
const ctx = {
  logger: () => ({ info: never, warn: never }),
  on(type, fn) {
    const list = handlers.get(type)
    if (list === undefined) handlers.set(type, [fn])
    else list.push(fn)
  },
  effect(fn) { fn() },
  get(name) {
    if (name === 'jobs') return { list: async () => jobs, kill(id, owner, reason) { ctx.killed = { id, owner, reason } } }
    if (name === 'connection') {
      return { fetch: { register: (route) => { routes.push(route); return () => {} } } }
    }
    if (name === 'sessionProjections') {
      return { stateOf: (session, key) => (key === 'userQuestions' ? projectionState.view : undefined) }
    }
    if (name === 'userQuestions') {
      return {
        answer(agent, callId, batch) {
          ctx.lateAnswer = { agentId: agent?.id, callId, batch }
          if (ctx.answerThrows !== undefined) throw Object.assign(new Error(ctx.answerThrows.message), { code: ctx.answerThrows.code })
          return ctx.answerAccepts !== false
        },
      }
    }
    return undefined
  },
  sessionController: {
    async list() {
      return { items: [
        { sessionId: 'session-a', updatedAt: Date.now() - 60_000, running: false, blank: false, cwd: 'D:/work/alpha', projections: { values: { title: '小智测试' } } },
        { sessionId: 'session-b', updatedAt: Date.now() - 3_600_000, running: false, blank: false, cwd: 'D:/work/beta' },
      ] }
    },
    async create(request) { ctx.created = request; return { sessionId: 'session-new' } },
    async resolveAgent(id) {
      return { agent: { id, status: 'running', session: { seq: 7 }, cancel() { ctx.cancelled = id } } }
    },
    async page() {
      return { records: [
        { event: { type: 'user/message', data: { content: [{ type: 'text', text: '帮我看下构建' }] } } },
        { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '构建挂了，缺依赖' }] } } } },
        { event: { type: 'tool/call', data: { name: 'bash' } } },
      ] }
    },
    async prompt(request) { ctx.prompt = request },
  },
}

const plugin = await import('../index.js')
plugin.apply(ctx, {
  endpoint: 'wss://example.test/mcp/?token=abc',
  allowControl: true,
})

const socket = FakeSocket.last
check('plugin connects at load', socket !== undefined && socket.url.includes('token=abc'), socket?.url)
socket.emit('open', {})

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))
const send = async (message) => {
  socket.sent.length = 0
  socket.emit('message', { data: JSON.stringify(message) })
  await tick()
  return socket.sent.at(-1)
}

const init = await send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', clientInfo: { name: 'xz-mcp-broker' } } })
check('initialize echoes the protocol version', init?.result?.protocolVersion === '2024-11-05', JSON.stringify(init))
check('initialize advertises tools', init?.result?.capabilities?.tools !== undefined, JSON.stringify(init?.result?.capabilities))
check('initialize names the server', init?.result?.serverInfo?.name === 'deepseek-harness', JSON.stringify(init?.result?.serverInfo))

const list = await send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
const tools = list?.result?.tools ?? []
const names = tools.map((tool) => tool.name).sort()
check('tools/list returns every tool', tools.length === 14, JSON.stringify(names))
check('tool names are the expected ones', ['dsh_diagnostics', 'dsh_list_chats', 'dsh_read_conversation', 'dsh_send_message', 'dsh_status', 'dsh_stop', 'dsh_pending', 'dsh_answer', 'dsh_jobs', 'dsh_job_kill', 'dsh_new_chat', 'dsh_ui_open_session', 'dsh_ui_panel', 'dsh_ui_sidebar'].every((name) => names.includes(name)), JSON.stringify(names))
check('every tool has an input schema', tools.every((tool) => tool.inputSchema?.type === 'object'))
check('no handler leaks into the schema', tools.every((tool) => tool.run === undefined))

const call = (id, name, args) => send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args ?? {} } })
const textOf = (frame) => frame?.result?.content?.[0]?.text ?? ''

const status = await call(2, 'dsh_status')
check('dsh_status answers', textOf(status).includes('DeepSeek Harness'), textOf(status))
check('dsh_status lists sessions', textOf(status).includes('会话'), textOf(status))

const chats = await call(3, 'dsh_list_chats', { limit: 5 })
check('dsh_list_chats lists titles and folders', textOf(chats).includes('小智测试') && textOf(chats).includes('beta'), textOf(chats))

const read = await call(4, 'dsh_read_conversation', { limit: 5 })
check('dsh_read_conversation reads the history', textOf(read).includes('构建挂了') && textOf(read).includes('帮我看下构建'), textOf(read))
check('dsh_read_conversation marks tool calls', textOf(read).includes('[工具] bash'), textOf(read))

const sent = await call(5, 'dsh_send_message', { message: '继续把测试跑完' })
check('dsh_send_message used the newest session', ctx.prompt?.sessionId === 'session-a', JSON.stringify(ctx.prompt))
check('dsh_send_message queued the text', ctx.prompt?.content?.[0]?.text === '继续把测试跑完' && ctx.prompt?.mode === 'queue', JSON.stringify(ctx.prompt))
check('dsh_send_message reports back', textOf(sent).includes('继续把测试跑完'), textOf(sent))

const stopped = await call(6, 'dsh_stop')
check('dsh_stop cancels the running turn', ctx.cancelled === 'session-a', String(ctx.cancelled))
check('dsh_stop reports back', textOf(stopped).includes('已经停止'), textOf(stopped))

const byTitle = await call(7, 'dsh_read_conversation', { session: '小智' })
check('a title resolves to its session', textOf(byTitle).includes('小智测试'), textOf(byTitle))

const byFolder = await call(11, 'dsh_read_conversation', { session: 'beta' })
check('a session is reachable by its folder', textOf(byFolder).includes('构建挂了'), textOf(byFolder))

const unknownTool = await call(8, 'nope', {})
check('an unknown tool is a JSON-RPC error', unknownTool?.error?.code === -32602, JSON.stringify(unknownTool))

const unknownMethod = await send({ jsonrpc: '2.0', id: 9, method: 'nope/nope' })
check('an unknown method is a JSON-RPC error', unknownMethod?.error?.code === -32601, JSON.stringify(unknownMethod))

const ping = await send({ jsonrpc: '2.0', id: 10, method: 'ping' })
check('ping is answered', ping?.result !== undefined && ping.id === 10, JSON.stringify(ping))

// ── approvals, jobs, new chats ────────────────────────────────────────────────

const fire = (type, ...args) => (handlers.get(type) ?? []).forEach((fn) => fn(...args))

const approveHandler = (handlers.get('approval/request') ?? [])[0]
check('an approval handler is registered', typeof approveHandler === 'function')
let fellThrough = false
const outcome = approveHandler(
  { agent: { id: 'session-a' }, toolName: 'bash', reason: 'run: rm -rf build' },
  async () => { fellThrough = true; return 'allowed-once' },
)

const pending = await call(12, 'dsh_pending')
check('dsh_pending lists the held approval', textOf(pending).includes('等你批准') && textOf(pending).includes('bash'), textOf(pending))
check('a held approval has not fallen through yet', fellThrough === false)

const approved = await call(13, 'dsh_answer', { decision: 'allow' })
check('dsh_answer settles the approval', (await outcome) === 'allowed-once', JSON.stringify(await Promise.race([outcome, Promise.resolve('pending')])))
check('dsh_answer reports back', textOf(approved).includes('已允许'), textOf(approved))

const nothing = await call(14, 'dsh_pending')
check('dsh_pending is empty after answering', textOf(nothing).includes('没有需要你处理的事'), textOf(nothing))

// A held question: the waterfall waits, the bridge reports it, then answers it.
const questionHandler = (handlers.get('user-questions/request') ?? [])[0]
check('a question handler is registered', typeof questionHandler === 'function')
let questionHandedOver = false
const questionAnswer = questionHandler(
  {
    agent: { id: 'session-a', session: { seq: 9 } },
    questions: [{ id: 'q1', question: '跑哪个测试？', options: [{ label: '单元测试' }, { label: '集成测试' }] }],
    wait: { callId: 'call-q1', timed: true },
  },
  async () => {
    questionHandedOver = true
    return { answers: [{ id: 'q1', selected: ['单元测试'] }] }
  },
)

const withQuestion = await call(15, 'dsh_pending')
check('dsh_pending shows the question and its options', textOf(withQuestion).includes('跑哪个测试') && textOf(withQuestion).includes('集成测试'), textOf(withQuestion))

const answeredQuestion = await call(19, 'dsh_answer', { text: '第二个' })
const questionBatch = await questionAnswer
check('dsh_answer answers by option position', questionBatch?.answers?.[0]?.selected?.[0] === '集成测试', JSON.stringify(questionBatch))
check('a spoken answer never fell through to the card', questionHandedOver === false)
check('dsh_answer reports the question answer', textOf(answeredQuestion).includes('集成测试'), textOf(answeredQuestion))

// A question that already timed out is still answerable through the projection.
projectionState.view.questions.active = [{
  callId: 'call-late',
  state: 'continued',
  questions: [{ id: 'q2', question: '要覆盖旧文件吗？', options: [{ label: '覆盖' }, { label: '跳过' }] }],
}]
const latePending = await call(20, 'dsh_pending')
check('dsh_pending shows a late question', textOf(latePending).includes('超时') && textOf(latePending).includes('覆盖旧文件'), textOf(latePending))
const lateAnswered = await call(21, 'dsh_answer', { id: 'call-late', text: '覆盖' })
check('dsh_answer takes a late answer', ctx.lateAnswer?.callId === 'call-late' && ctx.lateAnswer?.batch?.answers?.[0]?.selected?.[0] === '覆盖', JSON.stringify(ctx.lateAnswer))
check('dsh_answer reports the late answer', textOf(lateAnswered).includes('补答'), textOf(lateAnswered))

// Free text that matches no option becomes a custom answer.
const customHandler = questionHandler(
  {
    agent: { id: 'session-a', session: { seq: 9 } },
    questions: [{ id: 'q3', question: '叫什么名字？' }],
    wait: { callId: 'call-q3', timed: true },
  },
  async () => ({ answers: [{ id: 'q3', selected: [] }] }),
)
await call(22, 'dsh_answer', { text: '叫小蓝' })
const customBatch = await customHandler
check('free text becomes a custom answer', customBatch?.answers?.[0]?.custom === '叫小蓝', JSON.stringify(customBatch))

const jobList = await call(16, 'dsh_jobs')
check('dsh_jobs lists running jobs only', textOf(jobList).includes('job-abc123') && !textOf(jobList).includes('job-done'), textOf(jobList))
check('dsh_jobs names the owner', textOf(jobList).includes('小智测试'), textOf(jobList))

const killed = await call(17, 'dsh_job_kill', { id: 'job-abc123' })
check('dsh_job_kill calls kill with the owner', ctx.killed?.id === 'job-abc123' && ctx.killed?.owner === 'session-a', JSON.stringify(ctx.killed))
check('dsh_job_kill reports back', textOf(killed).includes('已经停掉'), textOf(killed))

const created = await call(18, 'dsh_new_chat', { message: '跑一遍测试', cwd: 'D:/work/new' })
check('dsh_new_chat creates a session in the folder', ctx.created?.cwd === 'D:/work/new', JSON.stringify(ctx.created))
check('dsh_new_chat prompts the new session', ctx.prompt?.sessionId === 'session-new' && ctx.prompt?.content?.[0]?.text === '跑一遍测试', JSON.stringify(ctx.prompt))
check('dsh_new_chat reports back', textOf(created).includes('新会话'), textOf(created))

// The address can live outside the config: $DSH_HOME/xiaozhi/endpoint, one line.
mkdirSync(join(process.env.DSH_HOME, 'xiaozhi'), { recursive: true })
writeFileSync(join(process.env.DSH_HOME, 'xiaozhi', 'endpoint'), '# 注释行会被跳过\nwss://example.test/mcp/?token=from-file\n')
plugin.apply({ ...ctx, sessionController: ctx.sessionController }, { allowControl: true })
await tick()
check('the endpoint falls back to the local file', FakeSocket.last?.url === 'wss://example.test/mcp/?token=from-file', FakeSocket.last?.url)

// ── the panel route (the first instance is the connected one) ────────────────

check('the panel route is registered on /api', routes[0]?.path === '/api/xiaozhi' && routes[0]?.methods?.[0] === 'POST', JSON.stringify(routes[0]?.path))

const panel = async (body) => {
  const response = await routes[0].fetch(new Request('http://localhost/api/xiaozhi', { method: 'POST', body: JSON.stringify(body) }))
  return response.json()
}

const overview = await panel({ action: 'state' })
check('panel state describes the bridge', overview.ok === true && overview.value.connected === true && overview.value.version === '0.5.0', JSON.stringify(overview.value ?? overview).slice(0, 160))
check('panel state lists recent sessions', Array.isArray(overview.value?.recent) && overview.value.recent[0]?.name === '小智测试', JSON.stringify(overview.value?.recent))
check('panel state counts sessions', overview.value?.sessions === 2, String(overview.value?.sessions))

const heldApproval = approveHandler(
  { agent: { id: 'session-a' }, toolName: 'write_file', reason: 'write build/out.txt' },
  async () => 'allowed-once',
)
const withApproval = await panel({ action: 'state' })
const approvalId = withApproval.value?.approvals?.[0]?.id
check('panel lists a waiting approval', typeof approvalId === 'string' && withApproval.value.approvals[0].tool === 'write_file', JSON.stringify(withApproval.value?.approvals))
const allowedByPanel = await panel({ action: 'allow', id: approvalId })
check('panel allow settles the approval', (await heldApproval) === 'allowed-once' && allowedByPanel.ok === true, JSON.stringify(allowedByPanel.error ?? allowedByPanel))

const heldQuestion = questionHandler(
  {
    agent: { id: 'session-a', session: { seq: 9 } },
    questions: [{ id: 'q9', question: '用哪个端口？', options: [{ label: '8080' }, { label: '9090' }] }],
    wait: { callId: 'call-q9', timed: true },
  },
  async () => ({ answers: [{ id: 'q9', selected: [] }] }),
)
const withQuestion2 = await panel({ action: 'state' })
const questionId = withQuestion2.value?.questions?.[0]?.id
check('panel lists a waiting question with its options', withQuestion2.value?.questions?.[0]?.asks?.[0]?.options?.includes('9090') === true, JSON.stringify(withQuestion2.value?.questions))
const answeredByPanel = await panel({ action: 'answer', id: questionId, text: '9090' })
check('panel answers the question', (await heldQuestion).answers[0].selected[0] === '9090' && answeredByPanel.ok === true, JSON.stringify(answeredByPanel.error ?? answeredByPanel))

const stale = await panel({ action: 'allow', id: 'nosuch' })
check('panel refuses a stale id', stale.ok === false && stale.error?.code === 'xiaozhi/stale', JSON.stringify(stale))

const unknown = await panel({ action: 'nope' })
check('panel refuses an unknown action', unknown.ok === false, JSON.stringify(unknown))

// ── UI orders: the tool queues one and waits for the browser's ack ───────────

const fireTool = (id, name, args) => {
  socket.sent.length = 0
  socket.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args ?? {} } }) })
}
const waitForFrame = async (id, ms = 3000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const hit = socket.sent.find((frame) => frame.id === id)
    if (hit !== undefined) return hit
    await tick()
  }
  return undefined
}
const pendingCommands = async () => (await panel({ action: 'state' })).value.commands ?? []

fireTool(30, 'dsh_ui_open_session', { session: '小智' })
const askFrame = await waitForFrame(30)
check('the first switch asks before moving anything', textOf(askFrame).includes('要切到'), textOf(askFrame))
check('nothing is queued before the confirmation', (await pendingCommands()).length === 0, JSON.stringify(await pendingCommands()))

fireTool(33, 'dsh_ui_open_session', { session: '小智', confirm: true })
await tick()
const openOrders = await pendingCommands()
const openOrder = openOrders.find((command) => command.kind === 'open_session')
check('the confirmed order carries the resolved session', openOrder?.sessionId === 'session-a', JSON.stringify(openOrders))
await panel({ action: 'ack', ids: [openOrder.id] })
const openFrame = await waitForFrame(33)
check('the confirmed switch reports back', textOf(openFrame).includes('已经切到'), textOf(openFrame))

fireTool(31, 'dsh_ui_panel', { panel: 'xiaozhi' })
await tick()
const panelOrder = (await pendingCommands()).find((command) => command.kind === 'panel')
check('the panel order names the panel', panelOrder?.panel === 'xiaozhi', JSON.stringify(panelOrder))
await panel({ action: 'ack', ids: [panelOrder.id] })
check('the panel tool reports the switch', textOf(await waitForFrame(31)).includes('打开小智桥接面板'), textOf(await waitForFrame(31)))

fireTool(32, 'dsh_ui_sidebar')
await tick()
const sideOrder = (await pendingCommands()).find((command) => command.kind === 'sidebar')
await panel({ action: 'ack', ids: [sideOrder.id], errors: { [sideOrder.id]: 'this shell has no layout.toggleSidebar' } })
const sideFrame = await waitForFrame(32)
check('a refused order is reported, not swallowed', textOf(sideFrame).includes('界面没能执行'), textOf(sideFrame))

const reconnect = await panel({ action: 'reconnect' })
check('panel reconnect is accepted', reconnect.ok === true, JSON.stringify(reconnect.error ?? ''))

// ── changing the address from the panel ─────────────────────────────────────
// The address is the identity, so the route only takes the XiaoZhi service unless the
// profile relaxes it, and it never sends the token back.

const otherHost = await panel({ action: 'set_endpoint', endpoint: 'wss://evil.example/mcp/?token=abc' })
check('the panel refuses another host', otherHost.ok === false && String(otherHost.error?.message).includes('api.xiaozhi.me'), JSON.stringify(otherHost.error))

const noToken = await panel({ action: 'set_endpoint', endpoint: 'wss://api.xiaozhi.me/mcp/' })
check('the panel refuses an address without a token', noToken.ok === false && String(noToken.error?.message).includes('token'), JSON.stringify(noToken.error))

const badScheme = await panel({ action: 'set_endpoint', endpoint: 'http://api.xiaozhi.me/mcp/?token=abc' })
check('the panel refuses a non-websocket address', badScheme.ok === false, JSON.stringify(badScheme.error))

// The reconnect wait uses unref'd timers (right for a host that is shutting down), so the
// test keeps the loop alive while it waits.
const keepAlive = setInterval(() => {}, 200)
const saving = panel({ action: 'set_endpoint', endpoint: 'wss://api.xiaozhi.me/mcp/?token=fake-token' })
await tick()
FakeSocket.last?.emit('open', {})
const saved = await saving
clearInterval(keepAlive)
check('the panel saves a new address', saved.ok === true && saved.value.host === 'api.xiaozhi.me', JSON.stringify(saved).slice(0, 200))
const written = readFileSync(join(process.env.DSH_HOME, 'xiaozhi', 'endpoint'), 'utf8')
check('the address lands in the local file', written.includes('token=fake-token') && written.startsWith('#'), written.split('\n')[1]?.slice(0, 40))
check('the saved address reconnects', saved.value.connected === true, JSON.stringify(saved.value.lastError ?? ''))
check('the state reports where the address came from', saved.value.endpointSource === 'file' && saved.value.endpointHost === 'api.xiaozhi.me', `${saved.value.endpointSource} / ${saved.value.endpointHost}`)

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
