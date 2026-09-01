# NOTICE — Third-Party Code

This project's WeChat protocol layer (`src/protocol/`) is **vendored and adapted**
from:

    @tencent-weixin/openclaw-weixin  v2.4.4
    https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin
    License: MIT

The vendored files implement the WeChat iLink protocol (CGI request signing,
getUpdates long-poll, sendMessage, QR login, CDN media upload/download, AES-128-ECB
media encryption). They were adapted as follows:

  - Removed the dependency on the host `openclaw` package (`openclaw/plugin-sdk/*`):
      * `src/protocol/auth/accounts.ts` — rewritten to drop OpenClaw config glue
        (openclaw.json route tags / channel reload / OpenClawConfig); on-disk
        credential format kept verbatim. `normalizeAccountId` self-implemented.
      * `src/protocol/util/logger.ts` — log dir repointed off the openclaw tmp dir.
      * `src/protocol/auth/pairing.ts` — `withFileLock` replaced with a plain
        read-modify-write (single-process channel).
  - Repointed the state directory from `~/.openclaw` to `~/.echoai/channels/wechat`
    (`src/protocol/storage/state-dir.ts`).

All other protocol files are used as-is (only `.js` import specifiers preserved for
NodeNext ESM resolution). The original MIT license follows.

---

MIT License

Copyright (c) Tencent / OpenClaw contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
