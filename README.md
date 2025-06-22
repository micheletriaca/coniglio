# 🐇 coniglio

> A minimal, elegant, and robust async RabbitMQ client for Node.js

<img align="left" height="180" alt="Fastest full PostgreSQL nodejs client" src="https://raw.githubusercontent.com/micheletriaca/coniglio/refs/heads/master/logo.png">

<br/>

**coniglio** (Italian for “rabbit”) is a modern wrapper around RabbitMQ designed to be dead-simple to use, resilient in production, and fully composable with async iterators and streaming libraries. Inspired by libraries like [`postgres`](https://github.com/porsager/postgres), it gives you just the right abstraction for real-world systems without hiding the power of AMQP.

<br/>

---

## 🚀 Features

* ✅ **`for await…of` streaming API** — process messages naturally with backpressure
* ✅ **Auto reconnect** — connection and channel recovery handled transparently with exponential backoff + jitter
* ✅ **JSON decoding by default** — or opt-out for raw Buffer access
* ✅ **Manual `ack()` / `nack()`** — total control over message flow
* ✅ **Composable** — works beautifully with `p-map`, `exstream.js`, `highland`, standard Node streams and more
* ✅ **Multiple isolated connections** — supports multi-tenant, multi-env, and dynamic routing
* ✅ **TypeScript support** — full type inference over event data
* ✅ **Zero dependencies (core version)** — just `amqplib` under the hood

---

## 📦 Installation

```bash
npm install coniglio
```

## ✨ Usage

```js
import coniglio from 'coniglio'

const conn = await coniglio('amqp://localhost')

// Configure queues and exchanges
// (optional, useful for bootstrapping or tests)
await conn.configure({
  queues: [
    { name: 'jobs.email', durable: true }
  ],
  exchanges: [
    { name: 'domain.events', type: 'topic', durable: true }
  ]
})

// Consume messages from a queue
for await (const msg of conn.listen('jobs.email')) {
  await sendEmail(msg.data)
  conn.ack(msg)
}

// Publish messages to an exchange
setInterval(() => {
  conn.publish('domain.events', 'jobs.email', { message: 'hello world' })
}, 200)
```

---

## 📦 Table of contents

1. [Why Coniglio?](#-why-coniglio)
1. [API](#-api)
1. [Philosophy](#-philosophy)
1. [Resilience](#-resilience-by-design)
1. [Multiple connections](#-multiple-connections)
1. [TypeScript Integration](#-typescript-integration)
1. [Usage in Production Systems](#️-usage-in-production-systems)
1. [Coming Soon](#-coming-soon-planned)
1. [License](#-license)

## 🐇 Why Coniglio?

If you’ve used [`amqplib`](https://github.com/amqp-node/amqplib), you know it’s the **canonical** RabbitMQ library for Node.js — powerful, stable, and low-level. But it leaves you wiring:

* reconnect logic
* message decoding
* ack/nack control
* error-safe consumption
* backpressure handling
* channel separation for pub/sub

**Coniglio wraps `amqplib`** with a modern, minimal layer built for *real apps*.
You get the same underlying power, but with an API that feels natural and production-ready.

### ✅ A quick comparison

| Feature                        | `amqplib`           | `coniglio` ✅          |
| ------------------------------ | ------------------- | --------------------- |
| Promise API                    | ⚠️ Basic (thenable) | ✅ Fully `async/await` |
| Manual reconnects              | ❌ You handle it     | ✅ Built-in            |
| Message streaming              | ❌ No                | ✅ `for await...of`    |
| Built-in JSON decoding         | ❌ Raw Buffer        | ✅ On by default       |
| Safe manual `ack()` / `nack()` | ✅ Yes               | ✅ Ergonomic handling  |
| Channel separation (pub/sub)   | ❌ Manual            | ✅ Automatic           |
| Backpressure-friendly          | ❌ Needs plumbing    | ✅ Native support      |
| TypeScript types               | ⚠️ Community        | ✅ First-class         |

> 🐇 *Coniglio* is Italian for “rabbit” — simple, fast, and alert.

```ts
for await (const msg of coniglio.listen('my-queue')) {
  try {
    await handle(msg.body)
    msg.ack()
  } catch (err) {
    msg.nack()
  }
}
```

## 📖 API

### `const conn = await coniglio(url, opts?)`

Creates a new connection instance.

```ts
const conn = await coniglio('amqp://localhost', {
  logger: console, // optional custom logger
  json: true,      // default: true (parse JSON messages)
  prefetch: 10,    // default: 10 (number of unacknowledged messages)
})
```

If you want to use a custom logger, it should implement the Logger interface:

```ts
export interface Logger {
  debug(...args: any[]): void
  info(...args: any[]): void
  warn(...args: any[]): void
  error(...args: any[]): void
}
```

Example with `pino`:

```js
import pino from 'pino'
const log = pino({ level: 'debug' })
const conn = await coniglio('amqp://localhost', { logger: log })
```

---

### `conn.listen(queue, opts?)`

Returns an async iterator of messages consumed from a queue.

```ts
interface ListenOptions {
  json?: boolean           // default: true (parse JSON)
  prefetch?: number        // default: 10
  routingKeys?: (keyof T)[] // optional filter, TypeScript-safe
}
```

Each yielded `msg: Message<T>` has:

```ts
interface Message<T> {
  raw: amqp.ConsumeMessage    // original AMQP message
  content: Buffer             // raw message body
  data?: T                    // parsed JSON if json = true
  contentIsJson: boolean      // true if JSON parsed successfully
  routingKey: string          // the routing key
}
```

#### JSON-enabled example

```js
for await (const msg of conn.listen('my-queue', { prefetch: 100 })) {
  // msg.data is parsed JSON
  if (msg.contentIsJson) {
    processData(msg.data)
  } else {
    // handle parsing error
    console.warn('Failed to parse JSON:', msg.content.toString())
  }
  conn.ack(msg)
}
```

#### JSON-opt-out example

```js
for await (const msg of conn.listen('my-queue', { json: false })) {
  // msg.data === undefined
  // use msg.content (Buffer) directly
  processRaw(msg.content)
  conn.ack(msg)
}
```

---

### `conn.ack(msg)` / `conn.nack(msg, requeue = false)`

Manually acknowledge or reject a message.

```js
conn.ack(msg)
conn.nack(msg, true) // requeue = true
```

---

### `conn.publish(exchange, routingKey, payload)`

Publish a message. Payload is serialized with `JSON.stringify` under the hood.

```js
await conn.publish('domain.events', 'user.created', { userId: '123' })
```

* **Retry**: on failure, retries indefinitely with exponential backoff + jitter (1s → 30s).
* **Confirm channel**: ensures broker receipt before resolving.

---

### `conn.configure({ queues, exchanges })`

Declare queues and exchanges explicitly. Useful for bootstrapping, tests, and dynamic setups.

```js
await conn.configure({
  exchanges: [
    { name: 'domain.events', type: 'topic', durable: true }
  ],
  queues: [
    {
      name: 'jobs.email',
      durable: true,
      bindTo: [{ exchange: 'domain.events', routingKey: 'jobs.email' }]
    }
  ]
})
```

```ts
interface ConfigureOptions {
  exchanges?: {
    name: string
    type: 'topic' | 'fanout' | 'direct' | 'headers'
    durable?: boolean
    autoDelete?: boolean
    internal?: boolean
    arguments?: Record<string, any>
  }[]
  queues?: {
    name: string
    durable?: boolean
    exclusive?: boolean
    autoDelete?: boolean
    deadLetterExchange?: string
    messageTtl?: number
    maxLength?: number
    arguments?: Record<string, any>
    bindTo?: {
      exchange: string
      routingKey: string
      arguments?: Record<string, any>
    }[]
  }[]
}
```

---

### `await conn.close()`

Gracefully close all channels and the underlying connection. Use this during application shutdown.

---

## 🧠 Philosophy

coniglio doesn’t manage your concurrency. It just delivers messages as an async generator. Use your favorite tool:

```ts
import pMap from 'p-map'

await pMap(
  conn.listen('jobs.video'),
  async msg => {
    await transcode(msg.data)
    conn.ack(msg)
  },
  { concurrency: 5 }
)
```

Or go reactive:

```ts
import { pipeline } from 'exstream'

await pipeline(
  conn.listen('metrics'),
  s => s.map(msg => parse(msg.data)),
  s => s.forEach(logMetric)
)
```

---

## 💪 Resilience by design

* Detects and recovers from connection or channel failures automatically
* Messages aren't lost or stuck unacknowledged
* Keeps the developer in control — no magic retries or swallowing errors

---

## ✅ Multiple connections

```ts
const prod = coniglio('amqp://prod-host')
const qa = coniglio('amqp://qa-host')

await prod.publish('events', 'prod.ready', { ok: true })
await qa.publish('events', 'qa.ready', { ok: true })
```

---

## 🧩 TypeScript Integration

If you are using TypeScript and want full type safety over your messages, you can pass a generic type map to `coniglio()`:

```ts
type RouteKeyMap = {
  'user.created': { userId: string }
  'invoice.sent': { invoiceId: string; total: number }
}

const r = await coniglio<RouteKeyMap>('amqp://localhost')

// Consume all events from a queue
for await (const msg of conn.listen('queue.main')) {
  switch (msg.event) {
    case 'user.created': {
      msg.data.userId // ✅ typed as string
      break
    }
    case 'invoice.sent': {
      msg.data.invoiceId // ✅ typed as string
      msg.data.total // ✅ typed as number
      break
    }
  }
}

// Or filter statically by known events (with narrow typing)
for await (const msg of conn.listen('queue.main', { routeKeys: ['user.created'] })) {
  msg.data.userId // ✅ typed as string
}
```

## 🏗️ Usage in Production Systems

Coniglio is designed to thrive in **real-world** setups with high message throughput and resilience requirements.

✔️ **Backpressure support**
Using native `for await...of`, you get natural backpressure without buffering hell.

✔️ **Controlled flow**
Acknowledge or retry only when you're ready — no leaking messages or auto-ack surprises.

✔️ **Crash-safe reconnect**
If RabbitMQ restarts, `coniglio` handles reconnection, re-initialization, and queue rebinds with zero config.

✔️ **Works in microservices & monoliths**
Use it in a Fastify server, a background worker, or a Kubernetes job — it's just an async iterator.

✔️ **Easy to observe and test**
You own the consumer loop. Add metrics, tracing, or mocks wherever you need — no magic, no black boxes.

---

## 🪄 Coming soon (planned)

* [ ] test suite with real RabbitMQ integration
* [ ] `conn.stream()` for full `ReadableStream` interop (with `AbortSignal`)
* [ ] Built-in metrics and logging hooks
* [ ] Retry helpers (e.g. DLQ support, customizable backoff)

---

## 📘 License

MIT — as simple and open as the API itself.
