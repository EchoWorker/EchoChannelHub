# EchoChannelHub

Governed EchoWork channel registry and candidate build pipeline.

开发/新增 Channel 前，请先阅读：
- [`governance/CHANNEL_DEVELOPMENT_CONTRACT.md`](governance/CHANNEL_DEVELOPMENT_CONTRACT.md)：源元数据、setup v2、start v1、EchoAI 网关、打包和签名的协议契约。
- [`governance/CHANNEL_DEVELOPMENT_PLAYBOOK.md`](governance/CHANNEL_DEVELOPMENT_PLAYBOOK.md)：从开发、真实 setup、fixture 解包直启、EchoWork 实装到 production 下载复验的操作手册。

Only `windows-x64` is supported. Candidate artifacts and the catalog are signed with the committed `echoworker-test-2026` Ed25519 key. **This keypair is TEST ONLY, non-production, and must only be built into EchoWork test/development builds.** The raw 32-byte public key for that keyring is in `test/keys/TEST_ONLY_ed25519_public.json`; never trust it in production.

```powershell
npm ci
npm test
npm run check
node src/hubctl.js package wechat --target windows-x64 --bundle-runtime
node src/hubctl.js verify artifacts/wechat-0.1.11-windows-x64.echochannel
```

The package command emits one ZIP-format `.echochannel` with a root manifest v3 that launches `payload/runtime/node.exe` with `payload/app/dist/cli.js` as `entrypointArgs` (no `.cmd` shim), plus a signed sidecar. Production signing requires `CHANNEL_HUB_SIGNING_KEY`; `--fixture` uses the test-only key for local structural verification.
