import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import amqplib, { type ChannelModel } from 'amqplib'
import coniglio from '../../src'
import { ConiglioClosedError } from '../../src/errors'

type Events = {
  created: { id: string }
  text: string
}

const waitFor = async (
  predicate: () => Promise<boolean>,
  timeoutMs = 5000
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for RabbitMQ state')
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

const within = async <T> (
  promise: Promise<T>,
  label: string,
  timeoutMs = 5000
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Timed out during ${label}`))
        }, timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describe('RabbitMQ integration', () => {
  it('publishes, consumes, cancels and recovers an exclusive topology', {
    timeout: 20000
  }, async () => {
    const suffix = `${process.pid}-${randomUUID()}`
    const exchange = `coniglio.integration.events.${suffix}`
    const queue = `coniglio.integration.queue.${suffix}`
    const exclusiveQueue = `coniglio.integration.exclusive.${suffix}`

    const adminConnection = await amqplib.connect('amqp://localhost')
    const admin = await adminConnection.createChannel()
    const client = await coniglio<Events>('amqp://localhost', {
      logger: {},
      reconnect: {
        initialDelayMs: 10,
        maxDelayMs: 50,
        maxAttempts: 20
      },
      publish: {
        confirmTimeoutMs: 2000,
        retry: {
          initialDelayMs: 10,
          maxDelayMs: 50,
          maxAttempts: 20
        }
      }
    })
    let stage = 'initial topology configuration'

    try {
      await within(client.configure({
        exchanges: [
          {
            name: exchange,
            type: 'topic',
            durable: false,
            autoDelete: true
          }
        ],
        queues: [
          {
            name: queue,
            durable: true,
            autoDelete: false,
            bindTo: [
              { exchange, routingKey: 'text' }
            ]
          }
        ]
      }), stage)

      stage = 'first consumer startup'
      const iterator = client.listen(queue, {
        routingKeys: ['text']
      })[Symbol.asyncIterator]()
      const firstPending = iterator.next()

      await waitFor(async () => {
        const status = await admin.checkQueue(queue)
        return status.consumerCount === 1
      })

      stage = 'JSON string publish and delivery'
      await within(client.publish(exchange, 'text', 'hello'), stage)
      const first = await within(firstPending, stage)
      assert.equal(first.done, false)
      if (!first.done) {
        assert.equal(first.value.contentIsJson, true)
        assert.equal(first.value.data, 'hello')
        client.ack(first.value)
      }

      stage = 'consumer cancellation'
      await within(iterator.return(undefined), stage)
      await waitFor(async () => {
        const status = await admin.checkQueue(queue)
        return status.consumerCount === 0
      })

      stage = 'exclusive topology configuration'
      await within(client.configure({
        queues: [
          {
            name: exclusiveQueue,
            durable: false,
            exclusive: true,
            autoDelete: true,
            bindTo: [
              { exchange, routingKey: 'created' }
            ]
          }
        ]
      }), stage)

      stage = 'exclusive consumer startup'
      const recoveringIterator = client.listen(exclusiveQueue, {
        routingKeys: ['created']
      })[Symbol.asyncIterator]()
      const recoveredPending = recoveringIterator.next()

      await waitFor(async () => {
        const subscriptions = (
          client as unknown as {
            subscriptions: Set<{
              queueName: string
              consumerTag?: string
            }>
          }
        ).subscriptions
        return [...subscriptions].some(
          subscription =>
            subscription.queueName === exclusiveQueue &&
            subscription.consumerTag !== undefined
        )
      })

      stage = 'forced connection close'
      const originalConnection = (
        client as unknown as { connection: ChannelModel }
      ).connection
      await within(originalConnection.close(), stage)

      stage = 'publish and delivery after reconnect'
      await within(
        client.publish(exchange, 'created', { id: 'after-reconnect' }),
        stage
      )
      const recovered = await within(recoveredPending, stage)
      assert.equal(recovered.done, false)
      if (!recovered.done) {
        assert.equal(recovered.value.contentIsJson, true)
        assert.deepEqual(
          recovered.value.data,
          { id: 'after-reconnect' }
        )
        client.ack(recovered.value)
      }

      stage = 'final consumer shutdown'
      await within(recoveringIterator.return(undefined), stage)
      stage = 'final client shutdown'
      await within(client.close(), stage)

      await assert.rejects(
        client.publish(exchange, 'created', { id: 'closed' }),
        ConiglioClosedError
      )
    } catch (error) {
      throw new Error(
        `RabbitMQ integration failed during ${stage}`,
        { cause: error }
      )
    } finally {
      await within(client.close(), 'cleanup client close').catch(() => {})
      await admin.deleteQueue(queue).catch(() => {})
      await admin.deleteExchange(exchange).catch(() => {})
      await admin.close().catch(() => {})
      await adminConnection.close().catch(() => {})
    }
  })
})
