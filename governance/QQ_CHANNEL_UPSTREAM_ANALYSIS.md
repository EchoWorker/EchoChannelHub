# QQ Channel 上游改造分析

> 上游：`tencent-connect/openclaw-qqbot`  
> 审计提交：`a4479eea5931afdd3d504ac3b1c0860025c4d171`（2026-08-28）  
> 上游版本：`2.0.3`  
> 目标：将 QQ 官方机器人能力接入 EchoChannelHub，而不是移植 OpenClaw 插件框架。

## 结论

采用“**腾讯 QQ SDK + 经过筛选的上游业务模块 + 自研 Echo Channel 外壳**”是最合适路线，但不能直接 fork 后改几个 import。上游的 QQ 协议能力主要来自 `@tencent-connect/qqbot-nodejs`；仓库自身大量代码绑定 OpenClaw Plugin SDK，而且当前测试、构建和部分出站逻辑存在已确认缺陷。建议创建 `channels/qqbot`，保留上游 MIT 代码中确有价值的模块和版权声明，重写 setup、账户存储、EchoAI bridge、运行生命周期及关键可靠性策略。

## 1. 上游真实能力边界

上游不是手写 QQ 协议栈，而是以 `@tencent-connect/qqbot-nodejs@1.0.4` 为核心：

- 官方 access token、Gateway WebSocket/Webhook、心跳、重连、Resume、REST API 和媒体上传由 SDK 实现。
- `src/gateway/qqbot-gateway.ts` 为每个账号创建 `QQBot`，增加 session 文件持久化、中间件、引用索引、发送超时及 send-only 模式。
- `src/middleware/*` 实现访问控制、群 @、消息合并、附件下载和 STT 等平台策略。
- `src/dispatch/*` 将 SDK 入站对象转换为 OpenClaw 上下文并调用 OpenClaw runtime。
- `src/outbound/*` 提供目标解析、文本/媒体投递、C2C 流式、回复次数管理和本地文件保护。
- `src/setup/*` 使用 `@tencent-connect/qqbot-connector` 完成二维码绑定并写入 OpenClaw 配置。

因此，我们真正要保留的是腾讯 SDK 的官方协议实现和少数平台语义模块，而不是 OpenClaw runtime adapter。

## 2. 功能矩阵与首版取舍

| 能力 | 上游现状 | QQ Channel v0.1 建议 |
|---|---|---|
| AppID/AppSecret | 手输与扫码绑定 | 支持手输；扫码受 connector 许可门禁 |
| 多账号 | 账号级 WSS/token/data/log | 必须支持，每 profile 一个进程与账号目录 |
| C2C 文本 | 支持静态和官方流式 | 首版静态；流式后续 |
| 群聊 | @/always、历史、策略 | 首版仅 @ 触发，避免机器人刷屏 |
| QQ 频道 | 文档声称支持，但 target parser 有缺陷 | 首版不声明 |
| 图片 | 收发 | 首版支持，带大小/路径/SSRF约束 |
| 语音/视频/文件 | 收发、转码、分片 | 后续；首版不声明能力 |
| 引用回复 | ref index 持久化 | 首版保留被动回复 msg_id；复杂引用后续 |
| WebSocket Resume | SDK session 持久化 | 首版必须支持并做重启测试 |
| Webhook | 宿主 route adapter | 首版不做；桌面 Channel 用 WSS 即可 |
| 主动消息 | 已知用户存储与发送 | 首版仅 EchoAI `plugin.message`，受 QQ 主动消息策略约束 |
| Inline Keyboard/审批 | 支持 | 后续，不能照搬 OpenClaw 审批体系 |
| 定时提醒 | 上游内存 scheduler 有未接线代码 | 不迁移；使用 EchoAI Cron |
| STT/TTS | 依赖 OpenClaw runtime | 不迁移；交给 EchoAI 媒体能力 |
| 内置命令 | 大量 OpenClaw 专属命令 | 仅保留 `/bot-ping` 等必要诊断，其他不迁移 |

## 3. 可复用边界

### 3.1 直接依赖

- `@tencent-connect/qqbot-nodejs@1.0.4`：MIT，提供官方 QQ Bot 核心能力。首版应精确锁定版本，不使用 caret；升级必须重新跑协议与真实账号回归。
- `ws` 由 SDK 间接使用，无需 Channel 自己再实现 Gateway 帧协议。

### 3.2 可移植或按小接口重构

