# Contributing to Coniglio

Contributions are welcome. Prefer small, focused pull requests with tests that
describe the intended behavior.

## Setup

```bash
npm ci
npm run check
```

`npm run check` runs oxlint, an oxfmt check, strict TypeScript checking, unit
tests, the package build, and ESM/CommonJS public-API tests.

Run `npm run lint:fix` and `npm run format` before submitting a change.

## RabbitMQ integration tests

Start RabbitMQ locally on its default port, then run:

```bash
npm run test:integration
```

Integration tests create uniquely named temporary exchanges and queues and
clean them up after execution.

## Guidelines

- Add a regression test for bug fixes.
- Test failure and reconnect paths, not only the happy path.
- Keep public types, runtime behavior and README examples aligned.
- Preserve at-least-once delivery semantics.
- Run `npm pack --dry-run` when changing exports or package contents.
- Do not silently discard deliveries.

Bug reports should include expected behavior, actual behavior, reproduction
steps, Node.js version, RabbitMQ version and relevant logs.
