# Security Policy

## Supported versions

The latest published `0.x` release receives security fixes.

## Reporting a vulnerability

Please report suspected vulnerabilities privately rather than opening a public
issue:

- Use GitHub's **private vulnerability reporting** for this repository
  (the **Security** tab → **Report a vulnerability**), or
- email **oss@imajeure.com** with details and a reproduction.

We aim to acknowledge reports within a few business days and will coordinate a
fix and disclosure timeline with you.

## Threat model

This package supervises a wrapped stdio MCP server and exposes it over HTTP.
Treat the following as security-relevant:

- The bridge spawns a child process (often via `npx`) — only wrap servers you
  trust.
- The HTTP endpoint binds to loopback by default and supports optional bearer
  auth (`--token` / `BRIDGE_TOKEN`); require auth or a trusted network before
  exposing it more broadly.
- When driven by an LLM agent, wrapped tools may receive attacker-influenced
  input — apply least privilege to the wrapped server.
