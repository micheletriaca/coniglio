import ampqlib, { Channel, ChannelModel, ConfirmChannel, ConsumeMessage } from 'amqplib'
import { ConiglioInstance, RoutingKeyMap, Message, Logger } from '../types'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const getExpSleeper = (base: number, max: number) => {
  let current = base
  return async () => {
    const min = current / 2
    const jittered = Math.random() * (current - min) + min
    const delay = Math.min(jittered, max)
    await sleep(delay)
    current = Math.min(current * 2, max)
  }
}

function safeJson (buf: Buffer): any {
  try {
    return JSON.parse(buf.toString())
  } catch {
    return undefined
  }
}

const cleanup = (
  conn: ChannelModel | null,
  channels: { consumer?: Channel; publisher?: ConfirmChannel } = {}
) => {
  if (!conn) return
  conn.removeAllListeners('error')
  conn.removeAllListeners('close')
  channels.consumer?.removeAllListeners('error')
  channels.publisher?.removeAllListeners('error')
  channels.consumer?.close().catch(() => {})
  channels.publisher?.close().catch(() => {})
  conn?.close().catch(() => {})
}

export default async function coniglio<T extends RoutingKeyMap> (
  url: string,
  opts?: { logger?: Logger }
): Promise<ConiglioInstance<T>> {
  let conn: ChannelModel
  let loginInProgress: Promise<void> | null = null
  let expSleeperPublisher = getExpSleeper(1000, 30000)

  const logger: Logger = opts?.logger ?? {
    log: console.log,
    debug: console.debug,
    info: console.info,
    warn: console.warn,
    error: console.error
  }

  const channels: {
    consumer?: Channel;
    publisher?: ConfirmChannel;
  } = {}

  const login = async () => {
    if (loginInProgress) return loginInProgress
    loginInProgress = (async () => {
      const expSleeper = getExpSleeper(1000, 30000)
      while (true) {
        try {
          cleanup(conn, channels)
          conn = await ampqlib.connect(url)
          conn.once('error', (err) => logger.error('[🐰] connection error', err))
          conn.once('close', async () => {
            logger.warn('[🐰] connection closed. Attempting to reconnect...')
            await expSleeper()
            await login()
          })
          channels.consumer = await conn.createChannel()
          channels.consumer.once('error', (err) => logger.error('[🐰] consumer channel error', err))
          channels.publisher = await conn.createConfirmChannel()
          channels.publisher.once('error', (err) => logger.error('[🐰] publisher channel error', err))
          expSleeperPublisher = getExpSleeper(1000, 30000)
          loginInProgress = null
          return
        } catch (err) {
          logger.error('[🐰] connection error')
          await expSleeper()
        }
      }
    })()
    return loginInProgress
  }

  await login()

  async function * consumeGenerator (queue: string, prefetch: number) {
    const buffer: ConsumeMessage[] = []
    let notify: () => void = () => { }
    const ready = () => new Promise<void>(resolve => (notify = resolve))

    const startConsumer = async () => {
      await channels.consumer!.prefetch(prefetch)
      buffer.length = 0
      conn.once('error', async () => {
        await login()
        await startConsumer()
      })
      channels.consumer!.consume(queue, msg => {
        if (!msg) return
        buffer.push(msg)
        notify()
      }, { noAck: false })
    }

    await startConsumer()

    while (true) {
      while (buffer.length > 0) {
        yield buffer.shift()!
      }
      await ready()
    }
  }

  const instance: ConiglioInstance<T> = {

    async * listen (queue, opts) {
      const json = opts?.json !== false
      const prefetch = opts?.prefetch ?? 10
      const routingKeys = opts?.routingKeys

      for await (const msg of consumeGenerator(queue, prefetch)) {
        if (!msg) continue

        const content = msg.content
        const parsed = json ? safeJson(content) : undefined
        const routingKey = msg.fields.routingKey

        if (routingKeys && !routingKeys.includes(routingKey as any)) {
          channels.consumer!.nack(msg, false, false)
          continue
        }

        yield { raw: msg, content, data: parsed, contentIsJson: parsed !== undefined, routingKey } as Message<T>
      }
    },

    ack (msg) {
      channels.consumer!.ack(msg.raw)
    },

    nack (msg, requeue = false) {
      channels.consumer!.nack(msg.raw, false, requeue)
    },

    async publish (exchange, routingKey, payload) {
      while (true) {
        try {
          const channel = channels.publisher!
          const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
          await new Promise<void>((resolve, reject) => {
            channel.publish(exchange, routingKey, Buffer.from(body), {}, (err) => {
              if (err) reject(err)
              else resolve()
            })
          })
          return
        } catch (err) {
          logger.error('[🐰] publish error', err)
          await expSleeperPublisher()
          await login()
        }
      }
    },

    async configure ({ exchanges = [], queues = [] }) {
      const channel = channels.publisher!

      for (const ex of exchanges) {
        await channel.assertExchange(ex.name, ex.type, {
          durable: ex.durable,
          autoDelete: ex.autoDelete,
          internal: ex.internal,
          arguments: ex.arguments
        })
      }

      for (const q of queues) {
        await channel.assertQueue(q.name, {
          durable: q.durable,
          exclusive: q.exclusive,
          autoDelete: q.autoDelete,
          arguments: {
            ...q.arguments,
            ...(q.deadLetterExchange ? { 'x-dead-letter-exchange': q.deadLetterExchange } : {}),
            ...(q.messageTtl ? { 'x-message-ttl': q.messageTtl } : {}),
            ...(q.maxLength ? { 'x-max-length': q.maxLength } : {})
          }
        })
        for (const bind of q.bindTo || []) {
          await channel.bindQueue(q.name, bind.exchange, bind.routingKey, bind.arguments)
        }
      }
    }
  }

  return instance
}
