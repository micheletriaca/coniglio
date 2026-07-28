import type {
  Channel,
  ChannelModel,
  ConfirmChannel,
  ConsumeMessage
} from 'amqplib'
import { AsyncQueue } from './async-queue'
import {
  ConiglioClosedError,
  ConiglioConnectionError,
  ConiglioMessageStateError,
  ConiglioPublishError,
  UnexpectedRoutingKeyError
} from './errors'
import {
  abortableDelay,
  backoffDelay,
  normalizeRetryOptions,
  throwIfAborted,
  type NormalizedRetryOptions
} from './retry'
import type {
  ConfigureOptions,
  ConiglioEvent,
  ConiglioInstance,
  ConiglioLifecycleState,
  ConiglioOptions,
  ExchangeConfiguration,
  ListenOptions,
  Logger,
  Message,
  PublishOptions,
  QueueConfiguration,
  RoutingKeyMap
} from './types'

export type ConnectionFactory = (
  url: string,
  socketOptions?: unknown
) => Promise<ChannelModel>

interface Subscription {
  queueName: string
  json: boolean
  prefetch: number
  routingKeys?: readonly string[]
  signal?: AbortSignal
  signalHandler?: () => void
  messages: AsyncQueue<ConsumeMessage>
  channel?: Channel
  consumerTag?: string
  generation?: number
  startPromise?: Promise<void>
  recoveryPromise?: Promise<void>
  closePromise?: Promise<void>
  closed: boolean
}

const DEFAULT_RETRY: NormalizedRetryOptions = {
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  maxAttempts: Infinity
}

const DEFAULT_CONFIRM_TIMEOUT_MS = 30000

const cloneExchange = (
  exchange: ExchangeConfiguration
): ExchangeConfiguration => ({
  ...exchange,
  arguments: exchange.arguments ? { ...exchange.arguments } : undefined
})

const cloneQueue = (queue: QueueConfiguration): QueueConfiguration => ({
  ...queue,
  arguments: queue.arguments ? { ...queue.arguments } : undefined,
  bindTo: queue.bindTo?.map(binding => ({
    ...binding,
    arguments: binding.arguments ? { ...binding.arguments } : undefined
  }))
})

const serialize = (payload: unknown): {
  body: Buffer
  contentType: string
} => {
  if (Buffer.isBuffer(payload)) {
    return {
      body: payload,
      contentType: 'application/octet-stream'
    }
  }

  const encoded = JSON.stringify(payload)
  if (encoded === undefined) {
    throw new TypeError('The publish payload cannot be serialized as JSON')
  }

  return {
    body: Buffer.from(encoded),
    contentType: 'application/json'
  }
}

const abortReason = (signal: AbortSignal): Error => {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError')
}

export class ConiglioClient<
  T extends RoutingKeyMap = Record<string, unknown>
