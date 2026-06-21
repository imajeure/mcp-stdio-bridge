# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/imajeure/mcp-stdio-bridge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/imajeure/mcp-stdio-bridge/releases/tag/v0.1.0
