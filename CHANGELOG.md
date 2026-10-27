# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的写法，
版本号按 [SemVer](https://semver.org/lang/zh-CN/) 走：插件版本随 DSH 内部的接口变化而跳。

## [0.2.1] - 2026-10-27

### 新增

- **地址可以放在配置文件之外**：`endpoint` 为空时，插件读 `~/.dsh/xiaozhi/endpoint`
  （一行一条，`#` 开头是注释）。这样接入点 token 不必躺在 `cordis.patch.yml` 里——
  那份文件最容易被截图、贴进 issue 或被误提交。配置里配了 `endpoint` 就以配置为准。
- `state.json` 新增 `endpointSource`（`config` / `file` / `none`），用来说明地址来自哪里；
  快照里**从不回显地址本身**。

### 变更

- 仓库、文档与测试脚本里不再出现任何真实 token 或它的片段：
  `cordis.patch.yml` 的 `endpoint` 留空，`test/live.mjs` 改为从 `XIAOZHI_ENDPOINT`
  环境变量或 profile 补丁读取。
- 离线测试增至 46 项（新增「地址从本地文件回退」一项）。

## [0.2.0] - 2026-10-27

### 新增

- **提问代答（前台）**：接管 `user-questions/request` 水位事件。默认应答者是 GUI 的答题卡，
  插件用 `prepend` 抢在前面压住请求，把答案作为整批 `{ answers }` 返回。
- **提问代答（超时补答）**：读会话的 `userQuestions` 投影，把 `state: continued` 的问题
  列进 `dsh_pending`，用 `userQuestions.answer(agent, callId, { answers })` 补答。
- `dsh_pending` 现在带选项与序号，念出来就能答；
- `dsh_answer` 支持「选项名 / 序号（`第二个`、`选2`）/ 自定义回答」，多问批次支持 `answers` 数组；
- 中文数字序号（一～十）与口语前缀（`就`、`选`、`按`）解析。

### 变更

- `allowControl` 的语义扩到新工具：关闭时审批、提问、后台作业、新会话一律拒绝；
- `cordis.patch.yml` 的 `endpoint` 改为留空，真实 token 移到 profile 补丁层，
  仓库里不再出现凭据；新增 `cordis.local.example.yml` 作为模板。

### 已知限制

- 提问的前台接管依赖「宿主侧监听排在客户端应答者之前」。若某版本里客户端先接走，
  前台接管不会触发，功能退化为「只有超时补答」，不会出错。
- 非 timed 的提问没有 `wait.callId`，无法从投影里关联，只能走前台接管那条路。

## [0.1.0] - 2026-10-27

### 新增

- 首个可用版本：主动连出小智 MCP 接入点（`wss://api.xiaozhi.me/mcp/?token=…`），
  作为 **MCP 服务端**提供 `initialize` / `tools/list` / `tools/call` / `ping`，
  断线按指数退避重连。
- 读：`dsh_status`、`dsh_list_chats`、`dsh_read_conversation`、`dsh_diagnostics`；
- 控：`dsh_send_message`、`dsh_stop`、`dsh_new_chat`（在指定 `cwd` 新开会话并派活）；
- **审批接管**：`approval/request` 水位事件，`prepend` 后压住请求，`allow`/`reject` 语音放行，
  超时把请求交回 DSH 自己的审批卡片；
- 后台作业：`dsh_jobs`、`dsh_job_kill`（`ctx.jobs.list()` / `kill(id, owner, reason)`）；
- `auto` 策略：只有最近 30 分钟内用语音驱动过 DSH 才接管，坐在电脑前的人不受影响；
- `~/.dsh/xiaozhi/state.json` 状态快照（每 10 秒），含连接、协议、会话列表、待批/待答项；
- 离线自测 `test/harness.mjs` 与接入点联调脚本 `test/live.mjs`。

### 修复

- 会话列表读不到的问题：这版 DSH 的 `sessionController.list()` 只收 `signal` 一个参数，
  按老签名 `list({}, signal)` 调会把 `{}` 当 signal 从而返回空数组。现在先试新签名，
  遇到 `TypeError` 再退回老签名，并把失败原因写进快照的 `listError`。
