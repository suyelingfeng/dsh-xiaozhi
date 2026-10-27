// Live check against a real XiaoZhi MCP endpoint: the real broker plays the MCP
// client, a fake ctx plays the DSH host. Proves the handshake and tools/list work
// against the actual service, without starting DSH or touching a Session.
//
// The access point carries a token, so it is never hardcoded here:
//   1. XIAOZHI_ENDPOINT=wss://… npm test:live
//   2. otherwise the endpoint configured for this machine's desktop profile is used
//      (~/.dsh/profiles/desktop/cordis.patch.yml, added by docs/接入手册.md §3)
//
// The endpoint allows one connection at a time: while this runs, the real plugin
// gets pushed off and will reconnect afterwards.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
process.env.DSH_HOME = join(here, '..', '.test-home')

function endpointFromProfile() {
  const candidates = [
    join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'),
    join(homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml'),
  ]
  for (const file of candidates) {
    try {
      const hit = readFileSync(file, 'utf8').match(/endpoint:\s*\n?\s*"?((?:wss|ws):\/\/[^"\s]+)"?/)
      if (hit !== null) return hit[1]
    } catch {
      /* the next candidate */
    }
  }
  return ''
}

const endpoint = (process.env.XIAOZHI_ENDPOINT ?? '').trim() || endpointFromProfile()
if (endpoint === '') {
  console.error('No endpoint. Pass XIAOZHI_ENDPOINT="wss://…/mcp/?token=…" or configure the profile patch.')
  process.exit(2)
}

const RealSocket = globalThis.WebSocket
class LoggingSocket extends RealSocket {
  constructor(url) {
    super(url)
    console.log('socket opened', url.slice(0, 58) + '…')
    this.addEventListener('message', (event) => console.log('<-', String(event.data).slice(0, 400)))
    this.addEventListener('close', (event) => console.log('socket closed', event.code, event.reason ?? ''))
  }
  send(data) {
    console.log('->', String(data).slice(0, 400))
    return super.send(data)
  }
}
globalThis.WebSocket = LoggingSocket

const ctx = {
  logger: () => ({ info: (...a) => console.log('[info]', ...a), warn: (...a) => console.log('[warn]', ...a) }),
  on() {},
  effect(fn) { fn() },
  sessionController: {
    async list() { return { items: [{ sessionId: 'session-fake', updatedAt: Date.now(), running: false, blank: false, cwd: 'D:/work/fake', projections: { values: { title: '冒烟测试' } } }] } },
    async create() { return { sessionId: 'session-new' } },
    async resolveAgent(id) { return { agent: { id, status: 'idle', session: { seq: 3 }, cancel() {} } } },
    async page() { return { records: [{ event: { type: 'user/message', data: { content: [{ type: 'text', text: '你好' }] } } }] } },
    async prompt() {},
  },
}

const plugin = await import('../index.js')
plugin.apply(ctx, { endpoint, allowControl: true })

setTimeout(() => {
  console.log('done')
  process.exit(0)
}, 46_000)
