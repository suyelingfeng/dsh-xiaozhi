// Offline smoke test: a fake WebSocket plays the XiaoZhi broker, a fake ctx plays
// the DSH host. No network, no DSH, no writes outside .test-home.
import { mkdirSync, writeFileSync } from 'node:fs'
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
check('tools/list returns every tool', tools.length === 11, JSON.stringify(names))
check('tool names are the expected ones', ['dsh_diagnostics', 'dsh_list_chats', 'dsh_read_conversation', 'dsh_send_message', 'dsh_status', 'dsh_stop', 'dsh_pending', 'dsh_answer', 'dsh_jobs', 'dsh_job_kill', 'dsh_new_chat'].every((name) => names.includes(name)), JSON.stringify(names))
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

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
