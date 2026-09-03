# Channel 开发、验收与发布手册

本文是操作手册，回答“从开始开发到用户成功安装，具体每一步做什么、验证什么”。协议字段的定义见 [`CHANNEL_DEVELOPMENT_CONTRACT.md`](CHANNEL_DEVELOPMENT_CONTRACT.md)；本文不重复协议原理，重点规定不可跳过的执行闭环。

## 1. 完成标准

一个 Channel 只有同时满足以下条件才算完成：

1. 源码、元数据、许可证和双 lockfile 合法。
2. Channel 自身 build/typecheck/test 通过。
3. setup add/restore 使用真实 CLI 进程跑通，且不泄露凭据。
4. fixture `.echochannel` 的签名和布局通过 Hub 校验。
5. 解包后按 `manifest.entrypoint + manifest.entrypointArgs` 直接启动成功。
6. 使用 EchoWork 当前安装器实际安装成功，而不只是 Hub `verify` 成功。
7. 正式发布后重新下载 production artifact，重复第 4–6 步。
8. Registry、Pages 闭包和 GitHub Release 均指向同一组生产字节。

`npm test`、签名正确或 CI 变绿，任何单项都不能替代完整闭环。

## 2. 开发前准备

### 2.1 检查工作树

```powershell
git status --short
git diff --stat
git log -5 --oneline --decorate
```

多人或多个 agent 共用工作树时，先标记哪些文件属于他人在制改动。禁止用 `checkout`、`reset`、`stash` 清除它们；提交时只 `git add` 本任务文件。尤其注意：打包器、schema、Channel manifest 必须作为同一协议版本提交，不能把工作树中的新版 `hubctl.js` 与 Git index 里的旧版 `lib.js` 混合发布。

### 2.2 建立目录

```text
channels/<id>/
├── channel.json
├── package.json
├── package-lock.json
├── README.md
├── LICENSE
├── NOTICE.md
├── MIGRATION.json
├── tsconfig.json
└── src/
```

Channel 引用第三方实现时，先确认许可证允许复制和再分发；固定上游 URL、commit、排除项和改造边界。`UNLICENSED` 依赖不得进入 artifact。

## 3. 实现顺序

1. 先定义稳定 Channel ID、版本、目标平台、真实能力和 profile 模型。
2. 实现 `version --json`，输出必须与 `channel.json` 一致。
3. 实现 setup v2：add、可选 restore、取消、错误和 loopback UI。
4. 实现 profile 原子存储；凭据不能写 stdout/stderr/catalog。
5. 实现 start v1、EchoAI Gateway、平台收发、确定性 session/reply 路由。
6. 实现并发、去重、限流、重连、媒体边界和优雅关闭。
7. 最后写 metadata 中的 capabilities/highlights；尚未真实实现的能力不得声明。

## 4. 本地源码门禁

### 4.1 安装和同步 lockfile

根目录是 npm workspace，Channel 同时需要独立 lockfile：

```powershell
npm install --package-lock-only --ignore-scripts
Push-Location channels/<id>
npm install --package-lock-only --ignore-scripts --workspaces=false
Pop-Location
npm ci
```

修改依赖或版本后必须同步根 `package-lock.json` 与 `channels/<id>/package-lock.json`。CI 使用 `npm ci`；任一 lockfile 不同步都会在发布机失败。

### 4.2 构建、版本和测试

```powershell
npm run typecheck --workspace=@echoworker/echo-<id>
npm run build --workspace=@echoworker/echo-<id>
node channels/<id>/dist/cli.js version --json
npm test --workspace=@echoworker/echo-<id>
npm test
npm run check
git diff --check
```

Windows 的 `node --test` 不可靠地展开 shell glob。测试脚本必须显式列出文件，或由 Node 脚本生成文件列表，不能写：

```json
"test": "node --test dist/tests/*.test.js"
```

## 5. setup 必须做真实流程测试

