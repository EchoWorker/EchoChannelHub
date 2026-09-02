# EchoChannelHub

Governed EchoWork channel registry and candidate build pipeline.

开发/新增 Channel 前，请先阅读 [`governance/CHANNEL_DEVELOPMENT_CONTRACT.md`](governance/CHANNEL_DEVELOPMENT_CONTRACT.md)：它定义源元数据、setup v2、start v1、EchoAI 网关、打包、签名、Registry 与发布验收契约。

Only `windows-x64` is supported. Candidate artifacts and the catalog are signed with the committed `echoworker-test-2026` Ed25519 key. **This keypair is TEST ONLY, non-production, and must only be built into EchoWork test/development builds.** The raw 32-byte public key for that keyring is in `test/keys/TEST_ONLY_ed25519_public.json`; never trust it in production.

```powershell
npm ci
npm test
npm run check
node src/hubctl.js package wechat --target windows-x64 --bundle-runtime
node src/hubctl.js verify artifacts/wechat-0.1.10-windows-x64.echochannel
```

The package command emits one ZIP-format `.echochannel` with a root `manifest.json`, a signed sidecar, and a signed catalog. It refuses every other target and makes no production-signing claim.
