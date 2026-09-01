# echo-wechat — WeChat channel for EchoAI

Talk to your EchoAI agent from WeChat. Scan a QR code to log in with a WeChat
account, and that account becomes a bot — messages it receives go to your agent,
and the replies (text + images) come back.

## Usage

```bash
npm install -g @echoworker/echo-wechat
# or let EchoAI run the current package directly:
# npx --yes @echoworker/echo-wechat start
echo-wechat login          # scan the QR with a (secondary) WeChat account
```

Then add it in EchoWork's **Channels** panel → **Add channel**:

| field | value |
|-------|-------|
| command | `echo-wechat` |
| args | `["start"]` |
| enabled | ✓ |

Hit **Start** — the gateway runs the channel and it goes ● online. Send your bot
account a message to try it.

> ⚠️ Uses the unofficial iLink protocol — use a secondary account (ban risk).
> Login token is stored under `~/.echoai/channels/wechat/`.

## License

MIT. The `src/protocol/` layer is vendored from
[`@tencent-weixin/openclaw-weixin`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)
(MIT) — see [`NOTICE.md`](./NOTICE.md).
