import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { mock, test } from 'node:test'
import { pathToFileURL } from 'node:url'

let currentConnection
const require = createRequire(import.meta.url)
const amqplibUrl = pathToFileURL(require.resolve('amqplib')).href

mock.module(amqplibUrl, {
  exports: {
    default: {
      connect: async () => currentConnection,
    },
  },
})

const {
  default: coniglio,
  ConiglioPublishTimeoutError,
  ConiglioUnroutableError,
} = await import('../../lib/index.mjs')

const transport = ({ returnMandatory = false, skipConfirm = false } = {}) => {
  const publications = []
  const channel = Object.assign(new EventEmitter(), {
    close: async () => undefined,
    publish(exchange, routingKey, content, properties, confirmed) {
      publications.push({ content, exchange, properties, routingKey })
      if (returnMandatory && properties.mandatory) {
        channel.emit('return', {
          content,
          fields: {
            exchange,
            replyCode: 312,
            replyText: 'NO_ROUTE',
            routingKey,
          },
          properties,
        })
      }
      if (!skipConfirm) confirmed(null)
      return true
    },
  })
  currentConnection = Object.assign(new EventEmitter(), {
    close: async () => undefined,
    createConfirmChannel: async () => channel,
  })
  return { publications }
}

test('compiled package rejects a returned mandatory publish', async () => {
  const { publications } = transport({ returnMandatory: true, skipConfirm: true })
  const rabbit = await coniglio('amqp://rabbit.test', {
    logger: {},
    publish: { retry: false },
  })

  await assert.rejects(
    rabbit.publish(
      'domain.events',
      'missing.route',
      { id: 'event-1' },
      { mandatory: true, messageId: 'event-1' },
    ),
    (error) => {
      assert.ok(error instanceof ConiglioUnroutableError)
      assert.equal(error.exchange, 'domain.events')
      assert.equal(error.routingKey, 'missing.route')
      assert.equal(error.messageId, 'event-1')
      assert.equal(error.replyCode, 312)
      assert.equal(error.replyText, 'NO_ROUTE')
      return true
    },
  )
  assert.equal(publications.length, 1)
  assert.equal(publications[0].properties.messageId, 'event-1')
  await rabbit.close()
})

test('compiled package exposes one timeout when publish retry is disabled', async () => {
  const { publications } = transport({ skipConfirm: true })
  const rabbit = await coniglio('amqp://rabbit.test', {
    logger: {},
    publish: { confirmTimeoutMs: 5, retry: false },
  })

  await assert.rejects(
    rabbit.publish('domain.events', 'slow.route', { id: 'event-1' }),
    (error) => {
      assert.ok(error instanceof ConiglioPublishTimeoutError)
      assert.equal(error.routingKey, 'slow.route')
      assert.equal(error.timeoutMs, 5)
      return true
    },
  )
  assert.equal(publications.length, 1)
  await rabbit.close()
})
