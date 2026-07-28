# Changelog

All notable changes to this project are documented here.

## 2.0.0

### Added

- Graceful, idempotent `close()` and `AbortSignal` support.
- Dedicated consumer channels with real consumer cancellation.
- Connection and channel recovery.
- Stored topology replay before subscription recovery.
- Configurable reconnect and publish retry policies.
- Publisher-confirm timeout support.
- Typed lifecycle state and observability events.
- Typed public errors and root-level type exports.
- Unit, RabbitMQ integration and package-contract test suites.
- CI across supported Node.js release lines.

### Changed

- Strings and all other non-Buffer payloads are consistently JSON encoded.
- Raw `Buffer` payloads are published unchanged.
- Acknowledgements are bound to the channel that delivered the message.
- Unexpected `routingKeys` are requeued and surfaced as an error instead of
  being silently discarded.
- The TypeScript configuration now uses strict mode.
- ESM and CommonJS exports now expose the same runtime API.
- The development dependency tree has been updated and reduced.
- The runtime now uses amqplib 2 with its bundled TypeScript declarations.
- The toolchain now uses TypeScript 7, oxlint, oxfmt and tsdown.
- A consumer-channel failure now rebuilds the complete transport, avoiding a
  second per-consumer recovery supervisor.

### Fixed

- Consumers now restart after a connection `close`, not only after `error`.
- Active topology and bindings are restored after reconnect.
- Stopping an async iterator no longer leaves a ghost RabbitMQ consumer.
- Shutdown no longer races channel and connection close handshakes.
- Publisher confirms correctly treat amqplib's `null` callback value as
  success.
- `messageTtl: 0` and `maxLength: 0` are preserved.

## 1.1.1

- Added `x-delayed-message` to the exchange type declarations.

## 1.1.0

- Added publish options.

## 1.0.0

- Initial release.
