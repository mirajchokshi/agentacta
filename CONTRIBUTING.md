# Contributing to AgentActa

Thanks for your interest! AgentActa is a zero-framework Node.js project — we keep things simple.

## Dev Setup

```bash
git clone https://github.com/mirajchokshi/agentacta.git
cd agentacta
npm install
```

## Running Tests

```bash
npm test
```

Tests use Node's built-in test runner (`node:test` + `node:assert`). No extra test frameworks needed.

## Code Style

- No frameworks — vanilla Node.js, raw HTTP, better-sqlite3
- No new npm dependencies without strong justification
- Keep functions small and focused
- Use `const` by default, `let` when needed, never `var`

## Making Changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Add/update tests for new functionality
4. Run `npm test` and make sure everything passes
5. Open a PR with a clear description of what and why

## Reporting Issues

Open a GitHub issue with:
- What you expected vs what happened
- Steps to reproduce
- Node.js version and OS
