import { EventEmitter } from 'node:events'
import type {
  Channel,
  ChannelModel,
  ConfirmChannel,
  ConsumeMessage,
  Options,
  Replies,
} from 'amqplib'
import type { ConnectionFactory } from '../../src/client'

export interface PublishedMessage {
  exchange: string
  routingKey: string
  body: Buffer
  options: Options.Publish
}

export interface NackedMessage {
  message: ConsumeMessage
  requeue: boolean
}

export interface AssertedQueue {
  name: string
  options: Options.AssertQueue | undefined
}

const consumeMessage = (
  routingKey: string,
  payload: Buffer,
  deliveryTag: number,
): ConsumeMessage => ({
  content: payload,
  fields: {
    consumerTag: 'fake-consumer',
    deliveryTag,
    redelivered: false,
    exchange: 'events',
    routingKey,
  },
  properties: {
    contentType: undefined,
    contentEncoding: undefined,
    headers: {},
    deliveryMode: undefined,
    priority: undefined,
    correlationId: undefined,
    replyTo: undefined,
    expiration: undefined,
    messageId: undefined,
    timestamp: undefined,
    type: undefined,
    userId: undefined,
    appId: undefined,
    clusterId: undefined,
  },
})

export class FakeChannel extends EventEmitter {
  readonly acked: ConsumeMessage[] = []
  readonly nacked: NackedMessage[] = []
  readonly operations: string[]
  consumerTag?: string
  queueName?: string
  delivery?: (message: ConsumeMessage | null) => void
  cancelCalls = 0
  closeCalls = 0
  closed = false

  constructor(
    readonly broker: FakeBroker,
    readonly connectionId: number,
    readonly kind: 'consumer' | 'publisher',
  ) {
    super()
    this.operations = broker.operations
  }

  async prefetch(count: number): Promise<Replies.Empty> {
    this.operations.push(`connection:${this.connectionId}:prefetch:${count}`)
    return {}
  }

  async consume(
    queue: string,
    callback: (message: ConsumeMessage | null) => void,
  ): Promise<Replies.Consume> {
    this.queueName = queue
    this.delivery = callback
    this.consumerTag = `consumer-${this.broker.nextConsumerTag++}`
    this.operations.push(`connection:${this.connectionId}:consume:${queue}`)
    return { consumerTag: this.consumerTag }
  }

  async cancel(consumerTag: string): Promise<Replies.Empty> {
    this.cancelCalls++
    this.operations.push(`connection:${this.connectionId}:cancel:${consumerTag}`)
    this.delivery = undefined
    return {}
  }

  ack(message: ConsumeMessage): void {
    if (this.closed) throw new Error('Channel is closed')
    this.acked.push(message)
  }

  nack(message: ConsumeMessage, _allUpTo = false, requeue = true): void {
    if (this.closed) throw new Error('Channel is closed')
    this.nacked.push({ message, requeue })
  }

  publish(
    exchange: string,
    routingKey: string,
    body: Buffer,
    options: Options.Publish,
    callback: (error: unknown, ok?: Replies.Empty) => void,
  ): boolean {
    if (this.closed) throw new Error('Channel is closed')

    this.broker.published.push({
      exchange,
      routingKey,
      body: Buffer.from(body),
      options,
    })

    const confirm = () => {
      if (options.mandatory && this.broker.unroutableRoutingKeys.has(routingKey)) {
        this.emit('return', {
          content: Buffer.from(body),
          fields: {
            deliveryTag: 0,
            redelivered: false,
            exchange,
            routingKey,
            replyCode: 312,
            replyText: 'NO_ROUTE',
          },
          properties: {
            contentType: options.contentType,
            contentEncoding: options.contentEncoding,
            headers: options.headers,
            deliveryMode: options.deliveryMode,
            priority: options.priority,
            correlationId: options.correlationId,
            replyTo: options.replyTo,
            expiration: options.expiration,
            messageId: options.messageId,
            timestamp: options.timestamp,
            type: options.type,
            userId: options.userId,
            appId: options.appId,
            clusterId: undefined,
          },
        })
      }

      if (this.broker.withholdConfirms) return

      const error =
        this.broker.confirmFailuresRemaining > 0
          ? new Error('Publisher confirm rejected')
          : undefined
      if (error) this.broker.confirmFailuresRemaining--

      callback(error ?? null, error ? undefined : {})
    }

    queueMicrotask(confirm)
    return true
  }

