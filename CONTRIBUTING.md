# Contributing

Thanks for your interest in improving `@imajeure/mcp-stdio-bridge`.

## Development

```sh
git clone https://github.com/imajeure/mcp-stdio-bridge.git
cd mcp-stdio-bridge
npm ci
npm test
```

`npm test` runs the suite with Node's built-in test runner (`node --test`). It
covers the supervisor logic (respawn ladder, escalation, readiness-gated
heartbeat, `/ready` route) plus an integration test that wraps the canonical
`@modelcontextprotocol/server-everything`, completes an MCP `initialize` over
HTTP, then kills the child and asserts the bridge respawns it and recovers.

## Pull requests

- Keep changes focused — one concern per PR.
- Add or update tests for behaviour changes, especially in the supervisor,
  respawn, and readiness paths.
- Make sure `npm test` passes locally; CI runs the same suite on Node 20 and 22.
- Note user-facing changes in `CHANGELOG.md` under `## [Unreleased]`.

## Reporting bugs

Open an issue with reproduction steps, the wrapped server command, your Node
version, and observed vs expected behaviour.

## Security

Please don't file security issues publicly — see [SECURITY.md](SECURITY.md).