| 上游模块 | 处理方式 | 原因 |
|---|---|---|
| `src/outbound/target.ts` | 轻改迁移 | 纯目标解析；删除未实现的 `channel` scope，非法输入 fail-loud |
| `src/outbound/local-file-router.ts` | 轻改迁移 | Windows/UNC/realpath/allowed-root 逻辑有价值 |
| `src/outbound/sanitize.ts` | 迁移并补测试 | 可过滤内部 reminder/thinking，避免泄露到 QQ |
| `src/outbound/streaming-controller.ts` | 后续迁移 | 状态机可通过 `{openStream}` 接口解耦；首版不需要 |
| `src/features/ref-index-store.ts` | 后续重构 | JSONL+compact 思路可用，但需修复 flush/writeChain 竞态 |
| `src/middleware/attachment.ts` | 拆分后迁移 | 下载/转换/STT 应全部注入；首版只保留图片路径 |
| `src/outbound/deliver-pipeline.ts` | 重写接口后参考 | 投递顺序可借鉴，不能依赖 OpenClaw payload/runtime |
| `src/gateway/qqbot-gateway.ts` | 参考重写 | SDK 构造和 session persistence 可保留，去掉 OpenClaw runtime、中间件和全局 registry |

### 3.3 必须重写

- `index.ts`、`src/channel.ts`、`src/runtime.ts`、`src/adapter/*`：全部属于 OpenClaw 插件 API。
- `src/config.ts`：改为 Echo Channel profile JSON；禁止把 AppSecret写入 catalog、日志或 stdout。
- `src/setup/*`：实现 EchoWork setup v2 JSONL、loopback 引导页、add/restore、稳定 profileId 和取消语义。
- `src/dispatch/*`：改为 EchoAI WebSocket JSON-RPC `auth → plugin.connect → chat.completions/chat.event/plugin.message`。
- `src/gateway/lifecycle.ts`：每 profile 独立进程，处理 SIGINT/SIGTERM、QQ SDK stop、EchoAI gateway close。
- `src/features/approval-*`、`src/features/onboarding.ts`、`src/tools/*`、大部分 `src/commands/*`：OpenClaw 专属，不迁移。
- `src/adapter/webhook.ts`：绑定 OpenClaw HTTP ingress；首版不做 Webhook，未来也应按 EchoAI 服务边界重写。

## 4. 已确认的上游问题

这些问题意味着“直接打包上游”不可接受：

1. **二维码 connector 许可阻断**：`@tencent-connect/qqbot-connector@1.2.0` 在 lockfile 标记 `UNLICENSED`，上游却通过 tsup 将其 bundle。未取得再分发许可前，不能放入 `.echochannel`。首版可只提供 AppID/AppSecret 手工配置，或由腾讯确认授权后再接扫码。
2. **构建失败**：在本机 Node `v24.13.0` 执行 `npm ci && npm run typecheck && npm run build`，安装与 typecheck 通过，tsup 因 `qrcode-terminal` 的 legacy octal escape 失败；现有 esbuild patch 没有在解析前生效。
3. **安全审计**：`npm ci` 报告 12 个漏洞（2 low、5 moderate、4 high、1 critical），迁移前需用 `npm audit --json` 定位实际 runtime 可达项；不能直接 `audit fix` 破坏锁定版本。
4. **测试不可执行**：`package.json` 没有 `test` script，也未声明 `tsx/vitest`；8 个测试文件中多处 import 指向已移动/删除文件，部分测试复制实现而非调用生产代码。
5. **被动回复预算被绕过**：limiter 超限后把 `msgId` 置空，但 gateway 又从 msgId cache 自动补回，主动降级实际失效；回复预算还在发送成功前扣除。
6. **媒体失败误记成功**：dispatch 某路径忽略 `{error}` 并把 URL 加入已发送集合，导致最终回复不再重试该媒体。
7. **目标解析错误**：normalize 接受 `channel`，parse 却将其静默当 C2C；必须拒绝未支持场景。
8. **SSRF/内存风险**：部分下载在 DNS 失败时放行、未逐跳校验 redirect、未覆盖 IPv6，并先 `arrayBuffer()` 再检查 500MB 上限。
9. **持久化与清理**：下载媒体无 TTL/容量回收；引用索引异步 append 与同步 compact/退出可能竞态。
10. **未接线能力**：image-size、cron scheduler、部分 TTS helper 没有生产调用方，不能据此宣称支持。

## 5. 推荐的 `channels/qqbot` 架构

