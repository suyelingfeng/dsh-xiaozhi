# 安全与隐私

## 这个仓库里没有你的接入点地址

小智的 MCP 接入点 URL 里带一个签名的 JWT。它等于「能以你的身份连这个 agent」，
所以它被刻意挡在仓库之外：

- `cordis.patch.yml` 的 `endpoint` 留空；
- 真实地址放 `~/.dsh/xiaozhi/endpoint`，或你自己的 profile 补丁层——两者都不在本仓库；
- `test/live.mjs` 从 `XIAOZHI_ENDPOINT` 环境变量或本机配置读地址，源码里没有硬编码；
- 状态快照 `~/.dsh/xiaozhi/state.json` 只写 `endpointSource`（`config` / `file` / `none`），
  **从不回显地址本身**，也不写进错误信息。

提交前可以自查一遍：

```sh
grep -rn -E "eyJ[A-Za-z0-9_-]{10,}|token=[A-Za-z0-9]" --exclude-dir=.git .
```

## 报告问题

请用 GitHub 仓库的 **Security → Report a vulnerability**（私密 advisory），不要开公开 issue。

如果你不小心把 token 贴进了 issue 或提交，先做一件事：**到小智控制台重新生成接入点**，
旧的那条就作废了；然后
`printf '%s\n' '<新地址>' > ~/.dsh/xiaozhi/endpoint` 并重启 DSH。

## 这个插件本身的权限面

- 唯一的出站连接就是你配置的那条 `wss://`；不监听端口、不起网络服务；
- `allowControl: false` 是总闸：关掉后所有写操作（发消息、停止、批审批/答问、开新会话、杀作业）都会被拒绝；
- 刻意不提供「改权限预设」和「直接跑 shell」的工具——语音误识别一次就可能是事故；
- 审批与提问只在你**最近用过语音**的时间窗内接管，其余时间原样交回 DSH 自己的卡片。
