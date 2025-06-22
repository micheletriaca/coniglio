import { ConsumeMessage } from 'amqplib'

export interface Logger {
  log(...args: any[]): void
  debug(...args: any[]): void
  info(...args: any[]): void
  warn(...args: any[]): void
  error(...args: any[]): void
}

export interface RoutingKeyMap {
  [routingKey: string]: unknown;
}

export type Message<T extends RoutingKeyMap = any> = {
  [K in keyof T]: {
    routingKey: K
    data: T[K]
    contentIsJson: boolean
    raw: ConsumeMessage
    content: Buffer
  }
}[keyof T]

export interface ListenOptions<K extends string = string> {
  json?: boolean
  prefetch?: number
  routingKeys?: K[]
}

export interface ConiglioInstance<T extends RoutingKeyMap = Record<string, any>> {
  listen(
    queue: string,
    opts?: ListenOptions<keyof T & string>
  ): AsyncGenerator<Message<T>>

  ack(msg: Message<T>): void
  nack(msg: Message<T>, requeue?: boolean): void
  publish<E extends keyof T & string>(
    exchange: string,
    routingKey: E,
    payload: T[E]
  ): Promise<void>
  configure(opts: ConfigureOptions): Promise<void>
}

export interface ConfigureOptions {
  exchanges?: {
    name: string
    type: 'topic' | 'fanout' | 'direct'
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
    bindTo?: { exchange: string; routingKey: string; arguments?: Record<string, any> }[]
  }[]
}
