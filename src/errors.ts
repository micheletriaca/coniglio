export class ConiglioError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }
}

export class ConiglioClosedError extends ConiglioError {
  constructor() {
    super('Coniglio client is closed')
  }
}

export class ConiglioConnectionError extends ConiglioError {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
  }
}

export class ConiglioPublishError extends ConiglioError {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
  }
}

export class ConiglioPublishTimeoutError extends ConiglioPublishError {
  readonly routingKey: string
  readonly timeoutMs: number

  constructor(routingKey: string, timeoutMs: number) {
    super(`RabbitMQ did not confirm "${routingKey}" within ${timeoutMs}ms`)
    this.routingKey = routingKey
    this.timeoutMs = timeoutMs
  }
}

export class ConiglioUnroutableError extends ConiglioPublishError {
  readonly exchange: string
  readonly routingKey: string
  readonly messageId: string
  readonly replyCode: number | undefined
  readonly replyText: string | undefined

  constructor(
    exchange: string,
    routingKey: string,
    messageId: string,
    replyCode?: number,
    replyText?: string,
  ) {
    const reason = replyText ? `: ${replyText}` : ''
    super(
      `RabbitMQ returned unroutable message "${messageId}" for "${routingKey}" on exchange "${exchange}"${reason}`,
    )
    this.exchange = exchange
    this.routingKey = routingKey
    this.messageId = messageId
    this.replyCode = replyCode
    this.replyText = replyText
  }
}

export class ConiglioMessageStateError extends ConiglioError {
  constructor() {
    super(
      'The message delivery channel is no longer active; RabbitMQ will requeue the unacknowledged delivery',
    )
  }
}

export class UnexpectedRoutingKeyError extends ConiglioError {
  readonly queue: string
  readonly routingKey: string
  readonly expectedRoutingKeys: readonly string[]

  constructor(queue: string, routingKey: string, expectedRoutingKeys: readonly string[]) {
    super(
      `Queue "${queue}" delivered routing key "${routingKey}", expected one of: ${expectedRoutingKeys.join(', ')}`,
    )
    this.queue = queue
    this.routingKey = routingKey
    this.expectedRoutingKeys = expectedRoutingKeys
  }
}