单元测试不够。使用隔离状态目录启动真正 CLI：

```powershell
$state = Join-Path $env:TEMP "channel-setup-$([guid]::NewGuid())"
$env:ECHO_<CHANNEL>_STATE_DIR = $state
node channels/<id>/dist/cli.js setup --echowork-json --session-id manual-e2e --mode add
```

验收步骤：

1. stdout 必须先输出唯一 `echowork.channel_setup.ready` JSON 行。
2. `url` 必须是带随机 capability path 的 `127.0.0.1` 地址。
3. 用真实浏览器打开 URL，检查表单、CSP、Host 校验和 no-store。
4. 提交专用测试凭据，页面显示成功，CLI 输出 `complete.profile_id`。
5. 检查 profile/index 已原子落盘；输出、页面和状态 API 不含 secret。
6. 用返回的 profile 运行 restore：

```powershell
node channels/<id>/dist/cli.js setup --echowork-json --session-id manual-restore --mode restore --account <profileId>
```

7. restore 返回同一 profile，profile 文件哈希和修改时间不变。
8. 删除隔离目录，禁止污染真实 `~/.echoai`。

还要实测取消、未知参数、重复参数、缺失值和损坏 profile 均非零退出。

## 6. fixture artifact 门禁

### 6.1 构建与 Hub 校验

```powershell
node src/hubctl.js package <id> --target windows-x64 --bundle-runtime --fixture
node src/hubctl.js verify artifacts/<id>-<version>-windows-x64.echochannel --fixture
```

`verify` 必须检查签名、哈希、唯一根 manifest，以及 manifest 引用的每个包内路径存在；但仍必须继续做真实入口 smoke test。

### 6.2 解包后直接执行 manifest

```powershell
$artifact = "artifacts/<id>-<version>-windows-x64.echochannel"
$unpack = Join-Path $env:TEMP "channel-artifact-$([guid]::NewGuid())"
Expand-Archive $artifact $unpack
$manifest = Get-Content (Join-Path $unpack "manifest.json") -Raw | ConvertFrom-Json
$executable = Join-Path $unpack ($manifest.entrypoint -replace '/', '\')
$entryArgs = @($manifest.entrypointArgs | ForEach-Object {
  Join-Path $unpack ($_ -replace '/', '\')
})
& $executable @entryArgs version --json
if ($LASTEXITCODE -ne 0) { throw "packaged entrypoint failed" }
```

必须确认：

- `entrypoint` 文件存在并可启动。
- 每个路径型 `entrypointArgs` 都存在且位于包内。
- 输出的 publisher/id/version/protocols 与 manifest 一致。
- 包内没有 `.cmd/.bat/.ps1` shell shim、测试目录、测试 secret、登录态、`.env`、gateway lock。
- `payload/app/dist/cli.js` 和生产依赖确实存在。

### 6.3 为什么要单独测 dist 根目录

`fs.cpSync(..., {filter})` 会对源根目录本身调用 filter。若过滤规则按 `path.basename(source)` 排除 `dist`，整个复制会静默为空。回归测试必须以名为 `dist` 的目录作为复制根，断言 `dist/cli.js` 被复制、嵌套 `dist/tests` 被排除。只测试普通目录无法发现这一类错误。

## 7. EchoWork 安装器真实验收

在发布前，用当前 EchoWork 安装器安装 fixture/本地 catalog，不能只运行 Hub CLI。安装器会执行：

1. 下载并校验 artifact hash/signature。
2. 解压和验证 manifest。
3. 解析 `entrypoint` 与 `entrypointArgs`。
4. 执行 packaged `version --json`。
5. 提交 installed record。
6. 启动 setup。

验收必须覆盖“安装 → setup add → profile 出现 → start → stop → restore”。Windows `os error 2` 通常意味着安装器准备启动的 executable 或路径型参数不存在；第一时间下载同一生产 artifact，按第 6.2 节执行，不要先猜网络或权限。

## 8. 提交与 preview

