# 🐇 coniglio

> A small, typed and resilient RabbitMQ client for Node.js.

Coniglio wraps [`amqplib`](https://github.com/amqp-node/amqplib) with:

- async-iterator consumers with bounded prefetch;
- publisher confirms and configurable retry;
- automatic connection, channel, subscription and topology recovery;
- explicit `ack()` / `nack()` ownership;
- graceful shutdown and `AbortSignal` support;
- consistent JSON encoding with raw `Buffer` support;
- ESM, CommonJS and first-class TypeScript types.

## Installation

```bash
npm install coniglio
```

Coniglio supports Node.js 22 and newer.

## Quick start

```ts
import coniglio from 'coniglio'

type Events = {
  'user.created': { userId: string }
  'invoice.sent': { invoiceId: string; total: number }
}

const rabbit = await coniglio<Events>('amqp://localhost')

await rabbit.configure({
  exchanges: [
    { name: 'domain.events', type: 'topic', durable: true }
  ],
  queues: [
    {
      name: 'users',
      durable: true,
      bindTo: [
        { exchange: 'domain.events', routingKey: 'user.created' }
      ]
    }
  ]
})

await rabbit.publish(
  'domain.events',
  'user.created',
  { userId: '42' }
)

for await (const message of rabbit.listen('users', {
  routingKeys: ['user.created']
})) {
  try {
    if (message.contentIsJson) {
      await createUser(message.data.userId)
    }
    rabbit.ack(message)
  } catch (error) {
    rabbit.nack(message, true)
  }
}
```

Always close the client during application shutdown:

```ts
await rabbit.close()
```

## Creating a client

```ts
const rabbit = await coniglio('amqp://localhost', {
  logger: console,
  onEvent: event => {
    metrics.increment(`coniglio.${event.type}`)
  },
  json: true,
  prefetch: 10,
  reconnect: {
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    maxAttempts: Infinity
  },
  publish: {
    confirmTimeoutMs: 30000,
    retry: {
      initialDelayMs: 1000,
      maxDelayMs: 30000,
      maxAttempts: Infinity
    }
  },
  signal: applicationAbortController.signal,
  socketOptions: {
    timeout: 10000
  }
})
```

All options except the URL are optional.

### Logging

A logger may implement any subset of these methods:

```ts
interface Logger {
  debug?(...args: unknown[]): void
  info?(...args: unknown[]): void
  warn?(...args: unknown[]): void
  error?(...args: unknown[]): void
}
```

Pino and `console` can be passed directly.

## Consuming

`listen()` creates a dedicated RabbitMQ channel and returns an async generator:

```ts
for await (const message of rabbit.listen('users', {
  prefetch: 20,
  json: true,
  signal: workerAbortController.signal
})) {
  if (message.contentIsJson) {
    console.log(message.data)
  } else {
    console.warn('Non-JSON payload:', message.content)
  }

  rabbit.ack(message)
}
```

Breaking out of the loop, calling `iterator.return()`, aborting its signal, or
closing the client cancels the RabbitMQ consumer and closes its channel.

### Routing-key assertions

`routingKeys` narrows the TypeScript result and asserts the queue contract:

```ts
for await (const message of rabbit.listen('users', {
  routingKeys: ['user.created']
})) {
  if (message.contentIsJson) {
    message.data.userId
  }
}
```

RabbitMQ routing must still be configured through exchanges and queue bindings.
If the queue delivers a key outside `routingKeys`, Coniglio requeues the message,
stops that iterator and throws `UnexpectedRoutingKeyError`. It never silently
discards an unexpected message.

### Acknowledgements

```ts
rabbit.ack(message)
rabbit.nack(message)
rabbit.nack(message, true) // requeue
```

Acknowledgements are sent through the exact channel that delivered the message.
If that channel was lost during processing, `ack()` and `nack()` throw
`ConiglioMessageStateError`; RabbitMQ requeues the unacknowledged delivery when
the old channel closes.

## Publishing

Non-Buffer values are always encoded using `JSON.stringify()`:

```ts
await rabbit.publish('domain.events', 'user.created', {
  userId: '42'
})

// The wire body is the valid JSON string: "hello"
await rabbit.publish('', 'text', 'hello')
```

`Buffer` payloads are sent unchanged with an
`application/octet-stream` content type:

```ts
await rabbit.publish('', 'binary', Buffer.from([1, 2, 3]))
```

Standard `amqplib` publish options and Coniglio controls share the final
argument:

```ts
await rabbit.publish(
  'domain.events',
  'invoice.sent',
  { invoiceId: 'inv-1', total: 120 },
  {
    persistent: true,
    priority: 5,
    confirmTimeoutMs: 5000,
    retry: {
      initialDelayMs: 100,
      maxDelayMs: 5000,
      maxAttempts: 8
    },
    signal: requestAbortController.signal
  }
)
```

Use `retry: false` for one attempt.

Publishing provides **at-least-once**, not exactly-once, semantics. If RabbitMQ
accepts a message but its confirm is lost with the connection, a retry can
publish a duplicate. Consumers should be idempotent when duplicates matter.

Serialization errors are returned immediately and are never retried.

## Topology

```ts
await rabbit.configure({
  exchanges: [
    {
      name: 'domain.events',
      type: 'topic',
      durable: true
    },
    {
      name: 'delayed.events',
      type: 'x-delayed-message',
      durable: true,
      arguments: {
        'x-delayed-type': 'topic'
      }
    }
  ],
  queues: [
    {
      name: 'invoices',
      durable: true,
      deadLetterExchange: 'dead-letters',
      messageTtl: 60000,
      maxLength: 10000,
      bindTo: [
        {
          exchange: 'domain.events',
          routingKey: 'invoice.*'
        }
      ]
    }
  ]
})
```

Successful calls to `configure()` are remembered. After reconnecting, Coniglio
redeclares exchanges, queues and bindings before recreating active consumers.
The `x-delayed-message` exchange type requires the RabbitMQ delayed-message
plugin on the broker.

## Recovery model

Coniglio uses exponential backoff with jitter.

- A connection or publisher-channel close rebuilds the full transport.
- Each listener has an isolated consumer channel.
- A consumer-channel close rebuilds only that subscription.
- Stored topology is applied before subscriptions restart.
- Buffered deliveries from a closed channel are left for RabbitMQ to requeue.
- Pending listeners survive reconnect unless their retry budget is exhausted.
- `close()` and abort signals stop sleeps, retries and consumers.

Set finite `maxAttempts` values when the caller must regain control after a
bounded retry window. The defaults remain infinite for backward compatibility.

## Lifecycle and observability

The current lifecycle is available without parsing logs:

```ts
rabbit.state
// 'idle' | 'connecting' | 'ready' | 'reconnecting'
// | 'disconnected' | 'closing' | 'closed'
```

Use `onEvent` for metrics and tracing:

```ts
const rabbit = await coniglio('amqp://localhost', {
  onEvent (event) {
    switch (event.type) {
      case 'connection-retry':
        metrics.increment('rabbitmq.connection.retry')
        metrics.observe('rabbitmq.connection.backoff', event.delayMs)
        break
      case 'consumer-ready':
        metrics.increment('rabbitmq.consumer.ready', {
          queue: event.queue
        })
        break
      case 'publish-confirmed':
        metrics.increment('rabbitmq.publish.confirmed', {
          routingKey: event.routingKey
        })
        break
    }
  }
})
```

Event-hook failures are isolated and never affect delivery.

## Multiple connections

Each call creates an isolated client:

```ts
const production = await coniglio('amqp://production')
const qa = await coniglio('amqp://qa')

await production.publish('events', 'ready', { environment: 'production' })
await qa.publish('events', 'ready', { environment: 'qa' })

await Promise.all([
  production.close(),
  qa.close()
])
```

## Public types and errors

All public types are exported from the package root:

```ts
import coniglio, {
  ConiglioClosedError,
  ConiglioMessageStateError,
  ConiglioPublishError,
  UnexpectedRoutingKeyError,
  type ConfigureOptions,
  type ConiglioInstance,
  type ConiglioEvent,
  type ConiglioLifecycleState,
  type ConiglioOptions,
  type Message,
  type PublishOptions
} from 'coniglio'
```

Both ESM imports and CommonJS `require('coniglio')` are supported.

## Development

```bash
npm ci
npm run check
npm run test:integration
npm pack --dry-run
```

The integration suite expects RabbitMQ at `amqp://localhost`. CI runs the suite
against a RabbitMQ service and checks Node.js 22, 24 and 26.

## License

MIT
