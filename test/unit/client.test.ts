import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ConiglioClient } from '../../src/client'
import {
  ConiglioClosedError,
  ConiglioMessageStateError,
  ConiglioPublishError,
  UnexpectedRoutingKeyError,
} from '../../src/errors'
import type { ConiglioEvent, Logger } from '../../src/types'
import { FakeBroker, waitFor } from '../helpers/fake-amqp'

type Events = {
  created: { id: string }
  text: string
  binary: Buffer
}

const silentLogger: Logger = {}

const createClient = async (
  broker: FakeBroker,
  options: ConstructorParameters<typeof ConiglioClient<Events>>[1] = {},
): Promise<ConiglioClient<Events>> => {
  const client = new ConiglioClient<Events>(
    'amqp://fake',
    {
      logger: silentLogger,
      reconnect: {
        initialDelayMs: 0,
        maxDelayMs: 0,
        maxAttempts: 5,
      },
      ...options,
    },
    broker.connect,
  )
  await client.initialize()
  return client
}

describe('ConiglioClient', () => {
  it('serializes JSON consistently and preserves raw Buffers', async () => {
    const broker = new FakeBroker()
    const client = await createClient(broker)

    await client.publish('', 'text', 'hello')
    await client.publish('', 'created', { id: '42' })
    await client.publish('', 'binary', Buffer.from([1, 2, 3]))

    assert.equal(broker.published[0]?.body.toString(), '"hello"')
    assert.equal(broker.published[0]?.options.contentType, 'application/json')
    assert.deepEqual(JSON.parse(broker.published[1]!.body.toString()), { id: '42' })
    assert.deepEqual(broker.published[2]?.body, Buffer.from([1, 2, 3]))
    assert.equal(broker.published[2]?.options.contentType, 'application/octet-stream')

    await client.close()
  })

  it('does not retry serialization errors', async () => {
    const broker = new FakeBroker()
    const client = await createClient(broker)
    const circular: Record<string, unknown> = {}
    circular.self = circular

    await assert.rejects(client.publish('', 'created', circular as Events['created']), TypeError)
    assert.equal(broker.published.length, 0)

    await client.close()
  })

  it('retries publisher confirms according to policy', async () => {
    const broker = new FakeBroker()
    const client = await createClient(broker)
    broker.confirmFailuresRemaining = 1

    await client.publish(
      '',
      'created',
      { id: 'retry' },
      {
        retry: {
          initialDelayMs: 0,
          maxDelayMs: 0,
          maxAttempts: 2,
        },
      },
    )
    assert.equal(broker.published.length, 2)

    broker.confirmFailuresRemaining = 1
    await assert.rejects(
      client.publish('', 'created', { id: 'once' }, { retry: false }),
      ConiglioPublishError,
    )
    assert.equal(broker.published.length, 3)

    await client.close()
  })

  it('times out and aborts publisher confirms', async () => {
    const broker = new FakeBroker()
    const client = await createClient(broker)
    broker.withholdConfirms = true

    await assert.rejects(
      client.publish(
        '',
        'created',
        { id: 'timeout' },
        {
          retry: false,
          confirmTimeoutMs: 5,
        },
      ),
      ConiglioPublishError,
    )

    const controller = new AbortController()
    const publishing = client.publish(
      '',
      'created',
      { id: 'abort' },
      {
        signal: controller.signal,
        confirmTimeoutMs: Infinity,
      },
    )
    controller.abort(new Error('stop publishing'))
    await assert.rejects(publishing, /stop publishing/)

    await client.close()
  })

  it('preserves zero-valued queue limits', async () => {
    const broker = new FakeBroker()
    const client = await createClient(broker)

    await client.configure({
      queues: [
        {
          name: 'zero-limits',
          messageTtl: 0,
          maxLength: 0,
        },
      ],
    })
    await client.configure({
      queues: [
        {
          name: 'jobs',
          durable: false,
          bindTo: [
            {
              exchange: 'events',
              routingKey: 'updated',
            },
          ],
        },
      ],
    })

    assert.deepEqual(broker.assertedQueues[0]?.options?.arguments, {
      'x-message-ttl': 0,
      'x-max-length': 0,
    })
    await client.close()
  })

  it('cancels the RabbitMQ consumer when iteration stops', async () => {
    const broker = new FakeBroker()
    const client = await createClient(broker)
    const iterator = client.listen('jobs')[Symbol.asyncIterator]()
    const pending = iterator.next()

    await waitFor(() => broker.latestConnection.consumers.length === 1)
    const consumer = broker.latestConsumer
    consumer.deliver('created', { id: '1' })
    const delivery = await pending
    assert.equal(delivery.done, false)
    if (!delivery.done) client.ack(delivery.value)

    await iterator.return(undefined)

    assert.equal(consumer.cancelCalls, 1)
    assert.equal(consumer.closed, true)
    await client.close()
  })

  it('exposes invalid JSON and json-disabled deliveries as raw', async () => {
    const broker = new FakeBroker()
    const client = await createClient(broker)

    const invalidIterator = client.listen('invalid')[Symbol.asyncIterator]()
    const invalidPending = invalidIterator.next()
    await waitFor(() => broker.latestConnection.consumers.length === 1)
    broker.latestConsumer.deliver('created', 'not-json', true)
    const invalid = await invalidPending
    assert.equal(invalid.done, false)
    if (!invalid.done) {
      assert.equal(invalid.value.contentIsJson, false)
      assert.equal(invalid.value.data, undefined)
      assert.equal(invalid.value.content.toString(), 'not-json')
      client.ack(invalid.value)
    }
    await invalidIterator.return(undefined)

    const rawIterator = client
      .listen('raw', {
        json: false,
      })
      [Symbol.asyncIterator]()
    const rawPending = rawIterator.next()
    await waitFor(
      () =>
        broker.latestConnection.consumers.length === 2 &&
        broker.latestConsumer.delivery !== undefined,
    )
    broker.latestConsumer.deliver('created', { id: 'still-raw' })
    const raw = await rawPending
    assert.equal(raw.done, false)
    if (!raw.done) {
      assert.equal(raw.value.contentIsJson, false)
      assert.equal(raw.value.data, undefined)
      client.ack(raw.value)
    }
    await rawIterator.return(undefined)
    await client.close()
  })

  it('replays topology and subscriptions after connection close', async () => {
    const broker = new FakeBroker()
    const client = await createClient(broker)

    await client.configure({
      exchanges: [{ name: 'events', type: 'topic', durable: false }],
      queues: [
        {
          name: 'jobs',
          durable: false,
          bindTo: [
            {
              exchange: 'events',
              routingKey: 'created',
            },
          ],
        },
      ],
    })

    const iterator = client.listen('jobs')[Symbol.asyncIterator]()
    const firstPending = iterator.next()
    await waitFor(() => broker.latestConnection.consumers.length === 1)
    broker.latestConsumer.deliver('created', { id: 'before' })
    const first = await firstPending
    assert.equal(first.done, false)
    if (!first.done) client.ack(first.value)

    broker.latestConnection.breakConnection()
    await waitFor(
      () => broker.connections.length === 2 && broker.latestConnection.consumers.length === 1,
    )

    const secondConnectionOperations = broker.operations.filter((operation) =>
      operation.startsWith('connection:2:'),
    )
    assert.ok(
      secondConnectionOperations.indexOf('connection:2:assertExchange:events:topic') <
        secondConnectionOperations.indexOf('connection:2:consume:jobs'),
    )
    assert.ok(
      secondConnectionOperations.indexOf('connection:2:bind:jobs:events:created') <
        secondConnectionOperations.indexOf('connection:2:consume:jobs'),
    )
    assert.ok(
      secondConnectionOperations.indexOf('connection:2:bind:jobs:events:updated') <
        secondConnectionOperations.indexOf('connection:2:consume:jobs'),
    )

    const secondPending = iterator.next()
    broker.latestConsumer.deliver('created', { id: 'after' })
    const second = await secondPending
    assert.equal(second.done, false)
    if (!second.done) {
      assert.deepEqual(second.value.data, { id: 'after' })
      client.ack(second.value)
    }

    await iterator.return(undefined)
    await client.close()
  })

  it('reconnects when a consumer channel closes', async () => {
    const broker = new FakeBroker()
    const client = await createClient(broker)
    const iterator = client.listen('jobs')[Symbol.asyncIterator]()
    const firstPending = iterator.next()

    await waitFor(() => broker.latestConnection.consumers.length === 1)
    const firstConsumer = broker.latestConsumer
    await firstConsumer.close()
    await waitFor(
      () => broker.connections.length === 2 && broker.latestConnection.consumers.length === 1,
    )

    assert.equal(broker.connections.length, 2)
    const recoveredConsumer = broker.latestConsumer
    recoveredConsumer.deliver('created', { id: 'recovered' })
    const delivery = await firstPending
    assert.equal(delivery.done, false)
    if (!delivery.done) {
      assert.deepEqual(delivery.value.data, { id: 'recovered' })
      client.ack(delivery.value)
    }

    await iterator.return(undefined)
    await client.close()
  })

  it('reconnects when the publisher channel closes', async () => {
    const broker = new FakeBroker()
    const client = await createClient(broker)

    await broker.latestConnection.publisher.close()
    await waitFor(() => broker.connections.length === 2)
    await client.publish('', 'created', { id: 'after-publisher-close' })

    assert.equal(broker.published.at(-1)?.body.toString(), '{"id":"after-publisher-close"}')
    await client.close()
  })

  it('exposes lifecycle state and typed observability events', async () => {
    const broker = new FakeBroker()
    const events: ConiglioEvent[] = []
    const client = await createClient(broker, {
      onEvent: (event) => events.push(event),
    })

    assert.equal(client.state, 'ready')
    broker.confirmFailuresRemaining = 1
    await client.publish(
      '',
      'created',
      { id: 'observed' },
      {
        retry: {
          initialDelayMs: 0,
          maxDelayMs: 0,
          maxAttempts: 2,
        },
      },
    )

    const iterator = client.listen('jobs')[Symbol.asyncIterator]()
    const pending = iterator.next()
    await waitFor(() => broker.latestConnection.consumers.length === 1)
    broker.latestConsumer.deliver('created', { id: 'observed' })
    const delivery = await pending
    if (!delivery.done) client.ack(delivery.value)
    await iterator.return(undefined)

    broker.connectFailuresRemaining = 1
    broker.latestConnection.breakConnection()
    await waitFor(() => broker.connections.length === 2)
    await client.close()

    assert.equal(client.state, 'closed')
    const eventTypes = events.map((event) => event.type)
    assert.ok(eventTypes.includes('publish-retry'))
    assert.ok(eventTypes.includes('publish-confirmed'))
    assert.ok(eventTypes.includes('consumer-ready'))
    assert.ok(eventTypes.includes('consumer-cancelled'))
    assert.ok(eventTypes.includes('connection-retry'))
    assert.ok(events.some((event) => event.type === 'state' && event.state === 'reconnecting'))
    assert.ok(events.some((event) => event.type === 'state' && event.state === 'closed'))
  })

  it('rejects acknowledgements from a stale delivery channel', async () => {
    const broker = new FakeBroker()
    const client = await createClient(broker)
    const iterator = client.listen('jobs')[Symbol.asyncIterator]()
    const pending = iterator.next()

    await waitFor(() => broker.latestConnection.consumers.length === 1)
    broker.latestConsumer.deliver('created', { id: 'stale' })
    const delivery = await pending
    assert.equal(delivery.done, false)

    broker.latestConnection.breakConnection()
    await waitFor(() => broker.connections.length === 2)

    if (!delivery.done) {
      assert.throws(() => client.ack(delivery.value), ConiglioMessageStateError)
    }

    await iterator.return(undefined)
    await client.close()
  })

  it('requeues and surfaces an unexpected routing key', async () => {
    const broker = new FakeBroker()
    const client = await createClient(broker)
    const iterator = client
      .listen('jobs', {
        routingKeys: ['created'],
      })
      [Symbol.asyncIterator]()
    const pending = iterator.next()

    await waitFor(() => broker.latestConnection.consumers.length === 1)
    const consumer = broker.latestConsumer
    consumer.deliver('other', { id: 'wrong' })

    await assert.rejects(pending, UnexpectedRoutingKeyError)
    assert.equal(consumer.nacked.length, 1)
    assert.equal(consumer.nacked[0]?.requeue, true)
    assert.equal(consumer.cancelCalls, 1)

    await client.close()
  })

  it('aborts a pending listener and cancels its consumer', async () => {
    const broker = new FakeBroker()
    const client = await createClient(broker)
    const controller = new AbortController()
    const iterator = client
      .listen('jobs', {
        signal: controller.signal,
      })
      [Symbol.asyncIterator]()
    const pending = iterator.next()

    await waitFor(() => broker.latestConnection.consumers.length === 1)
    const consumer = broker.latestConsumer
    controller.abort(new Error('stop listening'))

    await assert.rejects(pending, /stop listening/)
    await waitFor(() => consumer.cancelCalls === 1)
    await client.close()
  })

  it('stops reconnect attempts when closed', async () => {
    const broker = new FakeBroker()
    const client = await createClient(broker, {
      reconnect: {
        initialDelayMs: 100,
        maxDelayMs: 100,
        maxAttempts: Infinity,
      },
    })

    broker.connectFailuresRemaining = 100
    broker.latestConnection.breakConnection()
    await waitFor(() => broker.connectFailuresRemaining < 100)

    await client.close()
    const attemptsAfterClose = broker.connectFailuresRemaining
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(broker.connectFailuresRemaining, attemptsAfterClose)
    await client.close()

    await assert.rejects(client.publish('', 'created', { id: 'closed' }), ConiglioClosedError)
  })
})
