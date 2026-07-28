import type { ConsumeMessage, Options } from 'amqplib'

export interface Logger {
  debug?(...args: unknown[]): void
  info?(...args: unknown[]): void
  warn?(...args: unknown[]): void
  error?(...args: unknown[]): void
}

export interface RoutingKeyMap {
  [routingKey: string]: unknown
}

export interface RetryOptions {
  initialDelayMs?: number
  maxDelayMs?: number
  maxAttempts?: number
}

export type ConiglioLifecycleState =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'disconnected'
  | 'closing'
  | 'closed'

export type ConiglioEvent =
  | {
    type: 'state'
    state: ConiglioLifecycleState
    reason?: string
  }
  | {
    type: 'connection-retry'
    attempt: number
    delayMs: number
    error: unknown
  }
  | {
    type: 'consumer-ready'
    queue: string
    consumerTag: string
  }
  | {
    type: 'consumer-lost'
    queue: string
  }
  | {
    type: 'consumer-retry'
    queue: string
    attempt: number
    delayMs: number
    error: unknown
  }
  | {
    type: 'consumer-cancelled'
    queue: string
  }
  | {
    type: 'publish-confirmed'
    exchange: string
    routingKey: string
    attempt: number
  }
  | {
    type: 'publish-retry'
    exchange: string
    routingKey: string
    attempt: number
    delayMs: number
    error: unknown
  }

export interface ConiglioOptions {
  logger?: Logger
  onEvent?: (event: ConiglioEvent) => void
  json?: boolean
  prefetch?: number
  reconnect?: RetryOptions
  publish?: {
    retry?: RetryOptions | false
    confirmTimeoutMs?: number
  }
  signal?: AbortSignal
  socketOptions?: unknown
}

interface MessageBase<K extends string> {
  routingKey: K
  raw: ConsumeMessage
  content: Buffer
}

type JsonMessage<K extends string, T> = MessageBase<K> & {
  contentIsJson: true
  data: T
}

type RawMessage<K extends string> = MessageBase<K> & {
  contentIsJson: false
  data: undefined
}

export type Message<
  T extends RoutingKeyMap = RoutingKeyMap,
  K extends keyof T & string = keyof T & string
> = {
  [P in K]: JsonMessage<P, T[P]> | RawMessage<P>
}[K]

export interface ListenOptions<K extends string = string> {
  json?: boolean
  prefetch?: number
  routingKeys?: readonly K[]
  signal?: AbortSignal
}

export type PublishOptions = Options.Publish & {
  retry?: RetryOptions | false
  signal?: AbortSignal
  confirmTimeoutMs?: number
}

export type ExchangeType =
  | 'direct'
  | 'topic'
  | 'headers'
  | 'fanout'
  | 'match'
  | 'x-delayed-message'
  | (string & {})

export interface ExchangeConfiguration {
  name: string
  type: ExchangeType
  durable?: boolean
  autoDelete?: boolean
  internal?: boolean
  arguments?: Record<string, unknown>
}

export interface QueueBinding {
  exchange: string
  routingKey: string
  arguments?: Record<string, unknown>
}

export interface QueueConfiguration {
  name: string
  durable?: boolean
  exclusive?: boolean
  autoDelete?: boolean
  deadLetterExchange?: string
  messageTtl?: number
  maxLength?: number
  arguments?: Record<string, unknown>
  bindTo?: readonly QueueBinding[]
}

export interface ConfigureOptions {
  exchanges?: readonly ExchangeConfiguration[]
  queues?: readonly QueueConfiguration[]
}

export interface ConiglioInstance<
  T extends RoutingKeyMap = Record<string, unknown>
> {
  readonly state: ConiglioLifecycleState

  listen<K extends keyof T & string = keyof T & string>(
    queue: string,
    options?: ListenOptions<K>
  ): AsyncGenerator<Message<T, K>>

  ack<K extends keyof T & string>(message: Message<T, K>): void
  nack<K extends keyof T & string>(
    message: Message<T, K>,
    requeue?: boolean
  ): void

  publish<K extends keyof T & string>(
    exchange: string,
    routingKey: K,
    payload: T[K],
    options?: PublishOptions
  ): Promise<void>

  configure(options: ConfigureOptions): Promise<void>
  close(): Promise<void>
}