```text
channels/qqbot/
├── channel.json
├── MIGRATION.json
├── LICENSE
├── NOTICE.md
├── package.json / package-lock.json
└── src/
    ├── cli.ts                    # version/setup/start
    ├── commands/
    │   ├── setup.ts              # EchoWork setup v2
    │   └── start.ts              # profile + 双网关生命周期
    ├── profile/
    │   └── store.ts              # accountId/appId/secret，原子写、权限收紧
    ├── qq/
    │   ├── client.ts             # 腾讯 SDK adapter
    │   ├── inbound.ts            # C2C/群事件 → 标准入站消息
    │   ├── outbound.ts           # 文本/图片，被动/主动显式模式
    │   ├── target.ts             # c2c/group only
    │   └── reply-budget.ts       # msgId+msgSeq+TTL 原子预算
    ├── gateway/
    │   └── echoai-client.ts      # 可与 wechat 抽公共模块，但本批先避免大重构
    ├── bridge/
    │   └── orchestrator.ts       # 每会话绑定确定性 reply context
    ├── media/
    │   ├── inbound.ts            # 流式限额下载
    │   └── outbound.ts           # allowed roots + 明确 source type
    └── storage/
        ├── event-dedupe.ts        # event/msg 去重
        └── cleanup.ts             # TTL+容量回收
```

核心不变量：

- `profileId` 稳定映射一个 QQ Bot AppID；AppSecret 仅存本地 profile，日志必须脱敏。
- EchoAI session key 为 `qqbot:<profileId>:c2c:<user_openid>` 或 `qqbot:<profileId>:group:<group_openid>`。
- 每个入站 turn 保存不可变 reply context：`accountId/scope/targetId/msgId/eventId/nextMsgSeq/receivedAt`；回复不能查“最近发送者”。
- 被动回复、主动消息和 auto 三种模式显式区分；budget manager 为文本和媒体统一分配 `msg_seq`，只有 API 明确成功才提交消耗。
- QQ WSS event 在本地可靠接纳后才允许 session sequence 推进；需要验证腾讯 SDK 的 persistence callback 时序，不能仅假设。
- 下载使用流式写盘、Content-Length 预检、累计字节硬上限、并发上限、随机文件名、真实路径约束与 TTL/容量回收。

## 6. 实施批次

### M0：许可与 SDK 探针

- 确认 `qqbot-nodejs` MIT 包可独立完成手工 AppID/AppSecret、WSS、C2C/群事件、文本/图片发送。
- 暂不依赖 `qqbot-connector`；向腾讯确认 connector 的发布/再分发许可。
- 写最小 SDK probe 和 mock tests，验证 session persistence、Resume、msg_id/msg_seq 与 stop 行为。

### M1：可用的 QQ Channel

- 新建 `channels/qqbot` 与 provenance/NOTICE。
- 实现 `version`、setup add/restore、profile store、start。
- 支持 C2C 文本/图片、群 @ 文本、确定性 session/reply context、EchoAI bridge。
- 支持 WSS 重连/Resume、去重、统一 reply budget、限流和媒体回收。
- mock QQ SDK + mock EchoAI gateway 全链测试；Windows 打包和 artifact verify。

### M2：平台增强

- 在许可解决后加入二维码绑定。
- 加语音/视频/文件、C2C 官方流式、引用索引、主动消息策略。
- 真实 QQ 测试账号验证配额、审核、内容安全和断线重放。

### M3：高级能力

- Webhook、Inline Keyboard/审批、群细粒度策略和 QQ 频道场景。
- 只有在 EchoAI/EchoWork 存在明确产品入口时才实现，不照搬 OpenClaw 功能清单。

## 7. 验收门禁

首版合入前必须满足：

- `npm ci`、typecheck、build、统一 `npm test`、Hub 根目录 `npm test && npm run check` 全绿。
- 测试覆盖 setup add/restore/cancel、凭据不泄露、多账号隔离、C2C/群 session key、并发 reply routing、msg_seq、限额后主动模式、API 失败不误扣、WSS Resume/重复事件、媒体大小/SSRF/路径逃逸、SIGTERM。
- 构造 SDK mock 做异常注入：429、401、过期 msg_id、重复 event、断线、磁盘写失败、半截媒体、EchoAI gateway 重连。
- 用专用 QQ Bot 做真实 E2E：C2C、群 @、图片、进程重启后 Resume、同一消息多段回复、主动消息受限时的错误呈现。
- `.echochannel` 中不含 OpenClaw、不含 connector（许可未解决时）、不含测试凭据/登录态；保留上游 MIT LICENSE 与 NOTICE/provenance。

## 参考

- 上游仓库：<https://github.com/tencent-connect/openclaw-qqbot>
- 腾讯 QQ SDK：<https://www.npmjs.com/package/@tencent-connect/qqbot-nodejs>
- QQ Bot WebSocket：<https://bot.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html>
- QQ 消息规则：<https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html>
- 本项目 Channel 契约：[`CHANNEL_DEVELOPMENT_CONTRACT.md`](CHANNEL_DEVELOPMENT_CONTRACT.md)
