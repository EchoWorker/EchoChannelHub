# Contributing

Each channel lives in `channels/<id>`, owns a `channel.json`, and must include its declared provenance and license files. IDs are immutable kebab-case names; versions use SemVer. A pull request must update source and lockfile, pass `npm test` and `npm run check`, and must not commit generated `dist`, dependencies, credentials, login state, or candidates. The protocol requirements are in [`CHANNEL_DEVELOPMENT_CONTRACT.md`](CHANNEL_DEVELOPMENT_CONTRACT.md); the mandatory development, packaging, real-install, release, and post-release checks are in [`CHANNEL_DEVELOPMENT_PLAYBOOK.md`](CHANNEL_DEVELOPMENT_PLAYBOOK.md).

Catalog edits are generated with `node src/hubctl.js build-catalog`. Platform declarations are evidence-based: do not add a target until CI builds and verifies it. Production signing is outside M0/M1.