```powershell
git status --short
git diff --check
git add <本任务文件>
git diff --cached --check
git diff --cached --stat
git commit -m "feat: add <id> channel"
git push origin main
```

先触发 preview：

```powershell
gh workflow run candidate.yml --ref main -f channel=<id> -f version=<version>
gh run list --workflow candidate.yml --limit 3
gh run watch <run-id> --exit-status
```

Preview 成功后，必须从 GitHub Release 重新下载上传后的 artifact，不使用本地文件替代，并重复：签名校验、解包、manifest 直启、EchoWork 安装、setup/start smoke test。

## 9. 正式发布

正式版本必须递增；已发布 Registry 内容是不可变的，损坏的 `v0.1.0` 不能原地覆盖，只能修复后发布 `v0.1.1`。

```powershell
gh workflow run release.yml --ref main -f channel=<id> -f version=<version>
gh run list --workflow release.yml --limit 3 --json databaseId,status,conclusion,headSha,url
gh run watch <run-id> --exit-status
```

若失败：

```powershell
gh run view <run-id> --log-failed
gh release view v<version> --json isDraft,url,assets
```

草稿 release 失败后，在重试同一尚未发布的版本前删除草稿，避免 tag/release 冲突：

```powershell
gh release delete v<version> --yes
```

不得删除已经公开的正式版本来伪装内容可变；公开坏版本应保留审计记录并由新 patch 版本替代。

## 10. 发布后 production 验收

CI success 不是终点。获取 Release URL 后：

```powershell
gh release view v<version> --json isDraft,isPrerelease,url,tagName,assets
Invoke-WebRequest "https://github.com/EchoWorker/EchoChannelHub/releases/download/v<version>/<id>-<version>-windows-x64.echochannel" -OutFile $artifact
```

对下载文件执行：

1. `hubctl verify --production`（需要对应 sidecar）。
2. 解包并按 manifest 直启 `version --json`。
3. 用 EchoWork 正式安装路径安装。
4. 真实跑 setup add/restore。
5. 有专用平台账号时执行最小收发和重启恢复 E2E；无凭据必须明确记为“待实测”。
6. 验证 GitHub Pages 发布闭包：

```powershell
node src/hubctl.js validate-pages https://echoworker.github.io/EchoChannelHub/v1/latest.json --production
```

7. 确认 Registry catalog 的 artifact URL、size、sha256、signature、keyId 与实际下载字节一致。

任何一步失败，版本不得宣布可用。

## 11. 发布证据模板

每次发布至少记录：

```text
Channel / version:
Source commit:
Workflow run URL:
Release URL:
Artifact SHA-256:
Hub production verify: PASS/FAIL
Manifest direct execution: PASS/FAIL
EchoWork install: PASS/FAIL
Setup add/restore: PASS/FAIL
Platform E2E: PASS/FAIL/SKIP（原因）
Pages closure: PASS/FAIL
Known limitations:
```

## 12. 故障快速定位

| 现象 | 首查 |
|---|---|
| `npm ci` 报 missing lock entry | 根/Channel 双 lockfile 是否同步 |
| Windows CI 找不到 `*.test.js` | `node --test` 是否用了 glob |
| 安装时报 `os error 2` | 解包后 entrypoint/entrypointArgs 是否真实存在 |
| Hub verify 过但安装失败 | verify 是否执行了 packaged version probe；EchoWork 是否实装 |
| 本地包可用、线上包不可用 | 重新下载 Release 字节，不要复用本地 artifact |
| build-registry 拒绝 schema | channel、schema、lib、hubctl 是否混用了不同版本 |
| 发布中途留下 draft | 查失败日志，修复后删除未公开 draft 再重试 |
| setup 页面可开但无法完成 | CLI stdout JSONL、Host/CSP、POST body、profile 写盘逐项检查 |

核心原则只有一句：**验证用户实际拿到的字节，并沿用户实际安装/启动路径执行。**
