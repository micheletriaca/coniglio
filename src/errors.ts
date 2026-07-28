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
