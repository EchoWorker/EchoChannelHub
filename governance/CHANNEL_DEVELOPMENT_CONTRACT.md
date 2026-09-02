# Channel 开发契约

本仓库的 Channel 不是独立 npm 包的简单收录，而是由 **Channel 源码契约 → EchoWork 安装包契约 → EchoAI 运行时契约 → 已签名发布目录契约** 组成的完整交付物。任何一层不满足，都不能作为可发布 Channel。

## 0. 当前边界

- 当前唯一支持目标：`windows-x64`。
- 当前源码运行时：Node.js；根项目要求 Node.js `>=20`，Channel 可声明自身最低 Node.js 版本，但候选/正式构建必须在 Windows x64 上完成。
- Channel ID 是不可变的小写 kebab-case 名称，如 `wechat`、`my-channel`；版本必须是 SemVer。
- 禁止把凭据、登录态、`node_modules`、生成的 `dist` 或候选 `.echochannel` 提交进仓库。

权威实现位于 [`schemas/`](../schemas)、[`src/lib.js`](../src/lib.js)、[`src/hubctl.js`](../src/hubctl.js)；本文是面向开发者的可执行说明，发生冲突时以代码和 schema 为准。

## 1. 源码目录与来源契约

每个 Channel 必须位于 `channels/<id>/`，且 `<id>` 必须与 `channel.json.id` 完全一致。目录至少包含：

```text
channels/<id>/
├── channel.json       # Hub 源元数据
├── package.json       # Node 包定义，version 必须与 channel.json 相同
├── package-lock.json  # 可复现的 npm 依赖锁
├── <provenance file>  # 由 channel.json.provenance 指向
└── src/               # 实现源码
```

`channel.json.provenance` 必须是安全的相对路径且文件存在，用来说明源码来源、导入范围、排除项和许可处理。许可字段 `license` 必填；如果包含第三方或 vendored 代码，应随代码保留对应 notice/license 文件。

## 2. `channel.json` 源元数据契约

`channel.json` 必须以 `schemas/channel-source-v2.schema.json` 为 `$schema`，并满足以下规则：

- 固定字段：`schemaVersion: 2`、`publisher: "EchoWorker"`、`runtime: "node"`、`target: "windows-x64"`。
- `name`、`summary`、`description`、`runtimeLabel`、`setupMethod` 和每一条 `highlights` 都必须同时具备非空 `en`、`zh-CN`。
- `categoryIds`、`tagIds`、`capabilities` 至少各有一项，必须来自 [`src/taxonomy.js`](../src/taxonomy.js) 定义的词表、不能重复且字典序排列；`aliases` 若存在也必须字典序排列。
- `publisherTrust` 只能是 `official` 或 `community`；`entrypoint`、`provenance` 必须是非空、安全相对路径。
- `package.json.version` 必须与 `channel.json.version` 一致；`package.json`、`package-lock.json` 和 provenance 文件必须实际存在。

推荐从现有 [`channels/wechat/channel.json`](../channels/wechat/channel.json) 复制结构，而不是凭印象新造字段。源码元数据可进入公开 catalog；**`setup` 不会进入 catalog**，因为它属于仅供安装执行的 artifact manifest。

## 3. 安装与配置（setup v2）契约

`channel.json.setup` 描述 EchoWork 启动 Channel 配置流程时实际执行的参数，而不是 UI 文案。它只能有 `args`、`add`、可选 `restore`、`startArgs`、`env` 字段：

```json
{
  "args": ["setup", "--echowork-json", "--session-id", "{sessionId}"],
  "add": { "args": ["--mode", "add"] },
  "restore": { "args": ["--mode", "restore", "--account", "{profileId}"] },
  "startArgs": ["start", "--account", "{profileId}"],
  "env": {}
}
```

参数占位符必须独占一个参数：

- `setup.args` 仅允许 `{sessionId}`。
- `setup.restore.args`、`setup.startArgs` 仅允许 `{profileId}`。
- `setup.add.args` 不允许任何占位符。
- 参数和环境变量值必须是非空、无控制字符字符串；环境变量名必须匹配 `[A-Za-z_][A-Za-z0-9_]*`。

CLI 必须严格实现 setup v2，接受 artifact 给出的 `setup.args + add.args` 或 `setup.args + restore.args`；不要悄悄忽略未知 flag 或缺失值。以 JSON Lines 向 stdout 报告生命周期：

```json
{"type":"echowork.channel_setup.ready","version":1,"session_id":"<原样回显>","url":"http://127.0.0.1:<port>/..."}
{"type":"echowork.channel_setup.complete","version":1,"session_id":"<原样回显>","profile_id":"<稳定账号标识>"}
```

`ready` 表示宿主可以打开引导页；成功时必须输出 `complete` 且提供稳定的 `profile_id`。失败、取消或信号中断必须以非零退出，不得伪造完成事件。若支持恢复，恢复结果必须与传入 `profileId` 一致。配置 UI 服务应仅监听 loopback，不能把二维码、令牌或认证状态暴露到局域网。

## 4. 启动（start v1）与 EchoAI 网关契约

EchoWork 使用 `setup.startArgs` 启动已配置 profile；Channel 应解析并校验这些参数，尤其是 profile/account 不存在、多账号未明确选择、工作区路径不合法等情形，须明确报错并非零退出。

正常情况下 EchoAI 注入以下环境变量：

