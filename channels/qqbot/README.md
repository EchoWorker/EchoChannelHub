# EchoAI QQ Bot Channel

Connect EchoAI to QQ through the official QQ Bot API. Version 0.1.0 supports C2C private text/image messages and group text/image messages that explicitly mention the bot.

## Setup

1. Create a bot at [QQ Open Platform](https://q.qq.com/) and obtain its AppID and AppSecret.
2. Add **QQ Bot** from EchoWork Channels. The loopback-only setup page stores the credentials under `~/.echoai/channels/qqbot`.
3. Start the resulting profile from EchoWork.

QR binding is not included: its upstream connector package is currently published as `UNLICENSED`. Webhook, guild channels, voice, video, files, inline keyboards and C2C streaming are also outside v0.1.0.

## Security and platform behavior

Credentials stay in the local profile and are never included in the Channel catalog. QQ applies passive-reply time/count limits and separate proactive-message quotas; the channel preserves these modes rather than silently retrying one as the other. Group messages require an explicit bot mention.

## Validation status

Automated fake-adapter coverage validates setup, routing, failure and reconnect behavior without external effects. **Real QQ end-to-end validation with a dedicated QQ Bot is pending**; no production account claim is made yet.

## Provenance

Adapted from [`tencent-connect/openclaw-qqbot`](https://github.com/tencent-connect/openclaw-qqbot) under MIT. See `NOTICE.md` and `MIGRATION.json`.
