// dsh-xiaozhi — a DeepSeek Harness plugin that bridges the harness to a XiaoZhi
// (小智) MCP endpoint over WebSocket, so 小智 can look at DSH conversations and
// control what DSH is doing.
//
// Direction of the protocol matters: the endpoint at
//   wss://api.xiaozhi.me/mcp/?token=…
// is the MCP *client* (its clientInfo is "xz-mcp-broker"). It connects, sends
// `initialize`, then `tools/list`, and calls `tools/call` when its model asks.
// This plugin is the MCP *server* side, and it owns the tools below.
//
// Everything here runs inside the DSH host process, so the tools reach the same
// Session controller the user's own chats use: no second harness, no HTTP token.
//
// Where things are:
//   tools       the 11 descriptors 小智's model sees, each with a `run` closure
//   approvals   holds an approval/request, so a spoken "allow" can settle it
//   questions   holds a user-questions/request, and late-answers timed-out ones
//               through the `userQuestions` projection
//   bridge      the WebSocket: connect, JSON-RPC dispatch, reconnect
//   snapshot    ~/.dsh/xiaozhi/state.json, the only way to see inside from outside
//
// Docs (and the reverse-engineered details) live in docs/: 接入手册 / 协议笔记 /
// 宿主API笔记. Tests: `node test/harness.mjs` (offline) and `node test/live.mjs`.

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-xiaozhi'
export const inject = ['sessionController']

const VERSION = '0.2.1'
const DEFAULT_PROTOCOL = '2024-11-05'
const KEEP_SESSIONS_MS = 5000
const SNAPSHOT_MS = 10_000
const CALL_TIMEOUT_MS = 25_000
const MAX_REPLY = 2000
const LINE_MAX = 500
const CN_NUMBERS = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