- `ECHOAI_GATEWAY_URL`：WebSocket 网关地址。
- `ECHOAI_GATEWAY_TOKEN`：网关认证令牌。
- `ECHOAI_PLUGIN_NAME`：注册插件名。

可为手工启动提供受控 fallback（例如本地 gateway lock），但不得用默认公开地址或绕过认证。网关连接顺序为：

1. 有 token 时调用 JSON-RPC `auth`。
2. 调用 `plugin.connect`，参数包含 `plugin_name`、`plugin_type: "channel"` 与 `disable_questions: true`。
3. 入站消息调用 `chat.completions`，必须使用 `session_key` 和 `modes: ["headless"]`；可按需附带 model、workspace、附件绝对路径。
4. 订阅 `chat.event`，仅把主 agent 文本回送平台；包含 `subagent_task_id` 的内部输出不能外发。
5. 处理 `plugin.message`，将 agent 主动发送的文本/媒体投递到目标平台。

Channel 必须把平台消息映射到稳定的 EchoAI `session_key`，保存回复平台所需的上下文；回复路由不得依赖可能被并发覆盖的“最近一个发送者”状态。应对网关断线自动重连，关闭时拒绝未完成 RPC，避免悬挂请求；对平台 API 施加并发、队列、速率和媒体大小限制，失败要记录真实原因，用户只收到适度的友好错误。

## 5. 打包 artifact 契约

只能通过 Hub CLI 打包：

```powershell
node src/hubctl.js package <id> --target windows-x64 --bundle-runtime
node src/hubctl.js verify artifacts/<id>-<version>-windows-x64.echochannel
```

打包会先在 Channel 目录执行 `npm run build` 与 `npm test`，随后生成一个 ZIP 格式 `.echochannel`。包内必须恰有一个根 `manifest.json`；Hub 自动生成它，开发者不能手写替换。其结构固定为：

```json
{
  "schemaVersion": 2,
  "publisher": "EchoWorker",
  "id": "<id>",
  "version": "<version>",
  "target": "windows-x64",
  "entrypoint": "payload/echo-<id>.cmd",
  "protocols": { "setup": 2, "start": 1 },
  "setup": { "...": "从 channel.json 原样复制" }
}
```

payload 中的启动器调用 `payload/app/dist/cli.js`；使用 `--bundle-runtime` 时还会携带 `payload/runtime/node.exe`。打包会排除 `.git`、`node_modules`、`dist`、`artifacts` 后复制源码，再重新安装生产依赖并复制构建产物。artifact 旁的 `.json` sidecar 必须准确记录文件名、目标、大小、SHA-256、Base64 Ed25519 签名、keyId、testOnly；任何字节变化都需要重签。

不带 `--production` 的产物只能使用 `echoworker-test-2026` 测试密钥，且 `testOnly: true`，绝不能被生产 EchoWork 信任。正式包必须传 `--production`、提供 `CHANNEL_HUB_SIGNING_KEY`，使用 `echoworker-prod-2026`；私钥不得落盘或提交。

## 6. Registry 与发布闭包契约

Registry 位于 `registry/v1/`，由 `build-registry` 生成，禁止手工编辑。它发布：

- `latest.json`：指向不可变 snapshot。
- content-addressed snapshot：包含 sequence、过期时间、签名 profile、blob 引用与 changed set。
- SHA-256 地址化的 catalog、categories、tags JSON 及每个对象的 `.sig`。

catalog 仅发布可发现的语义元数据和 artifact 引用，不得泄露 `setup`、凭据或本机路径。每个 artifact URL 必须为 HTTPS，且其字节大小、SHA-256、签名和 keyId 必须与 catalog 完全一致。发布正式版本的唯一流程是 GitHub Actions `release.yml`：受 production environment 保护、构建并验证 production artifact、上传 GitHub Release、写入 artifact URL、生成并验证 Registry、提交 registry，最后部署 Pages。不要在本机伪造生产发布。

## 7. 最小验收清单

提交 PR 前执行：

```powershell
npm ci
npm test
npm run check
npm run build --workspace=@echoworker/echo-<id>
node channels/<id>/dist/cli.js version --json
node src/hubctl.js package <id> --target windows-x64 --bundle-runtime
node src/hubctl.js verify artifacts/<id>-<version>-windows-x64.echochannel
```

还必须覆盖 Channel 自身的至少以下测试：参数/占位符非法输入、setup add/restore 成功与取消、profile 选择、网关认证与重连、入站到 `chat.completions`、主 agent 输出过滤、平台发送失败/限流、附件边界和优雅关闭。真实平台登录或发消息会产生外部影响，应使用专用测试账号并单独确认；单元测试通过不等于平台端到端可用。

## 8. 开发顺序

1. 确定平台接入边界、账号模型、消息/媒体能力与风险；写 provenance、license、双语源元数据。
2. 实现 CLI 的 `version`、严格 setup v2、profile 存储和 start v1；先为参数与 JSON Lines 生命周期写测试。
3. 实现认证、入站轮询/webhook、媒体收发及持久化；明确每条消息怎样对应 `session_key` 和回复目标。
4. 接入 EchoAI gateway JSON-RPC、重连、事件聚合和 headless 行为；测试并发与断线场景。
5. 补充 Channel 构建/测试脚本、锁文件和独立 README，完成根目录验收清单。
6. 由 CI 生成 preview 候选；经过平台真实验证和审批后，才通过正式 release workflow 发布。