> implements ConiglioInstance<T> {
  private readonly logger: Logger
  private readonly reconnectOptions: NormalizedRetryOptions
  private readonly lifecycle = new AbortController()
  private readonly subscriptions = new Set<Subscription>()
  private readonly deliveryChannels = new WeakMap<ConsumeMessage, Channel>()
  private readonly activeConsumerChannels = new Set<Channel>()
  private readonly exchanges = new Map<string, ExchangeConfiguration>()
  private readonly queues = new Map<string, QueueConfiguration>()

  private connection?: ChannelModel
  private publisher?: ConfirmChannel
  private generation = 0
  private connecting?: Promise<void>
  private configurationTail: Promise<void> = Promise.resolve()
  private closePromise?: Promise<void>
  private closed = false
  private lifecycleState: ConiglioLifecycleState = 'idle'
  private externalSignalHandler?: () => void

  constructor (
    private readonly url: string,
    private readonly options: ConiglioOptions,
    private readonly connect: ConnectionFactory
  ) {
    this.logger = options.logger ?? console
    this.reconnectOptions = normalizeRetryOptions(
      options.reconnect,
      DEFAULT_RETRY
    )

    if (
      options.prefetch !== undefined &&
      (!Number.isInteger(options.prefetch) || options.prefetch < 1)
    ) {
      throw new RangeError('prefetch must be a positive integer')
    }
  }

  async initialize (): Promise<void> {
    if (this.options.signal?.aborted) {
      await this.close()
      throw abortReason(this.options.signal)
    }

    if (this.options.signal) {
      this.externalSignalHandler = () => {
        this.close().catch(error => {
          this.log('error', '[coniglio] abort-driven close failed', error)
        })
      }
      this.options.signal.addEventListener(
        'abort',
        this.externalSignalHandler,
        { once: true }
      )
    }

    try {
      await this.ensureConnected()
    } catch (error) {
      await this.close()
      throw error
    }
  }

  get state (): ConiglioLifecycleState {
    return this.lifecycleState
  }

  async * listen<K extends keyof T & string = keyof T & string> (
    queue: string,
    options: ListenOptions<K> = {}
  ): AsyncGenerator<Message<T, K>> {
    this.assertOpen()

    const prefetch = options.prefetch ?? this.options.prefetch ?? 10
    if (!Number.isInteger(prefetch) || prefetch < 1) {
      throw new RangeError('prefetch must be a positive integer')
    }
    if (options.signal?.aborted) throw abortReason(options.signal)

    const subscription: Subscription = {
      queueName: queue,
      json: options.json ?? this.options.json ?? true,
      prefetch,
      routingKeys: options.routingKeys,
      signal: options.signal,
      messages: new AsyncQueue<ConsumeMessage>(),
      closed: false
    }

    if (options.signal) {
      subscription.signalHandler = () => {
        subscription.messages.finish(
          abortReason(options.signal!),
          message => this.deliveryChannels.delete(message)
        )
      }
      options.signal.addEventListener(
        'abort',
        subscription.signalHandler,
        { once: true }
      )
    }

    this.subscriptions.add(subscription)

    try {
      await this.ensureConnected()
      await this.ensureSubscriptionOnCurrentTransport(subscription)

      while (true) {
        const next = await subscription.messages.next()
        if (next.done) return

        const raw = next.value
        const routingKey = raw.fields.routingKey

        if (
          subscription.routingKeys &&
          !subscription.routingKeys.includes(routingKey)
        ) {
          this.nackRaw(raw, true)
          throw new UnexpectedRoutingKeyError(
            queue,
            routingKey,
            subscription.routingKeys
          )
        }

        const base = {
          raw,
          content: raw.content,
          routingKey
        }

        if (subscription.json) {
          let parsed: unknown
          let contentIsJson = false
          try {
            parsed = JSON.parse(raw.content.toString())
            contentIsJson = true
          } catch {
            // Invalid JSON is exposed as a raw delivery.
          }

          if (contentIsJson) {
            yield {
              ...base,
              contentIsJson: true,
              data: parsed
            } as Message<T, K>
            continue
          }
        }

        yield {
          ...base,
          contentIsJson: false,
          data: undefined
        } as Message<T, K>
      }
    } finally {
      await this.unregisterSubscription(subscription)
    }
  }

  ack<K extends keyof T & string> (message: Message<T, K>): void {
    const channel = this.getActiveDeliveryChannel(message.raw)
    channel.ack(message.raw)
    this.deliveryChannels.delete(message.raw)
  }

  nack<K extends keyof T & string> (
    message: Message<T, K>,
    requeue = false
  ): void {
    this.nackRaw(message.raw, requeue)
  }

  async publish<K extends keyof T & string> (
    exchange: string,
    routingKey: K,
    payload: T[K],
    options: PublishOptions = {}
  ): Promise<void> {
    this.assertOpen()

    const { body, contentType } = serialize(payload)
    const {
      retry,
      signal,
      confirmTimeoutMs = this.options.publish?.confirmTimeoutMs ??
        DEFAULT_CONFIRM_TIMEOUT_MS,
      ...amqpOptions
    } = options

    if (
      confirmTimeoutMs !== Infinity &&
      (!Number.isFinite(confirmTimeoutMs) || confirmTimeoutMs <= 0)
    ) {
      throw new RangeError('confirmTimeoutMs must be a positive number or Infinity')
    }

    const configuredRetry = retry ?? this.options.publish?.retry
    const retryOptions = normalizeRetryOptions(
      configuredRetry === false
        ? { initialDelayMs: 0, maxDelayMs: 0, maxAttempts: 1 }
        : configuredRetry,
      DEFAULT_RETRY
    )
    const operationSignal = signal
      ? AbortSignal.any([signal, this.lifecycle.signal])
      : this.lifecycle.signal

    throwIfAborted(operationSignal)

    for (let attempt = 1; ; attempt++) {
      try {
        await this.ensureConnected()
        throwIfAborted(operationSignal)

        const channel = this.publisher
        if (!channel) {
          throw new ConiglioConnectionError('Publisher channel is unavailable')
        }

        await this.publishAndConfirm(
          channel,
          exchange,
          routingKey,
          body,
          {
            ...amqpOptions,
            contentType: amqpOptions.contentType ?? contentType
          },
          confirmTimeoutMs,
          operationSignal
        )
        this.emitEvent({
          type: 'publish-confirmed',
          exchange,
          routingKey,
          attempt
        })
        return
      } catch (error) {
        if (operationSignal.aborted) throw abortReason(operationSignal)
        if (attempt >= retryOptions.maxAttempts) {
          throw new ConiglioPublishError(
            `Publishing "${routingKey}" failed after ${attempt} attempt${attempt === 1 ? '' : 's'}`,
            error
          )
        }

        const delayMs = backoffDelay(attempt, retryOptions)
        this.emitEvent({
          type: 'publish-retry',
          exchange,
          routingKey,
          attempt,
          delayMs,
          error
        })
        this.log(
          'warn',
          `[coniglio] publish failed for "${routingKey}", retrying`,
          error
        )
        await abortableDelay(delayMs, operationSignal)
      }
    }
  }

  async configure (options: ConfigureOptions): Promise<void> {
    this.assertOpen()

    const operation = this.configurationTail.then(async () => {
      await this.ensureConnected()
      const channel = this.publisher
      if (!channel) {
        throw new ConiglioConnectionError('Publisher channel is unavailable')
      }

      await this.applyConfiguration(channel, options)
      this.rememberConfiguration(options)
    })

    this.configurationTail = operation.catch(() => {})
    await operation
  }

  async close (): Promise<void> {
    if (this.closePromise) return await this.closePromise
    this.closePromise = this.performClose()
    return await this.closePromise
  }

  private async performClose (): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.setState('closing')
    this.lifecycle.abort(new ConiglioClosedError())

    if (this.options.signal && this.externalSignalHandler) {
      this.options.signal.removeEventListener(
        'abort',
        this.externalSignalHandler
      )
    }

    await Promise.all(
      [...this.subscriptions].map(async subscription => {
        await this.unregisterSubscription(subscription)
      })
    )

    const connection = this.connection
    const publisher = this.publisher
    this.connection = undefined
    this.publisher = undefined
    this.generation++

    await this.disposeTransport(connection, publisher, [])

    if (this.connecting) {
      await this.connecting.catch(() => {})
    }

    this.setState('closed')
    this.log('debug', '[coniglio] client closed')
  }

  private assertOpen (): void {
    if (this.closed) throw new ConiglioClosedError()
  }

  private log (
    level: 'debug' | 'info' | 'warn' | 'error',
    ...args: unknown[]
  ): void {
    try {
      this.logger[level]?.(...args)
    } catch {
      // Logging must never affect message delivery.
    }
  }

  private emitEvent (event: ConiglioEvent): void {
    try {
      this.options.onEvent?.(event)
    } catch {
      // Instrumentation must never affect message delivery.
    }
  }

  private setState (
    state: ConiglioLifecycleState,
    reason?: string
  ): void {
    if (this.lifecycleState === state && reason === undefined) return
    this.lifecycleState = state
    this.emitEvent({
      type: 'state',
      state,
      ...(reason === undefined ? {} : { reason })
    })
  }

  private async ensureConnected (): Promise<void> {
    this.assertOpen()
    if (this.connection && this.publisher) return

    if (!this.connecting) {
      this.setState(
        this.generation === 0 ? 'connecting' : 'reconnecting'
      )
      this.connecting = this.connectLoop()
    }

    const current = this.connecting
    try {
      await current
    } finally {
      if (this.connecting === current) this.connecting = undefined
    }
  }

  private async connectLoop (): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      this.assertOpen()
      let connection: ChannelModel | undefined
      let publisher: ConfirmChannel | undefined
      let generation: number | undefined

      try {
        connection = await this.connect(this.url, this.options.socketOptions)
        this.assertOpen()
        publisher = await connection.createConfirmChannel()
        this.assertOpen()

        generation = ++this.generation
        this.connection = connection
        this.publisher = publisher
        this.attachTransportListeners(connection, publisher, generation)

        await this.applyStoredTopology(publisher)

        for (const subscription of [...this.subscriptions]) {
          if (!subscription.closed) {
            await this.startSubscriptionOn(
              subscription,
              connection,
              generation
            )
          }
        }

        if (
          this.connection !== connection ||
          this.publisher !== publisher ||
          this.generation !== generation
        ) {
          throw new ConiglioConnectionError(
            'Connection closed while recovery was in progress'
          )
        }

        this.setState('ready')
        this.log('info', '[coniglio] connection ready')
        return
      } catch (error) {
        await this.discardTransportAttempt(
          connection,
          publisher,
          generation
        )

        if (this.closed) throw new ConiglioClosedError()
        if (attempt >= this.reconnectOptions.maxAttempts) {
          const failure = new ConiglioConnectionError(
            `Connecting to RabbitMQ failed after ${attempt} attempt${attempt === 1 ? '' : 's'}`,
            error
          )
          this.setState('disconnected', 'retry budget exhausted')
          this.failSubscriptions(failure)
          throw failure
        }

        const delayMs = backoffDelay(
          attempt,
          this.reconnectOptions
        )
        this.emitEvent({
          type: 'connection-retry',
          attempt,
          delayMs,
          error
        })
        this.log(
          'warn',
          `[coniglio] connection attempt ${attempt} failed, retrying`,
          error
        )
        await abortableDelay(delayMs, this.lifecycle.signal)
      }
    }
  }

  private attachTransportListeners (
    connection: ChannelModel,
    publisher: ConfirmChannel,
    generation: number
  ): void {
    connection.on('error', error => {
      this.log('error', '[coniglio] connection error', error)
    })
    connection.once('close', () => {
      this.handleTransportLost(connection, generation, 'connection closed')
    })

    publisher.on('error', error => {
      this.log('error', '[coniglio] publisher channel error', error)
    })
    publisher.once('close', () => {
      this.handleTransportLost(
        connection,
        generation,
        'publisher channel closed'
      )
    })
  }

  private handleTransportLost (
    connection: ChannelModel,
    generation: number,
    reason: string
  ): void {
    if (
      this.closed ||
      this.connection !== connection ||
      this.generation !== generation
    ) {
      return
    }

    this.setState('reconnecting', reason)
    this.log('warn', `[coniglio] ${reason}; reconnecting`)

    const publisher = this.publisher
    const consumerChannels: Channel[] = []
    this.connection = undefined
    this.publisher = undefined

    for (const subscription of this.subscriptions) {
      if (
        subscription.channel &&
        subscription.generation === generation
      ) {
        consumerChannels.push(subscription.channel)
        this.clearSubscriptionTransport(subscription)
      }
    }

    this.disposeTransport(
      connection,
      publisher,
      consumerChannels
    ).catch(error => {
      this.log('error', '[coniglio] transport cleanup failed', error)
    })
    this.ensureConnected().catch(error => {
      if (!this.closed) {
        this.log('error', '[coniglio] reconnect failed', error)
      }
    })
  }

  private async discardTransportAttempt (
    connection: ChannelModel | undefined,
    publisher: ConfirmChannel | undefined,
    generation: number | undefined
  ): Promise<void> {
    const consumerChannels: Channel[] = []

    if (
      connection &&
      this.connection === connection
    ) {
      this.connection = undefined
      this.publisher = undefined
    }

    if (generation !== undefined) {
      for (const subscription of this.subscriptions) {
        if (
          subscription.channel &&
          subscription.generation === generation
        ) {
          consumerChannels.push(subscription.channel)
          this.clearSubscriptionTransport(subscription)
        }
      }
    }

    await this.disposeTransport(
      connection,
      publisher,
      consumerChannels
    )
  }

  private async disposeTransport (
    connection: ChannelModel | undefined,
    publisher: ConfirmChannel | undefined,
    consumerChannels: readonly Channel[]
  ): Promise<void> {
    connection?.removeAllListeners('error')
    connection?.removeAllListeners('close')
    publisher?.removeAllListeners('error')
    publisher?.removeAllListeners('close')

    for (const channel of consumerChannels) {
      this.activeConsumerChannels.delete(channel)
      channel.removeAllListeners('error')
      channel.removeAllListeners('close')
    }

    await Promise.all([
      ...consumerChannels.map(async channel => {
        await channel.close().catch(() => {})
      }),
      publisher?.close().catch(() => {})
    ])
    await connection?.close().catch(() => {})
  }

  private async ensureSubscriptionOnCurrentTransport (
    subscription: Subscription
  ): Promise<void> {
    while (!subscription.closed) {
      await this.ensureConnected()
      const connection = this.connection
      const generation = this.generation
      if (!connection) continue

      try {
        await this.startSubscriptionOn(
          subscription,
          connection,
          generation
        )
      } catch (error) {
        if (
          !this.closed &&
          !subscription.closed &&
          (
            this.connection !== connection ||
            this.generation !== generation
          )
        ) {
          continue
        }
        throw error
      }

      if (
        subscription.channel &&
        subscription.generation === generation
      ) {
        return
      }
    }
  }

  private async startSubscriptionOn (
    subscription: Subscription,
    connection: ChannelModel,
    generation: number
  ): Promise<void> {
    if (
      subscription.closed ||
      (
        subscription.channel &&
        subscription.generation === generation
      )
    ) {
      return
    }

    if (subscription.startPromise) {
      await subscription.startPromise
      if (
        subscription.channel &&
        subscription.generation === generation
      ) {
        return
      }
    }

    const start = this.createConsumer(
      subscription,
      connection,
      generation
    )
    subscription.startPromise = start

    try {
      await start
    } finally {
      if (subscription.startPromise === start) {
        subscription.startPromise = undefined
      }
    }
  }

  private async createConsumer (
    subscription: Subscription,
    connection: ChannelModel,
    generation: number
  ): Promise<void> {
    let channel: Channel | undefined

    try {
      channel = await connection.createChannel()
      if (
        subscription.closed ||
        this.closed ||
        this.connection !== connection ||
        this.generation !== generation
      ) {
        await channel.close().catch(() => {})
        return
      }

      subscription.channel = channel
      subscription.generation = generation
      this.activeConsumerChannels.add(channel)

      channel.on('error', error => {
        this.log(
          'error',
          `[coniglio] consumer channel error for "${subscription.queueName}"`,
          error
        )
      })
      channel.once('close', () => {
        this.handleSubscriptionLost(subscription, channel!, generation)
      })

      await channel.prefetch(subscription.prefetch)
      const reply = await channel.consume(
        subscription.queueName,
        message => {
          if (message === null) {
            this.handleSubscriptionLost(
              subscription,
              channel!,
              generation
            )
            return
          }

          if (
            subscription.closed ||
            subscription.channel !== channel ||
            subscription.generation !== generation
          ) {
            channel!.nack(message, false, true)
            return
          }

          this.deliveryChannels.set(message, channel!)
          if (!subscription.messages.push(message)) {
            this.deliveryChannels.delete(message)
            channel!.nack(message, false, true)
          }
        },
        { noAck: false }
      )
      subscription.consumerTag = reply.consumerTag
      this.emitEvent({
        type: 'consumer-ready',
        queue: subscription.queueName,
        consumerTag: reply.consumerTag
      })
      this.log(
        'debug',
        `[coniglio] consuming "${subscription.queueName}" as ${reply.consumerTag}`
      )
    } catch (error) {
      if (channel && subscription.channel === channel) {
        this.clearSubscriptionTransport(subscription)
      }
      if (channel) {
        channel.removeAllListeners('error')
        channel.removeAllListeners('close')
        this.activeConsumerChannels.delete(channel)
        await channel.close().catch(() => {})
      }
      throw error
    }
  }

  private handleSubscriptionLost (
    subscription: Subscription,
    channel: Channel,
    generation: number
  ): void {
    if (
      subscription.closed ||
      subscription.channel !== channel ||
      subscription.generation !== generation
    ) {
      return
    }

    this.emitEvent({
      type: 'consumer-lost',
      queue: subscription.queueName
    })
    this.log(
      'warn',
      `[coniglio] consumer for "${subscription.queueName}" closed; recovering`
    )
    this.clearSubscriptionTransport(subscription)
    channel.close().catch(() => {})
    this.recoverSubscription(subscription).catch(error => {
      if (!subscription.closed && !this.closed) {
        this.log(
          'error',
          `[coniglio] consumer recovery failed for "${subscription.queueName}"`,
          error
        )
      }
    })
  }

  private async recoverSubscription (
    subscription: Subscription
  ): Promise<void> {
    if (subscription.recoveryPromise) {
      return await subscription.recoveryPromise
    }

    const recovery = (async () => {
      for (let attempt = 1; !subscription.closed; attempt++) {
        try {
          await this.ensureSubscriptionOnCurrentTransport(subscription)
          return
        } catch (error) {
          if (subscription.closed || this.closed) return
          if (attempt >= this.reconnectOptions.maxAttempts) {
            subscription.messages.finish(
              new ConiglioConnectionError(
                `Consumer "${subscription.queueName}" recovery failed after ${attempt} attempts`,
                error
              ),
              message => this.deliveryChannels.delete(message)
            )
            return
          }

          const delayMs = backoffDelay(
            attempt,
            this.reconnectOptions
          )
          this.emitEvent({
            type: 'consumer-retry',
            queue: subscription.queueName,
            attempt,
            delayMs,
            error
          })
          this.log(
            'warn',
            `[coniglio] consumer recovery attempt ${attempt} failed for "${subscription.queueName}"`,
            error
          )
          await abortableDelay(delayMs, this.lifecycle.signal)
        }
      }
    })()

    subscription.recoveryPromise = recovery
    try {
      await recovery
    } finally {
      if (subscription.recoveryPromise === recovery) {
        subscription.recoveryPromise = undefined
      }
    }
  }

  private clearSubscriptionTransport (
    subscription: Subscription
  ): void {
    if (subscription.channel) {
      this.activeConsumerChannels.delete(subscription.channel)
      subscription.channel.removeAllListeners('error')
      subscription.channel.removeAllListeners('close')
    }
    subscription.channel = undefined
    subscription.consumerTag = undefined
    subscription.generation = undefined
    subscription.messages.clear(message => {
      this.deliveryChannels.delete(message)
    })
  }

  private async unregisterSubscription (
    subscription: Subscription
  ): Promise<void> {
    if (subscription.closePromise) {
      return await subscription.closePromise
    }

    const close = (async () => {
      subscription.closed = true
      this.subscriptions.delete(subscription)

      if (subscription.signal && subscription.signalHandler) {
        subscription.signal.removeEventListener(
          'abort',
          subscription.signalHandler
        )
      }

      subscription.messages.finish(
        undefined,
        message => this.deliveryChannels.delete(message)
      )

      const channel = subscription.channel
      const consumerTag = subscription.consumerTag
      this.clearSubscriptionTransport(subscription)

      if (channel) {
        if (consumerTag) {
          await channel.cancel(consumerTag).catch(() => {})
        }
        await channel.close().catch(() => {})
      }
      this.emitEvent({
        type: 'consumer-cancelled',
        queue: subscription.queueName
      })
    })()

    subscription.closePromise = close
    return await close
  }

  private getActiveDeliveryChannel (message: ConsumeMessage): Channel {
    const channel = this.deliveryChannels.get(message)
    if (!channel || !this.activeConsumerChannels.has(channel)) {
      throw new ConiglioMessageStateError()
    }
    return channel
  }

  private nackRaw (message: ConsumeMessage, requeue: boolean): void {
    const channel = this.getActiveDeliveryChannel(message)
    channel.nack(message, false, requeue)
    this.deliveryChannels.delete(message)
  }

  private async publishAndConfirm (
    channel: ConfirmChannel,
    exchange: string,
    routingKey: string,
    body: Buffer,
    options: PublishOptions,
    confirmTimeoutMs: number,
    signal: AbortSignal
  ): Promise<void> {
    throwIfAborted(signal)

    await new Promise<void>((resolve, reject) => {
      let settled = false
      let timer: NodeJS.Timeout | undefined

      const finish = (error?: unknown) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        if (error !== undefined) reject(error)
        else resolve()
      }

      const onAbort = () => finish(abortReason(signal))
      signal.addEventListener('abort', onAbort, { once: true })

      if (confirmTimeoutMs !== Infinity) {
        timer = setTimeout(() => {
          finish(
            new ConiglioPublishError(
              `RabbitMQ did not confirm "${routingKey}" within ${confirmTimeoutMs}ms`
            )
          )
        }, confirmTimeoutMs)
      }

      try {
        channel.publish(
          exchange,
          routingKey,
          body,
          options,
          error => finish(error ?? undefined)
        )
      } catch (error) {
        finish(error)
      }
    })
  }

  private async applyStoredTopology (
    channel: ConfirmChannel
  ): Promise<void> {
    await this.applyConfiguration(channel, {
      exchanges: [...this.exchanges.values()],
      queues: [...this.queues.values()]
    })
  }

  private async applyConfiguration (
    channel: ConfirmChannel,
    options: ConfigureOptions
  ): Promise<void> {
    for (const exchange of options.exchanges ?? []) {
      await channel.assertExchange(exchange.name, exchange.type, {
        durable: exchange.durable,
        autoDelete: exchange.autoDelete,
        internal: exchange.internal,
        arguments: exchange.arguments
      })
    }

    for (const queue of options.queues ?? []) {
      await channel.assertQueue(queue.name, {
        durable: queue.durable,
        exclusive: queue.exclusive,
        autoDelete: queue.autoDelete,
        arguments: {
          ...queue.arguments,
          ...(queue.deadLetterExchange !== undefined
            ? { 'x-dead-letter-exchange': queue.deadLetterExchange }
            : {}),
          ...(queue.messageTtl !== undefined
            ? { 'x-message-ttl': queue.messageTtl }
            : {}),
          ...(queue.maxLength !== undefined
            ? { 'x-max-length': queue.maxLength }
            : {})
        }
      })

      for (const binding of queue.bindTo ?? []) {
        await channel.bindQueue(
          queue.name,
          binding.exchange,
          binding.routingKey,
          binding.arguments
        )
      }
    }
  }

  private rememberConfiguration (options: ConfigureOptions): void {
    for (const exchange of options.exchanges ?? []) {
      this.exchanges.set(exchange.name, cloneExchange(exchange))
    }
    for (const queue of options.queues ?? []) {
      const cloned = cloneQueue(queue)
      const existingBindings = this.queues.get(queue.name)?.bindTo ?? []
      const bindings = [...existingBindings, ...(cloned.bindTo ?? [])]
      const uniqueBindings = new Map<string, (typeof bindings)[number]>()

      for (const binding of bindings) {
        uniqueBindings.set(
          [
            binding.exchange,
            binding.routingKey,
            JSON.stringify(binding.arguments ?? {})
          ].join('\u0000'),
          binding
        )
      }

      this.queues.set(queue.name, {
        ...cloned,
        bindTo: [...uniqueBindings.values()]
      })
    }
  }

  private failSubscriptions (error: unknown): void {
    for (const subscription of this.subscriptions) {
      subscription.messages.finish(
        error,
        message => this.deliveryChannels.delete(message)
      )
    }
  }
}
