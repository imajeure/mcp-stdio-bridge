# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Document MCP client and transport compatibility, including tested Streamable
  HTTP coverage and known limitations for stdio-only and SSE-only clients.

## [0.1.1] - 2026-06-25

### Security
- Enforce the `Origin` header server-side as DNS-rebinding protection, per the
  MCP specification. The existing `allowedOrigins` (`--allow-origin` /
  `BRIDGE_ALLOW_ORIGIN`) now drives both the CORS header and server-side
  enforcement: with the default `*` any origin is allowed (no behaviour change);
  set specific origins and a request with a disallowed `Origin` gets `403`
  (before auth). Requests with no `Origin` header (non-browser clients) are
  always allowed; the opaque `null` origin is rejected.

### Fixed
- Report the real package version over MCP — read from `package.json` instead of
  a hardcoded constant that had drifted from the published version.

### Changed
- Require Node.js `>=22`; the previous `>=18` floor covered releases that are now
  end-of-life. CI runs on Node 22 and 24.
- Mark the package for npm provenance on publish (`publishConfig.provenance`).

## [0.1.0] - 2026-06-19

### Added
- Initial public release.
- `startBridge()` wraps any stdio MCP server and serves it over Streamable HTTP.
- Self-healing supervisor: the HTTP listener stays up independently of child
  state, and the wrapped child is auto-respawned on crash.
- Readiness vs liveness: `/healthz` liveness plus a `/ready` endpoint that runs
  a real `tools/list` round-trip to the wrapped child.
- Readiness-gated `systemd` watchdog to catch hangs (a live-but-unresponsive
  child), with gentle-to-hard escalation on repeated crashes.
- Optional bearer-token auth on the MCP endpoint (`--token` / `BRIDGE_TOKEN`).
- `cli.js` entry point (`mcp-stdio-bridge`) and an integration + self-heal test
  suite.

[Unreleased]: https://github.com/imajeure/mcp-stdio-bridge/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/imajeure/mcp-stdio-bridge/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/imajeure/mcp-stdio-bridge/releases/tag/v0.1.0
