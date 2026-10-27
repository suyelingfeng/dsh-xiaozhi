// The browser half of dsh-xiaozhi: a status bar across the bottom of the app and a
// panel it opens, both driven by the host half over one POST route.
//
// Hand-written rather than built: the module system takes a lazy CJS factory whose
// `require` resolves against the shell's shared module table (react, and the client
// services), so a small bundle needs no toolchain. Keep it that way — no JSX, no bundler.
//
// The route is written *relative* (`api/xiaozhi`, no leading slash) on purpose: the
// desktop shell serves the UI from file:// and carries same-origin API fetches over its
// IPC bridge, and the web shell serves it from the same origin. A leading slash would
// escape that bridge.
window.__ModuleLoader__.load({
  id: 'dsh-xiaozhi',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    const ROUTE = 'api/xiaozhi'
    const PANEL = 'xiaozhi'
    const POLL_MS = 3000

    // ── host calls ───────────────────────────────────────────────────────────

    async function host(action, rest) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...(rest ?? {}) }),
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (!payload || payload.ok !== true) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
      return payload.value
    }

    // ── styles (theme-agnostic: inherit colours, fall back when a token is absent) ──

    const dot = (on) => ({
      display: 'inline-block',
      width: 8,
      height: 8,
      borderRadius: 4,
      marginRight: 6,
      background: on ? 'var(--dsw-green, #2ea043)' : 'var(--dsw-danger, #d1242f)',
    })
    const button = {
      padding: '2px 10px',
      marginLeft: 6,
      borderRadius: 6,
      border: '1px solid var(--dsw-border, rgba(128,128,128,.45))',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      cursor: 'pointer',
    }
    const row = { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }
    const muted = { opacity: 0.65 }
    const mono = { fontFamily: 'var(--dsh-font-family-code, ui-monospace, monospace)', fontSize: 12 }
    const card = {
      border: '1px solid var(--dsw-border, rgba(128,128,128,.3))',
      borderRadius: 10,
      padding: '10px 12px',
      margin: '10px 0',
    }
    const input = {
      flex: 1,
      minWidth: 160,
      padding: '3px 8px',
      borderRadius: 6,
      border: '1px solid var(--dsw-border, rgba(128,128,128,.45))',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
    }

    // ── data ─────────────────────────────────────────────────────────────────

    function useBridge() {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const load = React.useCallback(() => {
        host('state')
          .then((next) => {
            setData(next)
            setError('')
          })
          .catch((failure) => setError(String(failure?.message ?? failure)))
      }, [])
      React.useEffect(() => {
        load()
        const timer = setInterval(load, POLL_MS)
        return () => clearInterval(timer)
      }, [load])
      const run = React.useCallback(async (action, rest) => {
        setBusy(true)
        try {
          await host(action, rest)
          setError('')
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy(false)
          load()
        }
      }, [load])
      return { data, error, busy, load, run }
    }

    const waiting = (data) => (data?.approvals?.length ?? 0) + (data?.questions?.length ?? 0)

    // ── the bottom bar: always visible, opens the panel ──────────────────────

    function makeBar(ctx) {
      return function BridgeBar() {
        const { data, error } = useBridge()
        const count = waiting(data)
        const open = () => {
          const layout = ctx.get?.('layout')
          if (layout?.selectPanel !== undefined) layout.selectPanel(PANEL)
        }
        return h(
          'div',
          {
            onClick: open,
            title: error === '' ? '小智语音桥接：点击查看详情' : `小智语音桥接：${error}`,
            style: {
              ...row,
              height: 26,
              padding: '0 12px',
              fontSize: 12,
              cursor: 'pointer',
              borderTop: '1px solid var(--dsw-border, rgba(128,128,128,.25))',
              color: error === '' ? 'inherit' : 'var(--dsw-danger, #d1242f)',
            },
          },
          h('span', { style: dot(data?.connected === true) }),
          h('span', null, '小智桥接'),
          data === null ? null : h('span', { style: muted }, ` · ${data.connected ? '已连接' : '未连接'} · ${data.calls} 次调用`),
          count > 0 ? h('span', { style: { marginLeft: 8, fontWeight: 600 } }, `${count} 待处理`) : null,
          error === '' ? null : h('span', { style: { marginLeft: 8 } }, error),
        )
      }
    }

    // ── the panel: status, pending work, and the buttons ─────────────────────

    function makePanel(ctx) {
      return function BridgePanel() {
        const { data, error, busy, load, run } = useBridge()

        const close = () => {
          const layout = ctx.get?.('layout')
          if (layout?.selectPanel !== undefined) layout.selectPanel(null)
        }

        return h(
          'div',
          { style: { padding: '20px 24px', maxWidth: 780, margin: '0 auto', overflowY: 'auto' } },
          h('div', { style: { ...row, justifyContent: 'space-between' } },
            h('h2', { style: { margin: 0, fontSize: 18 } }, '小智语音桥接'),
            h('div', null,
              h('button', { style: button, onClick: load, disabled: busy }, '刷新'),
              h('button', { style: button, onClick: () => run('reconnect'), disabled: busy }, '重新连接'),
              h('button', { style: button, onClick: close }, '关闭'),
            ),
          ),
          h('p', { style: { ...muted, fontSize: 12, margin: '6px 0 0' } },
            '这一页读取宿主里的桥接状态；改配置请编辑 cordis.patch.yml 或 ~/.dsh/xiaozhi/endpoint，然后重启 DSH。'),

          error === '' ? null : h('div', { style: { ...card, color: 'var(--dsw-danger, #d1242f)' } }, error),

          data === null
            ? h('p', { style: muted }, '读取中…')
            : h('div', { style: card },
                h('div', { style: row },
                  h('span', { style: dot(data.connected) }),
                  h('strong', null, data.connected ? '已连接' : '未连接'),
                  h('span', { style: muted }, ` · 协议 ${data.protocol || '—'} · 来源 ${data.endpointSource || '—'} · 重连 ${data.reconnects} 次 · 工具调用 ${data.calls} 次`),
                ),
                data.lastError === '' ? null : h('div', { style: { ...mono, marginTop: 6, color: 'var(--dsw-danger, #d1242f)' } }, data.lastError),
                h('div', { style: { ...muted, ...mono, marginTop: 6 } }, `插件 ${data.version} · 进程 ${data.pid} · 会话 ${data.sessions} 个`),
              ),

          h('h3', { style: { fontSize: 15, margin: '18px 0 4px' } }, `等你批准（${data?.approvals?.length ?? 0}）`),
          (data?.approvals?.length ?? 0) === 0
            ? h('p', { style: muted }, '没有待批的请求。')
            : data.approvals.map((entry) =>
                h('div', { key: entry.id, style: card },
                  h('div', { style: row },
                    h('code', { style: mono }, entry.id),
                    h('strong', null, entry.tool),
                    h('span', { style: muted }, ` · 会话 ${String(entry.session ?? '').slice(0, 20)}`),
                    h('button', { style: button, disabled: busy, onClick: () => run('allow', { id: entry.id }) }, '允许'),
                    h('button', { style: button, disabled: busy, onClick: () => run('reject', { id: entry.id }) }, '拒绝'),
                  ),
                  entry.reason === '' ? null : h('div', { style: { ...mono, marginTop: 6, opacity: 0.8 } }, entry.reason),
                ),
              ),

          h('h3', { style: { fontSize: 15, margin: '18px 0 4px' } }, `等你回答（${data?.questions?.length ?? 0}）`),
          (data?.questions?.length ?? 0) === 0
            ? h('p', { style: muted }, '没有待答的问题。')
            : data.questions.map((entry) =>
                h(QuestionCard, { key: entry.id, entry, busy, run }),
              ),
        )
      }
    }

    function QuestionCard({ entry, busy, run }) {
      const [answer, setAnswer] = React.useState('')
      const submit = () => {
        if (answer.trim() === '') return
        run('answer', { id: entry.id, text: answer.trim() })
        setAnswer('')
      }
      return h('div', { style: card },
        h('div', { style: row },
          h('code', { style: mono }, entry.id),
          h('span', { style: muted }, entry.asks.length > 1 ? `${entry.asks.length} 个问题` : ''),
        ),
        entry.asks.map((ask) =>
          h('div', { key: ask.id, style: { marginTop: 6 } },
            h('div', null, ask.question),
            ask.options.length === 0
              ? null
              : h('div', { style: { ...muted, ...mono } }, ask.options.map((label, index) => `${index + 1}) ${label}`).join('   ')),
          ),
        ),
        h('div', { style: { ...row, marginTop: 8 } },
          h('input', {
            style: input,
            value: answer,
            placeholder: entry.asks[0]?.options?.length > 0 ? '选项名、序号（如 第二个），或者你自己的话' : '直接说答案',
            onChange: (event) => setAnswer(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') submit() },
          }),
          h('button', { style: button, disabled: busy, onClick: submit }, '回答'),
        ),
      )
    }

    // ── plugin body ──────────────────────────────────────────────────────────

    const inject = ['slots']

    function apply(ctx) {
      // A slim bar across the bottom: the only always-visible seat, and the way in.
      ctx.slots.inject('shell.bottom', () =>
        ctx.slots.register({ name: 'shell.bottom', key: 'xiaozhi-bridge' }, makeBar(ctx)),
      )
      // The panel itself lives in the root `main` slot, selected on demand.
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL, title: '小智桥接' }, makePanel(ctx)),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
