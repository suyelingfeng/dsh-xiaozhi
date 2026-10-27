# 宿主 API 笔记：这个插件用到的 DSH 内部接口

本插件跑在 DSH 主进程里，靠的是 `ctx` 上的一批服务与水位事件。DSH 这些接口没有对外
承诺，是会随版本变的内部契约——所以这份笔记同时是「我用到了什么」和「以后坏了先看哪」。

版本基准：DSH desktop `0.2.1-rc.3`（随包 `@deepseek-ai/*` 同名包）。

---

## 1. 服务：`ctx.sessionController`（`inject: ['sessionController']`）

| 方法 | 签名 | 说明 |
|---|---|---|
| `list` | `list(signal) → Array<summary>` | 列出可见会话。**注意：只收 signal 一个参数**；老写法 `list({}, signal)` 会把 `{}` 当 signal，返回空数组 |
| `page` | `page({ address: {kind:'session', sessionId}, throughSeq, beforeSeq, maxMessages }, signal) → { records: [{event}], hasMore }` | 读历史。`throughSeq` 一般是 `session.seq - 1` |
| `resolveAgent` | `resolveAgent(sessionId) → { agent } \| { error }` | 拿到活的 agent。返回的是**联合类型**，要判 `'error' in resolved` |
| `create` | `create({ workspaceId } \| { cwd }) → { sessionId }` | 两个都传会报错；只给 `cwd` 就会在该目录下新建 |
| `prompt` | `prompt({ requestId, sessionId, mode:'queue', content:[{type:'text',text}] }, signal)` | 往会话里塞一条用户消息。`mode:'queue'` = 排到下一轮 |
| `selectModel` | `selectModel({ sessionId, provider, model })` | 换模型（本插件暂时没接） |

`list()` 每条 summary 的字段（实测）：

```jsonc
{
  "sessionId": "session-…",
  "updatedAt": 1793107897600,
  "agentAvailable": true,
  "formatStatus": "current",
  "running": false,              // ← 比自己追 agent/status 更可靠
  "blank": false,                // ← 空会话，列列表时可以跳过
  "cwd": "D:\\MCPzhi",
  "projections": { "values": { "title": "接入小智 MCP 并控制 DeepSeek harness" } }
}
```

**标题不在顶层**，在 `projections.values.title` 里；没有标题时退回 `cwd` 的末级目录名，
再退回会话 id 前 24 位。

`agent` 上我们用到：`agent.session.seq`、`agent.status`（`'idle'` / `'running'`）、
`agent.cancel({ kind: 'user' })`（打断当前轮）、`agent.session.id`。

---

## 2. 水位事件：`approval/request`

```js
ctx.on('approval/request', (request, next) => {
  // request: { agent, toolName, reason, callId, signal }
  // 返回 'allowed-once' | 'rejected' | 'cancelled'（也可以把 next() 的结果原样返回）
}, { prepend: true })
```

- **谁先答谁算数**：一个请求只有一个结果。我们接管了，DSH 自己的审批卡片就不会出现；
  我们不管，卡片立刻弹出。所以接管一定要有「交还」路径。
- `prepend: true` 让我们排在默认应答者前面（ds-bot 也是这么插的，可信）。
- 交还的方式不是「返回 next()」，而是**延迟调用** `next()`：先压住，超时后再
  `next()`，让默认应答者（审批卡片）接手。
- `request.signal` 在轮次被取消时中止，要处理，否则请求永远悬着。

---

## 3. 水位事件：`user-questions/request` + `userQuestions` 投影

提问有两段生命周期，两条路都要接：

### 3.1 前台：水位事件

```js
ctx.on('user-questions/request', (request, next) => {
  // request: { questions: [{ id, question, header?, options?: [{label, description?}], multiSelect? }],
  //            agent, signal, wait?: { callId, timed } }
  // 返回 { answers: [{ id, selected: [label], custom? }] }
}, { prepend: true })
```

- 默认应答者是**客户端**（`dsh-client-ui-user-questions` 里 `ctx.remote.$on('user-questions/request', …)`），
  我们靠 `prepend` 抢在它前面。
- 返回值必须是**整批**答案：每个问题一次，`selected` 装的是**选项 label**，不是索引。
- `wait.callId` 只在 timed 变体里存在；非 timed 没有，所以关联不到投影。

### 3.2 超时后：服务 + 投影

问题超时后会留在会话投影里：

```js
const view = ctx.get('sessionProjections').stateOf(agent.session, 'userQuestions')
// view.questions.active = [{ callId, state: 'open' | 'continued', questions: [...] }]
// view.questions.settled = [...]
```

`state: 'continued'` 的才是「还能补答」的。补答：

```js
ctx.get('userQuestions').answer(agent, callId, { answers: [{ id, selected: [], custom: '…' }] })
```

约束（都来自 `UserQuestionService.answer` 的实现）：

- `agent` 必须是**当前活的根 agent**，否则 `CALLER_NOT_LIVE` / `DELEGATED_CALLER`；
- 批次要**恰好覆盖**这个 call 的每个问题，多一个少一个都是 `BAD_ANSWER`；
- 已经有回答在排队 → `REPLY_QUEUED`；
- 返回 `false` 表示这条问题已经不在等了；
- 成功时答案会作为 `source.kind === 'user-question-reply'` 的用户消息被**steer** 进 agent，
  这就是问题被接上的机制。

`ask_user_question` 默认只等 120 秒（`timeout` 参数），所以「超时后补答」在实际使用里
不是边角料，是主路径之一。

---

## 4. 服务：`ctx.get('jobs')`

| 方法 | 说明 |
|---|---|
| `list()` | 返回作业数组；每项 `{ id, label, status, owner }`，`status` 有 `running` / `stopping` / 完成态 |
| `kill(id, owner, reason)` | `owner` 是会话 id，必须原样从小项里拿 |

只列 `running` / `stopping`，其余是历史。

---

## 5. 事件：`session/event` 与 `agent/status`

```js
ctx.on('session/event', (session, event) => { … })   // session.id，event.type / event.data / event.time
ctx.on('agent/status', ({ agent, status }) => { … })  // status: 'idle' | 'running'
```

我们关心的 `event.type`：

| type | 取什么 |
|---|---|
| `user/message` | `data.content`（块数组，取 `type === 'text'` 的 `text`） |
| `assistant/message` | `data.message.content`（同上） |
| `tool/call` | `data.name` |
| `turn/start` / `turn/end` | `data.turn`；`turn/end` 用来把会话标成 idle |

这套事件是「正在发生」的流；历史用 `page()` 读，两者字段一致。

---

## 6. 插件形态

```js
export const name = 'dsh-xiaozhi'
export const inject = ['sessionController']   // 只声明真正用到的服务，缺一个就不加载
export function apply(ctx, config) { … }
```

- `ctx.on` / `ctx.effect` 都挂在插件的 fiber 上，卸载时自动清掉；`ctx.effect(() => dispose)` 里
  放 socket、定时器。
- `ctx.get(name)` 取可选服务（`jobs`、`userQuestions`、`sessionProjections`），取不到就优雅降级，
  别写进 `inject`——写进去等于「没有它我就不加载」。
- `cordis.patch.yml` 的 `insert` 条目可以是 `{ id, name, config }`；profile 层的同名条目
  会**整条替换** config，所以覆盖时要写全。
