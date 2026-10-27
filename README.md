# dsh-xiaozhi

把 **DeepSeek Harness（DSH）** 接到 **小智** 的 MCP 接入点（`wss://api.xiaozhi.me/mcp/?token=…`），
让语音能看见 DSH 在做什么、派活、停任务、批审批、回答问题、停后台作业。

> 一个 DSH 插件。跑在 DSH 主进程里，直接调用 DSH 自己的会话控制器与审批/提问水位事件——
> 不是另一个 harness，也不需要抓 DSH 的 HTTP 令牌。

## 它在链路里的位置

```
小智设备（ESP32 固件）── WebSocket / MQTT+UDP ──▶ 小智云（智能体 + LLM）
                                                    │
                                        MCP 接入点（wss + token）
                                                    │  ◀── 本插件作为 MCP 服务端连出去
                                                    ▼
                                          DeepSeek Harness（本机）
```

设备只和云说话，**不直连 DSH**。所以换设备、换固件都不影响本插件，只要那条接入点的 token 还在；
固件侧也不需要为本插件改任何东西——它要的只是 Wi-Fi 配网，以及（自建服务端时）OTA / WebSocket 地址。

## 相关项目

| 项目 | 关系 |
|---|---|
| [progyuan/xiaozhi-esp32-ai-robot](https://github.com/progyuan/xiaozhi-esp32-ai-robot) | 设备端固件（小智 AI 机器人），MIT 许可；`78/xiaozhi-esp32` 的 fork |
| [78/xiaozhi-esp32](https://github.com/78/xiaozhi-esp32) | 上游固件项目，MIT（Copyright © 2024 Xiaoxia） |
| [xiaozhi.me](https://xiaozhi.me/) | 小智云、控制台与 MCP 接入点 |

本仓库只做云端之后的这一半（MCP 服务端 → DSH）。固件的功能、编译与烧录请走上面两个仓库的文档。

## 快速开始

```sh
# 1. 装进 profile 并让 bundle 生效（细节见 docs/接入手册.md）
#    ~/.dsh/profiles/desktop/package.json:
#      dependencies: { "dsh-xiaozhi": "link:D:/path/to/dsh-xiaozhi" }
#      dsh.profile.bundles: […, "dsh-xiaozhi"]

# 2. 把接入点地址放到仓库之外（地址里带着 token，别提交进来）
#    ~/.dsh/xiaozhi/endpoint   ← 一行一条；或写进 profile 的 cordis.patch.yml

# 3. 重启 DSH，然后看
#    ~/.dsh/xiaozhi/state.json   → "connected": true
```

改完 `index.js` 或配置都要**重启 DSH**（插件不热重载）。

## 它给小智的工具（14 个）

| 工具 | 作用 |
|---|---|
| `dsh_status` | 在跑吗、跑哪个会话、最近一条回复、今日用量 |
| `dsh_list_chats` | 最近的会话（标题 / 文件夹 + 最后活动） |
| `dsh_read_conversation` | 读某会话最近的对话（你、DSH、工具调用） |
| `dsh_send_message` | 把一句话发给 DSH，让它干活 |
| `dsh_stop` | 停掉正在跑的轮次 |
| `dsh_pending` | 谁在等你：待批请求 + 等你答的问题（带选项） |
| `dsh_answer` | 放行/拒绝审批，或回答问题 |
| `dsh_jobs` | 正在跑的后台作业 |
| `dsh_job_kill` | 停掉一个后台作业 |
| `dsh_new_chat` | 在指定文件夹开新会话并派活 |
| `dsh_ui_open_session` | 把界面切到某个会话 |
| `dsh_ui_panel` | 回到对话 / 打开桥接面板 |
| `dsh_ui_sidebar` | 展开或收起左侧栏 |
| `dsh_diagnostics` | 排障用的原始信息 |

## 三种「它在等你」

DSH 里三件事都会挂起轮次等你，插件分别接管，并且都能在 20 秒没答时**原样交回 DSH 的界面**：

1. **审批**（`approval/request`）——执行命令、写文件、联网前；
2. **提问·前台**（`user-questions/request`）——`ask_user_question` 正在等你选；
3. **提问·超时补答**（`userQuestions` 投影里 `state: continued` 的那些）——过期了也能一句话补上。

默认 `approvals: auto` / `questions: auto`：只有**最近 30 分钟内用语音驱动过 DSH** 时才让语音先接，
否则完全不打扰 DSH 自己的卡片。坐在电脑前的人感觉不到插件存在。

## 界面里的控制面板

插件带一个浏览器侧的一半（`client.js`，手写、无需构建）：

- **底栏**：横向一条 26px 的细条，写着「● 小智桥接 · 已连接 · N 次调用」，有待处理时标出数量；
  点它打开面板。
- **面板**：连接状态（协议 / 来源 / 重连次数 / 最后错误）、等你批准的请求（允许 / 拒绝按钮）、
  等你回答的问题（选项 + 输入框），以及「刷新 / 重新连接 / 关闭」。

它走宿主的 `/api/xiaozhi` POST 路由，和 GUI 自己的 API 同一条通道（cookie 认证 + 桌面端的
IPC 桥接），不额外开端口、不额外认证。

**这条通道也用来反向控制界面**：`dsh_ui_*` 工具把命令放进同一个状态轮询（2 秒一次），
浏览器执行完再 ack；工具因此能回答「真的切过去了」还是「界面没响应」。至于「这个 shell 拒绝
执行」，也会带着原因回报，不会假装成功。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/接入手册.md](docs/接入手册.md) | 从零接入：小智侧、安装、配置全表、验证、排障、安全、卸载 |
| [docs/协议笔记.md](docs/协议笔记.md) | 实测抓到的接入点协议：方向、握手帧、`tools/call`、连接行为 |
| [docs/宿主API笔记.md](docs/宿主API笔记.md) | 用到的 DSH 内部接口：`sessionController`、两个水位事件、`userQuestions` 投影、`jobs` |

## 配置摘要

```yaml
- id: xiaozhi
  name: dsh-xiaozhi
  config:
    endpoint: ""              # 留空 = 读 ~/.dsh/xiaozhi/endpoint（一行一条）；也可直接填地址
    allowControl: true        # false = 只读
    approvals: auto           # auto | always | off
    questions: auto           # auto | always | off（off 仍有超时补答）
    approvalGraceMs: 20000    # 等语音回答多久，超时就交回卡片
    voiceWindowMs: 1800000    # 语音「算数」的时间窗
```

地址（就是 token）不进仓库、也不建议留在 YAML 里：写进 `~/.dsh/xiaozhi/endpoint`，
`state.json` 只用 `endpointSource` 说明它从哪来，不回显内容。
完整说明见 [接入手册 §3](docs/接入手册.md)。

## 开发

```sh
node test/harness.mjs    # 离线自测：假 WebSocket + 假 ctx，45 项断言，不联网
node test/live.mjs       # 联调：连真实接入点打印每一帧，46 秒后自己退出（会占用唯一连接）
```

- `test/harness.mjs` 把 `globalThis.WebSocket` 换成假的、用假 `ctx` 演 DSH，
  覆盖 MCP 方法、11 个工具、审批/提问的接管与交还。
- 想只测协议不看 DSH：`test/live.mjs` 跑完记得让它退出，否则它占着接入点。

## 边界

- **不给语音「改权限预设」和「直接跑 shell」的能力**——误识别一次就是事故；
- `allowControl: false` 是唯一总闸，关掉后所有写操作都会拒绝；
- 接入点 token 等于身份，别提交进仓库（本仓库刻意把 `cordis.patch.yml` 的 `endpoint` 留空，
  地址只住在 `~/.dsh/xiaozhi/endpoint`）。细节见 [SECURITY.md](SECURITY.md)。

## License

[Apache-2.0](LICENSE)。