  async assertExchange(name: string, type: string): Promise<Replies.AssertExchange> {
    this.operations.push(`connection:${this.connectionId}:assertExchange:${name}:${type}`)
    return { exchange: name }
  }

  async assertQueue(name: string, options?: Options.AssertQueue): Promise<Replies.AssertQueue> {
    this.broker.assertedQueues.push({ name, options })
    this.operations.push(`connection:${this.connectionId}:assertQueue:${name}`)
    return {
      queue: name,
      messageCount: 0,
      consumerCount: 0,
    }
  }

  async bindQueue(queue: string, exchange: string, routingKey: string): Promise<Replies.Empty> {
    this.operations.push(`connection:${this.connectionId}:bind:${queue}:${exchange}:${routingKey}`)
    return {}
  }

  async close(): Promise<void> {
    this.closeCalls++
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }

  deliver(routingKey: string, payload: unknown, raw = false): ConsumeMessage {
    if (!this.delivery) throw new Error('Channel has no active consumer')
    const body = raw ? Buffer.from(String(payload)) : Buffer.from(JSON.stringify(payload))
    const message = consumeMessage(routingKey, body, this.broker.nextDeliveryTag++)
    this.delivery(message)
    return message
  }
}

export class FakeConnection extends EventEmitter {
  readonly publisher: FakeChannel
  readonly consumers: FakeChannel[] = []
  closeCalls = 0
  closed = false

  constructor(
    readonly broker: FakeBroker,
    readonly id: number,
  ) {
    super()
    this.publisher = new FakeChannel(broker, id, 'publisher')
  }

  async createConfirmChannel(): Promise<ConfirmChannel> {
    this.broker.operations.push(`connection:${this.id}:createPublisher`)
    return this.publisher as unknown as ConfirmChannel
  }

  async createChannel(): Promise<Channel> {
    const channel = new FakeChannel(this.broker, this.id, 'consumer')
    this.consumers.push(channel)
    this.broker.operations.push(`connection:${this.id}:createConsumer`)
    return channel as unknown as Channel
  }

  async close(): Promise<void> {
    this.closeCalls++
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }

  breakConnection(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }
}

export class FakeBroker {
  readonly connections: FakeConnection[] = []
  readonly operations: string[] = []
  readonly published: PublishedMessage[] = []
  readonly assertedQueues: AssertedQueue[] = []
  readonly unroutableRoutingKeys = new Set<string>()
  confirmFailuresRemaining = 0
  withholdConfirms = false
  connectFailuresRemaining = 0
  nextConsumerTag = 1
  nextDeliveryTag = 1

  readonly connect: ConnectionFactory = async () => {
    if (this.connectFailuresRemaining > 0) {
      this.connectFailuresRemaining--
      throw new Error('Connection refused')
    }

    const connection = new FakeConnection(this, this.connections.length + 1)
    this.connections.push(connection)
    this.operations.push(`connection:${connection.id}:connect`)
    return connection as unknown as ChannelModel
  }

  get latestConnection(): FakeConnection {
    const connection = this.connections.at(-1)
    if (!connection) throw new Error('No fake connection exists')
    return connection
  }

  get latestConsumer(): FakeChannel {
    const consumer = this.latestConnection.consumers.at(-1)
    if (!consumer) throw new Error('No fake consumer exists')
    return consumer
  }
}

export const waitFor = async (predicate: () => boolean, timeoutMs = 1000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}