export function apply(ctx, config = {}) {
  const settings = readSettings(config)
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const stateDir = join(home, 'xiaozhi')
  const snapshotPath = join(stateDir, 'state.json')

  const log = makeLogger(ctx)
  const state = {
    socket: undefined,
    startedAt: Date.now(),
    connected: false,
    ready: false,
    retryTimer: undefined,
    attempts: 0,
    reconnects: 0,
    lastError: '',
    lastListError: '',
    endpointSource: '', // 'config' | 'file' | 'none' — where the address came from
    calls: 0,
    protocol: '',
    sessions: [],
    sessionsAt: 0,
    sampleKeys: [],
    active: '',
    lastVoiceAt: 0, // when 小智 last called a tool
    voiceSessions: new Map(), // sessionId -> when voice last drove it
    approvals: new Map(), // id -> { id, sessionId, tool, reason, at, state, answer? }
    questions: new Map(), // id -> { id, sessionId, callId, questions, at, state, answer? }
    lastSeen: new Map(), // sessionId -> { type, time, text }
    status: new Map(), // sessionId -> { status, since }
    disposed: false,
  }

  if (settings.endpoint === '') {
    log.warn('no endpoint configured; enable it in the profile patch (dsh-xiaozhi)')
  }

  // ── Session data ────────────────────────────────────────────────────────────

  const idOf = (value) => (typeof value === 'string' ? value : value?.sessionId ?? value?.id ?? '')

  const normalizeSession = (item) => {
    if (item === null || typeof item !== 'object') return undefined
    const id = idOf(item) || idOf(item.address) || idOf(item.session)
    if (!id) return undefined
    // The list summary carries the accepted title as the `title` projection, the
    // folder it started in, and whether an Agent is running it right now.
    const title = String(item.projections?.values?.title ?? item.title ?? item.name ?? '')
    const cwd = typeof item.cwd === 'string' ? item.cwd : (typeof item.workspacePath === 'string' ? item.workspacePath : '')
    const time = Number(item.updatedAt ?? item.lastActivityAt ?? item.lastActiveAt ?? item.createdAt ?? item.time ?? 0)
    const archived = Boolean(item.archived ?? item.archive?.archived ?? item.archive?.archivedAt)
    return {
      id: String(id),
      title,
      cwd,
      time: Number.isFinite(time) ? time : 0,
      archived,
      blank: item.blank === true,
      running: item.running === true,
      raw: item,
    }
  }

  async function listSessions(force = false) {
    const fresh = Date.now() - state.sessionsAt < KEEP_SESSIONS_MS
    if (!force && fresh && state.sessions.length > 0) return state.sessions
    try {
      // The controller takes the signal as its only argument; older builds took an
      // options object first, so try that shape too instead of failing on arity.
      let result
      try {
        result = await ctx.sessionController.list(AbortSignal.timeout(8000))
      } catch (error) {
        if (error?.name === 'TypeError') result = await ctx.sessionController.list({}, AbortSignal.timeout(8000))
        else throw error
      }
      const items = Array.isArray(result) ? result : (result?.items ?? [])
      state.sessions = items.map(normalizeSession).filter(Boolean)
      state.sessionsAt = Date.now()
      state.sampleKeys = (items[0] !== null && typeof items[0] === 'object') ? Object.keys(items[0]) : []
      state.lastListError = ''
    } catch (error) {
      state.lastListError = String(error?.message ?? error)
      log.warn('listing sessions failed: %s', state.lastListError)
      if (state.sessions.length === 0) throw error
    }
    return state.sessions
  }

  const sortedSessions = async (force) => {
    const sessions = await listSessions(force)
    return [...sessions].sort((a, b) => b.time - a.time)
  }

  const agentOf = async (sessionId) => {
    const resolved = await ctx.sessionController.resolveAgent(sessionId)
    if (resolved === null || typeof resolved !== 'object') return undefined
    if ('error' in resolved) {
      const error = resolved.error
      throw new Error(error?.message ?? 'That session is not available')
    }
    return resolved.agent
  }

  // Which Session the user is looking at: the last one that did anything, else the
  // most recently updated one.
  async function resolveSession(name) {
    const asked = String(name ?? '').trim()
    if (asked !== '') {
      if (asked === 'current' || asked === 'active' || asked === '当前') {
        const current = state.active !== '' ? state.active : (await sortedSessions())[0]?.id
        if (current) return current
        throw new Error('There is no session yet')
      }
      const sessions = await sortedSessions()
      const exact = sessions.find((session) => session.id === asked)
      if (exact) return exact.id
      const lowered = asked.toLowerCase()
      const matches = (session) => (session.title !== '' && session.title.toLowerCase().includes(lowered))
        || folderOf(session.cwd).toLowerCase() === lowered
        || (folderOf(session.cwd) !== '' && folderOf(session.cwd).toLowerCase().includes(lowered))
      const byTitle = sessions.filter(matches)
      if (byTitle.length === 1) return byTitle[0].id
      if (byTitle.length > 1) {
        const list = byTitle.slice(0, 5).map((session) => `"${session.title}"`).join(', ')
        throw new Error(`More than one session matches "${asked}": ${list}. Ask which one.`)
      }
      // A bare id that the list has not seen (an older part) is still worth trying.
      if (/^[0-9a-zA-Z_-]{8,}$/.test(asked)) return asked
      throw new Error(`No session matches "${asked}"`)
    }
    if (state.active !== '') return state.active
    const newest = (await sortedSessions())[0]
    if (newest === undefined) throw new Error('There is no session yet')
    return newest.id
  }

  // A session's name for a human: its title, else the folder it works in, else its id.
  const folderOf = (path) => {
    const clean = String(path ?? '').replace(/[\\/]+$/, '')
    const last = clean.split(/[\\/]/).pop() ?? ''
    return last === '' ? '' : last
  }

  const labelOf = async (sessionId) => {
    const found = state.sessions.find((session) => session.id === sessionId)
    if (found !== undefined) {
      if (found.title !== '') return `"${found.title}"`
      const folder = folderOf(found.cwd)
      if (folder !== '') return `"${folder}"`
    }
    return sessionId.slice(0, 24)
  }

  const textOf = (content) => {
    if (typeof content === 'string') return content.trim()
    if (!Array.isArray(content)) return ''
    const parts = []
    for (const block of content) {
      if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join('\n').trim()
  }

  const clip = (text, max) => {
    const clean = String(text ?? '').replace(/\s+\n/g, '\n').trim()
    return clean.length > max ? `${clean.slice(0, max)}…` : clean
  }

  // One Session event as a line of conversation, or nothing when it is not talk.
  const lineOf = (event) => {
    if (event === null || typeof event !== 'object') return undefined
    const data = event.data ?? {}
    if (event.type === 'user/message') {
      const text = textOf(data.content)
      return text === '' ? undefined : { who: 'user', text }
    }
    if (event.type === 'assistant/message') {
      const text = textOf(data.message?.content ?? data.content)
      return text === '' ? undefined : { who: 'assistant', text }
    }
    if (event.type === 'tool/call' && typeof data.name === 'string') {
      return { who: 'tool', text: data.name }
    }
    return undefined
  }

  async function readConversation(sessionId, limit) {
    const agent = await agentOf(sessionId)
    const seq = Number(agent?.session?.seq)
    const throughSeq = Number.isFinite(seq) && seq > 0 ? seq - 1 : undefined
    const page = await ctx.sessionController.page({
      address: { kind: 'session', sessionId },
      ...(throughSeq === undefined ? {} : { throughSeq }),
      maxMessages: Math.max(40, limit * 6),
    }, AbortSignal.timeout(15_000))
    const events = (page?.records ?? []).map((record) => record?.event).filter((event) => event !== undefined)
    const lines = []
    for (const event of events) {
      const line = lineOf(event)
      if (line !== undefined) lines.push(line)
    }
    return lines.slice(-limit)
  }

  async function sendMessage(sessionId, text) {
    await ctx.sessionController.prompt({
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }, AbortSignal.timeout(30_000))
  }

  async function stopSession(sessionId) {
    const agent = await agentOf(sessionId)
    const running = agent?.status === 'running' || state.status.get(sessionId)?.status === 'running'
    if (!running) return false
    agent.cancel({ kind: 'user' })
    state.status.set(sessionId, { status: 'idle', since: Date.now() })
    return true
  }

  const ago = (time) => {
    if (!Number.isFinite(time) || time <= 0) return ''
    const seconds = Math.max(0, Math.round((Date.now() - time) / 1000))
    if (seconds < 60) return '刚刚'
    if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`
    if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`
    return `${Math.round(seconds / 86400)} 天前`
  }

  const usageToday = async () => {
    try {
      const raw = await readFile(join(home, '.dshw-usage.json'), 'utf8')
      const parsed = JSON.parse(raw)
      const parts = []
      if (typeof parsed?.todayUsage === 'number') parts.push(`今日 ¥${parsed.todayUsage.toFixed(2)}`)
      if (typeof parsed?.lastBalance === 'number') parts.push(`余额 ¥${parsed.lastBalance.toFixed(2)}`)
      return parts.join('，')
    } catch {
      return ''
    }
  }

  // Sessions with a turn running: the list says so for every loaded Session, the events
  // say so for the ones this plugin saw start.
  const runningLines = () => {
    const running = new Map()
    for (const session of state.sessions) {
      if (session.running) running.set(session.id, { sessionId: session.id, since: state.status.get(session.id)?.since ?? 0 })
    }
    for (const [sessionId, entry] of state.status) {
      if (entry.status === 'running') running.set(sessionId, { sessionId, since: entry.since })
    }
    return [...running.values()]
  }

  // ── Tools ───────────────────────────────────────────────────────────────────

  async function statusText() {
    const sessions = await sortedSessions()
    const running = runningLines()
    const lines = []
    if (!state.connected) lines.push('（注意：与小智的桥接当前没有连上，这次回答可能来自旧数据。）')
    if (running.length === 0) {
      lines.push('DeepSeek Harness 现在空闲，没有在跑任务。')
    } else {
      lines.push(`DeepSeek Harness 正在跑 ${running.length} 个任务：`)
      for (const item of running) {
        const name = await labelOf(item.sessionId)
        const doing = state.lastSeen.get(item.sessionId)
        const what = doing === undefined ? '' : doing.type === 'tool/call' ? `，正在调用工具 ${doing.text}` : ''
        const howLong = item.since > 0 ? `，已经跑了 ${Math.max(1, Math.round((Date.now() - item.since) / 60000))} 分钟` : ''
        lines.push(`- ${name}${howLong}${what}`)
      }
    }
    if (state.active !== '') {
      const name = await labelOf(state.active)
      const last = state.lastSeen.get(state.active)
      if (last !== undefined && last.type === 'assistant/message' && last.text !== '') {
        lines.push(`最近一条回复（${name}）：${clip(last.text, 300)}`)
      }
    }
    if (sessions.length > 0) {
      const newest = sessions[0]
      const title = newest.title !== '' ? `"${newest.title}"` : newest.id.slice(0, 24)
      lines.push(`最近的会话：${title}（${ago(newest.time) || '时间未知'}）`)
      lines.push(`共有 ${sessions.length} 个会话。`)
    }
    const usage = await usageToday()
    if (usage !== '') lines.push(`用量：${usage}。`)
    return lines.join('\n')
  }

  async function listText(args) {
    const limit = clampLimit(args.limit, 10)
    const sessions = (await sortedSessions())
      .filter((session) => !session.archived)
      .filter((session) => !session.blank || session.title !== '')
      .slice(0, limit)
    if (sessions.length === 0) return '还没有任何会话。'
    const lines = [`最近的 ${sessions.length} 个会话（最新在前）：`]
    sessions.forEach((session, index) => {
      const name = session.title !== '' ? session.title : (folderOf(session.cwd) || '（无标题）')
      const running = session.running || state.status.get(session.id)?.status === 'running' ? '，正在运行' : ''
      lines.push(`${index + 1}. ${name} — ${ago(session.time) || '时间未知'}${running}`)
    })
    lines.push('')
    lines.push('要读某一个，把它的名字告诉我；也可以直接用 dsh_read_conversation。')
    return lines.join('\n')
  }

  async function readText(args) {
    const limit = clampLimit(args.limit, 8)
    const sessionId = await resolveSession(args.session)
    const name = await labelOf(sessionId)
    const lines = await readConversation(sessionId, limit)
    if (lines.length === 0) return `${name} 里还没有可以读的对话。`
    const body = lines.map((line) => {
      const text = clip(line.text, LINE_MAX)
      if (line.who === 'user') return `你：${text}`
      if (line.who === 'assistant') return `DSH：${text}`
      return `[工具] ${text}`
    })
    return `${name} 最近的 ${lines.length} 条：\n\n${clip(body.join('\n'), MAX_REPLY)}`
  }

  async function sendText(args) {
    if (!settings.allowControl) throw new Error('在这个设置里，控制 DSH 的功能被关闭了。')
    const message = String(args.message ?? '').trim()
    if (message === '') throw new Error('要发的内容是空的。')
    const sessionId = await resolveSession(args.session)
    const name = await labelOf(sessionId)
    await sendMessage(sessionId, message)
    state.active = sessionId
    state.voiceSessions.set(sessionId, Date.now())
    return `已经把你的话发给 ${name}：\n「${clip(message, 200)}」\n它会在 DSH 里开始干活，过程可以在 DSH 界面看到。`
  }

  async function stopText(args) {
    if (!settings.allowControl) throw new Error('在这个设置里，控制 DSH 的功能被关闭了。')
    const sessionId = await resolveSession(args.session)
    const name = await labelOf(sessionId)
    const stopped = await stopSession(sessionId)
    return stopped ? `已经停止 ${name} 正在跑的任务。` : `${name} 现在没有在跑任务，不需要停止。`
  }

  const jobsService = () => {
    const service = ctx.get?.('jobs') ?? ctx.jobs
    return service !== undefined && service !== null && typeof service.list === 'function' ? service : undefined
  }

  // ── Questions: held in the waterfall, or answered late from the projection ───

  const voiceRecent = (sessionId) => {
    const at = state.voiceSessions.get(sessionId)
    return (state.lastVoiceAt > 0 && Date.now() - state.lastVoiceAt < settings.voiceWindowMs)
      || (at !== undefined && Date.now() - at < settings.voiceWindowMs)
  }

  const optionsLine = (question) => {
    const options = Array.isArray(question?.options) ? question.options : []
    if (options.length === 0) return ''
    return ` 选项：${options.map((option, index) => `${index + 1}) ${option?.label ?? ''}`).join('  ')}`
  }

  const describeQuestion = (question, index) => {
    const head = question?.header !== undefined && question.header !== '' ? `[${question.header}] ` : ''
    const prefix = index === undefined ? '' : `${index + 1}. `
    return `${prefix}${head}${question?.question ?? ''}${optionsLine(question)}`
  }

  // A spoken answer as one answer item: an option picked by name or position, or the
  // words themselves as a custom answer.
  function answerItemFor(question, text) {
    const said = String(text ?? '').trim()
    const options = Array.isArray(question?.options) ? question.options.filter((option) => typeof option?.label === 'string') : []
    const labels = (value) => {
      const hit = options.find((option) => option.label === value)
      if (hit !== undefined) return hit.label
      const loose = options.find((option) => option.label.includes(value) || value.includes(option.label))
      return loose?.label
    }
    if (said === '') return { id: question.id, selected: [] }
    // "2", "第2个", "第二个", "选第二个": pick an option by where it sits in the list.
    const ordinal = said.replace(/^(?:就|选|选中|要|按|给我)\s*/, '').match(/^(?:第)?\s*([0-9]+|[一二两三四五六七八九十])\s*(?:个|项|条|号)?[吧啊呀。!！]?$/)
    if (ordinal !== null) {
      const token = ordinal[1]
      const index = /^[0-9]+$/.test(token) ? Number(token) : CN_NUMBERS[token]
      const picked = options[index - 1]
      if (picked !== undefined) return { id: question.id, selected: [picked.label] }
    }
    if (question?.multiSelect === true && /[、,，/]/.test(said)) {
      const chosen = said.split(/[、,，/]/).map((part) => labels(part.trim())).filter((label) => label !== undefined)
      if (chosen.length > 0) return { id: question.id, selected: chosen }
    }
    const single = labels(said)
    if (single !== undefined) return { id: question.id, selected: [single] }
    return { id: question.id, selected: [], custom: said }
  }

  // The batch has to name every question of the call exactly once.
  function answerBatchFor(questions, args) {
    const text = String(args.text ?? '').trim()
    const given = Array.isArray(args.answers) ? args.answers : []
    const batch = []
    for (const question of questions) {
      const supplied = given.find((item) => String(item?.id ?? '') === String(question.id))
      const said = supplied !== undefined ? String(supplied.text ?? '') : (questions.length === 1 ? text : '')
      if (said.trim() === '') {
        throw new Error(`这个问题里有 ${questions.length} 个问题，要一个个答：用 answers 传 [{id, text}]，id 分别是 ${questions.map((item) => item.id).join('、')}。`)
      }
      batch.push(answerItemFor(question, said))
    }
    return batch
  }

  // Questions that already fell out of the foreground wait: the projection keeps them
  // `continued`, and the service can still take a late answer for them.
  async function lateQuestions() {
    const service = ctx.get?.('userQuestions')
    const projections = ctx.get?.('sessionProjections')
    if (service === undefined || service === null || projections === undefined || projections === null) return []
    // Only Sessions this process has seen work: resolving a cold one would activate it,
    // which is far too much to do behind a spoken question.
    const candidates = [...new Set([state.active, ...state.status.keys()])].filter((id) => id !== '').slice(0, 6)
    const found = []
    const seen = new Set()
    for (const sessionId of candidates) {
      try {
        const agent = await agentOf(sessionId)
        if (agent === undefined) continue
        const view = projections.stateOf(agent.session, 'userQuestions')
        for (const item of view?.questions?.active ?? []) {
          if (item?.state !== 'continued' || seen.has(item.callId)) continue
          seen.add(item.callId)
          found.push({ sessionId, agent, callId: String(item.callId), questions: Array.isArray(item.questions) ? item.questions : [] })
        }
      } catch {
        /* a Session that cannot be resolved simply has no late questions */
      }
    }
    return found
  }

  const pendingQuestions = async () => [...state.questions.values()].filter((entry) => entry.answer !== undefined)

  // Everything that waits for the user: approvals we hold, questions we hold, and
  // questions that already timed out and can still be answered late.
  async function pendingText() {
    const approvals = [...state.approvals.values()].filter((entry) => entry.answer !== undefined)
    const held = await pendingQuestions()
    const late = await lateQuestions()
    if (approvals.length === 0 && held.length === 0 && late.length === 0) {
      return '没有需要你处理的事：没有待批的请求，也没有卡在等你回答的问题。'
    }
    const lines = []
    if (approvals.length > 0) {
      lines.push(`有 ${approvals.length} 个请求在等你批准：`)
      for (const entry of approvals) {
        const name = await labelOf(entry.sessionId)
        lines.push(`- ${entry.id.slice(0, 8)}：${name} 要执行 ${entry.tool}`)
        if (entry.reason !== '') lines.push(`  原因：${entry.reason}`)
      }
      lines.push('说「允许」或「拒绝」，再说是哪一个。')
    }
    if (held.length > 0) {
      lines.push(`${held.length} 个问题在等你回答：`)
      for (const entry of held) {
        lines.push(`- ${entry.id.slice(0, 8)}：${await labelOf(entry.sessionId)} 问：`)
        entry.questions.forEach((question, index) => lines.push(`  ${describeQuestion(question, entry.questions.length > 1 ? index : undefined)}`))
      }
      lines.push('直接说答案（选项名或第几个都行）。')
    }
    if (late.length > 0) {
      lines.push(`${late.length} 个问题已经超时但还能补答：`)
      for (const item of late) {
        lines.push(`- ${item.callId.slice(0, 8)}：${await labelOf(item.sessionId)} 问：`)
        item.questions.forEach((question, index) => lines.push(`  ${describeQuestion(question, item.questions.length > 1 ? index : undefined)}`))
      }
      lines.push('补答时把问题 id 一起说，或者告诉我只有一个。')
    }
    return lines.join('\n')
  }

  async function answerText(args) {
    if (!settings.allowControl) throw new Error('在这个设置里，控制 DSH 的功能被关闭了。')
    const wanted = String(args.id ?? '').trim().toLowerCase()
    const decision = String(args.decision ?? '').trim().toLowerCase()
    const allow = ['allow', 'allowed', 'yes', 'ok', 'true', '允许', '同意', '批准', '放行'].includes(decision)
    const reject = ['reject', 'deny', 'no', 'false', '拒绝', '不允许', '驳回'].includes(decision)

    for (const entry of state.approvals.values()) {
      if (entry.answer === undefined) continue
      if (wanted !== '' && !entry.id.startsWith(wanted)) continue
      if (!allow && !reject) throw new Error('批审批要用 decision：allow 或 reject。')
      entry.answer(allow ? 'allow' : 'reject')
      return `${allow ? '已允许' : '已拒绝'}：${await labelOf(entry.sessionId)} 的 ${entry.tool}。`
    }

    for (const entry of await pendingQuestions()) {
      if (wanted !== '' && !entry.id.startsWith(wanted)) continue
      const batch = answerBatchFor(entry.questions, args)
      entry.answer(batch)
      const said = batch.map((item) => (item.selected.length > 0 ? item.selected.join('、') : item.custom ?? '（跳过）')).join('；')
      return `已回答 ${await labelOf(entry.sessionId)} 的问题：${said}`
    }

    for (const item of await lateQuestions()) {
      if (wanted !== '' && !item.callId.toLowerCase().startsWith(wanted)) continue
      const service = ctx.get?.('userQuestions')
      if (service === undefined || service === null) throw new Error('这个 DSH 没有问答服务。')
      const batch = answerBatchFor(item.questions, args)
      let accepted
      try {
        accepted = service.answer(item.agent, item.callId, { answers: batch })
      } catch (error) {
        const code = error?.code ?? ''
        if (code === 'REPLY_QUEUED') throw new Error('这个问题已经有一个回答在排队了，等一下。')
        if (code === 'BAD_ANSWER') throw new Error(`回答没有覆盖问题里的每一项：${item.questions.map((question) => question.id).join('、')}。`)
        if (code === 'CALLER_NOT_LIVE' || code === 'DELEGATED_CALLER') throw new Error('这个会话现在不能从外部补答（它不是活跃的根会话）。')
        throw error
      }
      if (accepted !== true) throw new Error('这条问题已经答过了，或者已经不在等你了。')
      const said = batch.map((answer) => (answer.selected.length > 0 ? answer.selected.join('、') : answer.custom ?? '（跳过）')).join('；')
      return `已补答 ${await labelOf(item.sessionId)} 的问题：${said}`
    }

    throw new Error('没有对上任何待处理的事；先用 dsh_pending 看看现在有什么。')
  }

  async function jobsText(args) {
    const service = jobsService()
    if (service === undefined) return '这个 DSH 没有后台任务服务，读不到作业列表。'
    const owned = args.session === undefined || String(args.session).trim() === '' ? undefined : await resolveSession(args.session)
    let listed
    try {
      listed = await service.list()
    } catch {
      listed = await service.list(owned)
    }
    const items = (Array.isArray(listed) ? listed : [])
      .filter((job) => job?.status === 'running' || job?.status === 'stopping')
      .filter((job) => owned === undefined || job.owner === owned)
    if (items.length === 0) return '没有正在跑的后台任务。'
    const lines = [`有 ${items.length} 个后台任务在跑：`]
    for (const job of items) {
      const owner = job.owner === undefined ? '不属于某个会话' : await labelOf(job.owner)
      lines.push(`- ${job.id}：${job.label ?? '（没有说明）'}（${job.status}，${owner}）`)
    }
    lines.push('要停哪一个，把它的 id 告诉我。')
    return lines.join('\n')
  }

  async function jobKillText(args) {
    if (!settings.allowControl) throw new Error('在这个设置里，控制 DSH 的功能被关闭了。')
    const service = jobsService()
    if (service === undefined) throw new Error('这个 DSH 没有后台任务服务。')
    const wanted = String(args.id ?? '').trim()
    if (wanted === '') throw new Error('要停哪一个任务？给我任务的 id。')
    const listed = await service.list().catch(() => [])
    const job = (Array.isArray(listed) ? listed : []).find((item) => String(item?.id) === wanted || String(item?.id).startsWith(wanted))
    if (job === undefined) throw new Error(`没有找到 id 是 ${wanted} 的任务。`)
    service.kill(job.id, job.owner, 'stopped from the voice bridge')
    return `已经停掉后台任务 ${job.id}${job.label === undefined ? '' : `（${job.label}）`}。`
  }

  async function newChatText(args) {
    if (!settings.allowControl) throw new Error('在这个设置里，控制 DSH 的功能被关闭了。')
    const message = String(args.message ?? '').trim()
    if (message === '') throw new Error('要让它做什么？')
    const cwd = String(args.cwd ?? '').trim()
    const created = await ctx.sessionController.create(cwd === '' ? {} : { cwd })
    const sessionId = created?.sessionId ?? created?.id
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('新会话没有建起来。')
    await sendMessage(sessionId, message)
    state.active = sessionId
    state.voiceSessions.set(sessionId, Date.now())
    const refresh = setTimeout(() => { void listSessions(true).catch(() => {}) }, 600)
    refresh.unref?.()
    return `已经在${cwd === '' ? '默认工作区' : ` ${cwd} `}开了一个新会话，并让它开工：\n「${clip(message, 200)}」\n会话 id：${sessionId}`
  }

  async function diagnosticsText() {
    await listSessions(true).catch(() => {})
    const payload = {
      version: VERSION,
      connected: state.connected,
      ready: state.ready,
      protocol: state.protocol,
      reconnects: state.reconnects,
      lastError: state.lastError,
      calls: state.calls,
      active: state.active,
      sessionCount: state.sessions.length,
      sampleKeys: state.sampleKeys,
      sessions: state.sessions.slice(0, 5).map((session) => ({ id: session.id, title: session.title, time: session.time, archived: session.archived })),
      status: [...state.status.entries()].slice(0, 5),
      lastSeen: [...state.lastSeen.entries()].slice(0, 5).map(([id, entry]) => ({ id, type: entry.type, time: entry.time })),
    }
    return clip(JSON.stringify(payload, null, 2), MAX_REPLY)
  }

  // What 小智's model sees. `description` is written for a voice assistant that must
  // decide when to call: it says what the user would say. `run` is our side and is
  // stripped from `tools/list`; only `name`/`description`/`inputSchema` go over the wire.
  // Note the MCP dialect: `inputSchema` (JSON Schema), not DSH's `parameters`.
  const tools = [
    {
      name: 'dsh_status',
      description: '查看 DeepSeek Harness（用户电脑上的 AI 助手，简称 DSH）现在的状态：是否正在跑任务、在跑哪个会话、最近一条回复、今天的用量。用户问「DSH 在干嘛」「好了吗」「现在什么状态」时用它。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => statusText(),
    },
    {
      name: 'dsh_list_chats',
      description: '列出 DeepSeek Harness 最近的会话（标题、最后活动时间）。用户想知道有哪些对话、要找某个对话时用它。',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'integer', description: '要列几个，默认 10，最多 30' } },
        additionalProperties: false,
      },
      run: (args) => listText(args),
    },
    {
      name: 'dsh_read_conversation',
      description: '读取 DeepSeek Harness 里某个会话最近的对话内容（你、DSH 的回复、以及它调用的工具）。session 可不填：默认是最近活跃的会话；也可以填会话标题的一部分或会话 ID。用户问「刚才聊了什么」「DSH 说了什么」时用它。',
      inputSchema: {
        type: 'object',
        properties: {
          session: { type: 'string', description: '会话标题的一部分或会话 ID；不填就是最近活跃的会话' },
          limit: { type: 'integer', description: '读最近几条，默认 8，最多 40' },
        },
        additionalProperties: false,
      },
      run: (args) => readText(args),
    },
    {
      name: 'dsh_send_message',
      description: '把一条消息发给 DeepSeek Harness，让它开始或继续在电脑上干活。message 要写成完整、自足的一句话，因为它看不到这段语音对话。session 可不填（默认最近活跃的会话）。',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: '要发给 DSH 的完整内容' },
          session: { type: 'string', description: '会话标题的一部分或会话 ID；不填就是最近活跃的会话' },
        },
        required: ['message'],
        additionalProperties: false,
      },
      run: (args) => sendText(args),
    },
    {
      name: 'dsh_stop',
      description: '停止 DeepSeek Harness 正在运行的任务。用户说「停」「别做了」「打断它」时用它。',
      inputSchema: {
        type: 'object',
        properties: { session: { type: 'string', description: '会话标题的一部分或会话 ID；不填就是最近活跃的会话' } },
        additionalProperties: false,
      },
      run: (args) => stopText(args),
    },
    {
      name: 'dsh_pending',
      description: '列出 DeepSeek Harness 正在等你处理的事：① 待批准的请求（它要执行命令、写文件、联网，在等你放行）；② 正在等你回答的问题（连同选项，以及是第几个）。用户问「有要我处理的吗」「它是不是卡住了」「它在问我什么」时用它。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => pendingText(),
    },
    {
      name: 'dsh_answer',
      description: '回应 DeepSeek Harness 里一件等你的事。两种情况：① 审批——用 decision 说 allow（放行）或 reject（拒绝）；② 提问——用 text 说答案，选项的标签、序号的「第一个」，或者你自己的话都行；一个问题批次里有多问时，用 answers 逐个给。id 用 dsh_pending 里的那串；只有一件在等时可以省略。用户说「允许」「拒绝」「选第一个」「就按 B」「用默认」时用它。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'dsh_pending 里那件事的 id 前几位；只有一件在等时可以省略' },
          decision: { type: 'string', enum: ['allow', 'reject'], description: '审批用：allow 放行，reject 拒绝' },
          text: { type: 'string', description: '回答提问用：选项标签、序号（如「第一个」），或者你自己的话' },
          answers: {
            type: 'array',
            description: '一个问题批次里有多个问题时，按问题逐个给答案',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '问题的 id' },
                text: { type: 'string', description: '对这个问题的回答' },
              },
              required: ['id', 'text'],
            },
          },
        },
        additionalProperties: false,
      },
      run: (args) => answerText(args),
    },
    {
      name: 'dsh_jobs',
      description: '列出 DeepSeek Harness 正在跑的后台任务（长命令、测试、服务等）。session 可不填。用户问「后台在跑什么」时用它。',
      inputSchema: {
        type: 'object',
        properties: { session: { type: 'string', description: '只看某个会话的任务；不填就是全部' } },
        additionalProperties: false,
      },
      run: (args) => jobsText(args),
    },
    {
      name: 'dsh_job_kill',
      description: '停掉一个后台任务。id 从 dsh_jobs 里来。用户说「把那个后台任务停掉」时用它。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: '后台任务 id' } },
        required: ['id'],
        additionalProperties: false,
      },
      run: (args) => jobKillText(args),
    },
    {
      name: 'dsh_new_chat',
      description: '在 DeepSeek Harness 里开一个新会话并立刻派活。cwd 是要它工作的文件夹（不填就用默认工作区）。用户说「新开一个」「去某某文件夹做某事」时用它。',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: '交给 DSH 的完整任务描述' },
          cwd: { type: 'string', description: '工作目录的完整路径，例如 D:\\projects\\demo' },
        },
        required: ['message'],
        additionalProperties: false,
      },
      run: (args) => newChatText(args),
    },
    {
      name: 'dsh_diagnostics',
      description: '内部诊断：返回桥接和 DSH 会话的原始信息，排查连接问题时用。平时不要用。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => diagnosticsText(),
    },
  ]

  const toolMap = new Map(tools.map((tool) => [tool.name, tool]))

  // ── MCP over the WebSocket ──────────────────────────────────────────────────

  const rpcFail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

  async function callTool(params) {
    const key = String(params?.name ?? '')
    const tool = toolMap.get(key)
    if (tool === undefined) return rpcFail(params?.id, -32602, `Unknown tool: ${key}`)
    const args = params?.arguments !== null && typeof params?.arguments === 'object' ? params.arguments : {}
    state.calls += 1
    state.lastVoiceAt = Date.now()
    try {
      const value = await withTimeout(tool.run(args), CALL_TIMEOUT_MS)
      return { jsonrpc: '2.0', id: params.id, result: { content: [{ type: 'text', text: String(value ?? '') }] } }
    } catch (error) {
      log.warn('tool %s failed: %s', key, error?.message ?? error)
      return { jsonrpc: '2.0', id: params.id, result: { content: [{ type: 'text', text: `出错了：${error?.message ?? error}` }], isError: true } }
    }
  }

  async function handleOne(message, send) {
    if (message === null || typeof message !== 'object') return
    const { id, method } = message
    const isRequest = id !== undefined && id !== null
    if (typeof method !== 'string') return
    if (!isRequest) {
      if (method === 'notifications/initialized') state.ready = true
      return
    }
    try {
      switch (method) {
        case 'initialize': {
          const asked = message.params?.protocolVersion
          state.protocol = typeof asked === 'string' ? asked : DEFAULT_PROTOCOL
          send({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: state.protocol,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'deepseek-harness', version: VERSION },
              instructions: '这些工具让语音助手查看并控制用户电脑上的 DeepSeek Harness。回复用中文，简洁。',
            },
          })
          return
        }
        case 'ping':
          send({ jsonrpc: '2.0', id, result: {} })
          return
        case 'tools/list':
          send({ jsonrpc: '2.0', id, result: { tools: tools.map(({ run, ...tool }) => tool) } })
          return
        case 'tools/call':
          send(await callTool({ ...message.params, id }))
          return
        case 'resources/list':
          send({ jsonrpc: '2.0', id, result: { resources: [] } })
          return
        case 'resources/templates/list':
          send({ jsonrpc: '2.0', id, result: { resourceTemplates: [] } })
          return
        case 'prompts/list':
          send({ jsonrpc: '2.0', id, result: { prompts: [] } })
          return
        case 'logging/setLevel':
          send({ jsonrpc: '2.0', id, result: {} })
          return
        case 'completion/complete':
          send({ jsonrpc: '2.0', id, result: { completion: { values: [] } } })
          return
        default:
          send(rpcFail(id, -32601, `Method not found: ${method}`))
      }
    } catch (error) {
      send(rpcFail(id, -32603, String(error?.message ?? error)))
    }
  }

  // $DSH_HOME/xiaozhi/endpoint holds the access-point URL on one line (a leading `#`
  // is a comment). Writing it here instead of in the YAML keeps the token out of a file
  // people paste into issues or commit by accident. The plugin never logs its contents.
  async function loadEndpointFile() {
    try {
      const text = await readFile(join(stateDir, 'endpoint'), 'utf8')
      const line = text.split(/\r?\n/).map((item) => item.trim()).find((item) => item !== '' && !item.startsWith('#'))
      if (line !== undefined && line !== '') {
        settings.endpoint = line
        state.endpointSource = 'file'
        return
      }
    } catch {
      /* no file: the plugin simply stays idle */
    }
    state.endpointSource = 'none'
    state.lastError = `no endpoint: set it in the profile patch, or write it to ${join(stateDir, 'endpoint')}`
  }

  // One socket at a time. The endpoint accepts a single connection per token, so a
  // reconnect always happens after the previous socket reported `close`; every handler
  // checks `state.socket === socket` so a late event from a dead socket cannot win.
  function connect() {
    if (state.disposed || settings.endpoint === '') return
    // Electron's main process is Node, so this is normally there; an old runtime
    // without it should say so in state.json instead of failing silently.
    if (typeof globalThis.WebSocket !== 'function') {
      state.lastError = 'this runtime has no WebSocket support'
      scheduleReconnect()
      return
    }
    const url = withToken(settings.endpoint, settings.token)
    let socket
    try {
      socket = new WebSocket(url)
    } catch (error) {
      state.lastError = `cannot open socket: ${error?.message ?? error}`
      scheduleReconnect()
      return
    }
    state.socket = socket
    const send = (frame) => {
      try {
        socket.send(JSON.stringify(frame))
      } catch (error) {
        state.lastError = `send failed: ${error?.message ?? error}`
      }
    }
    socket.addEventListener('open', () => {
      if (state.socket !== socket) return
      state.connected = true
      state.ready = false
      state.attempts = 0
      state.lastError = ''
      log.info('connected to the XiaoZhi MCP endpoint')
      void writeSnapshot()
    })
    socket.addEventListener('message', (event) => {
      const raw = typeof event.data === 'string' ? event.data : String(event.data)
      let payload
      try {
        payload = JSON.parse(raw)
      } catch {
        return
      }
      const list = Array.isArray(payload) ? payload : [payload]
      for (const item of list) void handleOne(item, send)
    })
    socket.addEventListener('error', (event) => {
      state.lastError = event?.message !== undefined ? String(event.message) : 'socket error'
    })
    socket.addEventListener('close', (event) => {
      if (state.socket !== socket) return
      state.socket = undefined
      state.connected = false
      state.ready = false
      const code = event?.code ?? 0
      const reason = event?.reason ?? ''
      state.lastError = `closed (${code}${reason === '' ? '' : ` ${reason}`})`
      log.warn('connection closed: %s', state.lastError)
      scheduleReconnect()
    })
  }

  function scheduleReconnect() {
    if (state.disposed) return
    state.reconnects += 1
    const base = Math.min(settings.reconnectMaxMs, settings.reconnectMinMs * 2 ** Math.min(state.attempts, 6))
    state.attempts += 1
    const delay = base + Math.floor(Math.random() * base * 0.2)
    if (state.retryTimer !== undefined) clearTimeout(state.retryTimer)
    state.retryTimer = setTimeout(() => {
      state.retryTimer = undefined
      connect()
    }, delay)
    state.retryTimer.unref?.()
  }

  // ── Snapshot, so the bridge can be checked from outside ─────────────────────

  async function writeSnapshot() {
    const running = runningLines().map((item) => ({
      sessionId: item.sessionId,
      since: item.since,
      status: state.lastSeen.get(item.sessionId)?.text ?? '',
    }))
    const payload = {
      plugin: `dsh-xiaozhi@${VERSION}`,
      updatedAt: new Date().toISOString(),
      pid: process.pid,
      startedAt: new Date(state.startedAt).toISOString(),
      connected: state.connected,
      ready: state.ready,
      protocol: state.protocol,
      reconnects: state.reconnects,
      lastError: state.lastError,
      calls: state.calls,
      socketSupport: typeof globalThis.WebSocket === 'function',
      endpointSource: state.endpointSource,
      listError: state.lastListError,
      active: state.active,
      sessionCount: state.sessions.length,
      sampleKeys: state.sampleKeys,
      running,
      approvals: [...state.approvals.values()].map((entry) => ({
        id: entry.id.slice(0, 8),
        tool: entry.tool,
        sessionId: entry.sessionId,
        state: entry.state,
        reason: entry.reason,
      })),
      questions: [...state.questions.values()].map((entry) => ({
        id: entry.id.slice(0, 8),
        callId: entry.callId,
        sessionId: entry.sessionId,
        state: entry.state,
        asks: entry.questions.map((question) => question.question),
      })),
      sessions: state.sessions.slice(0, 8).map((session) => ({
        id: session.id,
        title: session.title,
        cwd: session.cwd,
        time: session.time,
        blank: session.blank,
        running: session.running,
        archived: session.archived,
        status: state.status.get(session.id)?.status ?? '',
      })),
    }
    try {
      await mkdir(stateDir, { recursive: true })
      await writeFile(snapshotPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    } catch {
      /* the snapshot is a convenience, never a requirement */
    }
  }

  // ── Wiring ──────────────────────────────────────────────────────────────────

  ctx.on('session/event', (session, event) => {
    const sessionId = idOf(session) || idOf(event?.data?.session)
    if (!sessionId) return
    state.active = sessionId
    const line = lineOf(event)
    if (line !== undefined) state.lastSeen.set(sessionId, { type: event.type, time: Date.now(), text: line.text })
    else state.lastSeen.set(sessionId, { type: String(event?.type ?? ''), time: Date.now(), text: '' })
    if (event?.type === 'turn/end') state.status.set(sessionId, { status: 'idle', since: Date.now() })
  })

  ctx.on('agent/status', (payload) => {
    const agent = payload?.agent
    const sessionId = idOf(agent)
    if (sessionId) state.status.set(sessionId, { status: String(payload.status ?? ''), since: Date.now() })
  })

  // An approval is a waterfall: returning an outcome settles the request, so holding it
  // is how a voice answer can decide. Holding one hides DSH's own card, so requests are
  // only held while the user is actually driving by voice; at other times the card shows
  // at once and this plugin stays out of the way.
  ctx.on('approval/request', (request, next) => {
    if (settings.approvals === 'off') return next()
    const sessionId = idOf(request?.agent?.session) || idOf(request?.agent)
    if (settings.approvals === 'auto') {
      const recent = (at) => at !== undefined && Date.now() - at < settings.voiceWindowMs
      if (!recent(state.lastVoiceAt) && !recent(state.voiceSessions.get(sessionId))) return next()
    }
    const entry = {
      id: randomUUID(),
      sessionId,
      tool: String(request?.toolName ?? 'approval'),
      reason: clip(String(request?.reason ?? ''), 300),
      at: Date.now(),
      state: 'open',
      answer: undefined,
    }
    state.approvals.set(entry.id, entry)
    return new Promise((resolve) => {
      let settled = false
      let timer
      const finish = (outcome) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        entry.answer = undefined
        entry.state = outcome === 'allowed-once' ? 'allowed' : outcome === 'rejected' ? 'rejected' : 'closed'
        resolve(outcome)
        void writeSnapshot()
      }
      entry.answer = (choice) => {
        entry.state = choice === 'allow' ? 'allowed' : 'rejected'
        finish(choice === 'allow' ? 'allowed-once' : 'rejected')
      }
      timer = setTimeout(() => {
        if (settled) return
        // Nobody answered by voice: let DSH's own card take over.
        entry.answer = undefined
        entry.state = 'handed-over'
        Promise.resolve()
          .then(() => next())
          .then((outcome) => {
            settled = true
            entry.state = 'closed'
            resolve(outcome)
          }, () => {
            settled = true
            entry.state = 'closed'
            resolve('cancelled')
          })
      }, settings.approvalGraceMs)
      timer.unref?.()
      request?.signal?.addEventListener?.('abort', () => finish('cancelled'), { once: true })
    })
  }, { prepend: true })

  // Questions are a waterfall too (the answerer is the Client's card). Holding one lets
  // a spoken answer settle it; the grace window hands it back to the card so nothing is
  // lost, and a question that still times out stays answerable late through the
  // `userQuestions` projection.
  ctx.on('user-questions/request', (request, next) => {
    if (settings.questions === 'off') return next()
    const agent = request?.agent
    const sessionId = idOf(agent?.session) || idOf(agent)
    if (settings.questions === 'auto' && !voiceRecent(sessionId)) return next()
    const callId = String(request?.wait?.callId ?? '')
    const questions = Array.isArray(request?.questions) ? request.questions : []
    if (questions.length === 0) return next()
    const entry = {
      id: randomUUID(),
      sessionId,
      callId,
      questions,
      at: Date.now(),
      state: 'open',
      answer: undefined,
    }
    state.questions.set(entry.id, entry)
    return new Promise((resolve, reject) => {
      let settled = false
      let timer
      const finish = (outcome, batch) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        entry.answer = undefined
        entry.state = outcome
        if (batch === undefined) reject(outcome)
        else resolve(batch)
        void writeSnapshot()
      }
      entry.answer = (batch) => finish('answered', { answers: batch })
      timer = setTimeout(() => {
        if (settled) return
        entry.answer = undefined
        entry.state = 'handed-over'
        Promise.resolve()
          .then(() => next())
          .then((answer) => {
            settled = true
            entry.state = 'closed'
            resolve(answer)
          }, (error) => {
            settled = true
            entry.state = 'closed'
            reject(error)
          })
      }, settings.approvalGraceMs)
      timer.unref?.()
      request?.signal?.addEventListener?.('abort', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        entry.answer = undefined
        entry.state = 'closed'
        reject(request.signal.reason ?? new Error('question aborted'))
      }, { once: true })
    })
  }, { prepend: true })

  ctx.effect(() => {
    // The snapshot keeps the Session list warm, so a voice question does not wait for
    // it, and `state.json` shows what the plugin can actually read.
    const snapshotTimer = setInterval(() => {
      void (async () => {
        try {
          if (Date.now() - state.sessionsAt > SNAPSHOT_MS * 2) await listSessions(true)
        } catch {
          /* the snapshot still gets written */
        }
        await writeSnapshot()
      })()
    }, SNAPSHOT_MS)
    snapshotTimer.unref?.()
    // The endpoint normally comes from the config. When the config leaves it out, read
    // it from $DSH_HOME/xiaozhi/endpoint instead, so the address (which carries the
    // access token) never has to sit in a YAML file people screenshot or share.
    if (settings.endpoint !== '') {
      state.endpointSource = 'config'
      connect()
    } else {
      void (async () => {
        await loadEndpointFile()
        if (state.disposed) return
        connect()
      })()
    }
    return () => {
      state.disposed = true
      clearInterval(snapshotTimer)
      if (state.retryTimer !== undefined) clearTimeout(state.retryTimer)
      try {
        state.socket?.close()
      } catch {
        /* already gone */
      }
    }
  }, 'dsh-xiaozhi: bridge')
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readSettings(config) {
  const endpoint = typeof config.endpoint === 'string' ? config.endpoint.trim() : ''
  return {
    endpoint,
    token: typeof config.token === 'string' ? config.token.trim() : '',
    allowControl: config.allowControl !== false,
    approvals: ['off', 'always', 'auto'].includes(config.approvals) ? config.approvals : 'auto',
    questions: ['off', 'always', 'auto'].includes(config.questions) ? config.questions : 'auto',
    approvalGraceMs: Number.isFinite(config.approvalGraceMs) ? Math.max(1000, Number(config.approvalGraceMs)) : 20_000,
    voiceWindowMs: Number.isFinite(config.voiceWindowMs) ? Math.max(60_000, Number(config.voiceWindowMs)) : 30 * 60_000,
    reconnectMinMs: Number.isFinite(config.reconnectMinMs) ? Number(config.reconnectMinMs) : 1000,
    reconnectMaxMs: Number.isFinite(config.reconnectMaxMs) ? Number(config.reconnectMaxMs) : 30_000,
  }
}

// The token travels in the query string, as the console hands the URL out; a token
// given separately is added here.
function withToken(endpoint, token) {
  if (token === '' || endpoint.includes('token=')) return endpoint
  return `${endpoint}${endpoint.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
}

function clampLimit(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.min(40, Math.max(1, Math.round(number)))
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('操作超时了')), ms)
    timer.unref?.()
    promise.then((value) => {
      clearTimeout(timer)
      resolve(value)
    }, (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function makeLogger(ctx) {
  let logger
  try {
    logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-xiaozhi') : undefined
  } catch {
    logger = undefined
  }
  const format = (args) => args.map((value) => (typeof value === 'string' ? value : String(value)))
  return {
    info: (...args) => (logger?.info !== undefined ? logger.info(format(args).join(' ')) : console.log('[xiaozhi]', ...args)),
    warn: (...args) => (logger?.warn !== undefined ? logger.warn(format(args).join(' ')) : console.warn('[xiaozhi]', ...args)),
  }
}
