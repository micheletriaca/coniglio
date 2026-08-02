import coniglio, {
  type ConiglioInstance,
  type ConiglioOptions,
  ConiglioPublishTimeoutError,
  ConiglioUnroutableError,
  type Message,
} from 'coniglio'

type Events = {
  'user.created': { userId: string }
  'invoice.sent': { invoiceId: string; total: number }
}

const options: ConiglioOptions = {
  logger: console,
  json: true,
  prefetch: 20,
  reconnect: {
    initialDelayMs: 10,
    maxDelayMs: 100,
    maxAttempts: 3,
  },
  onEvent(event) {
    if (event.type === 'state') {
      event.state.toUpperCase()
    }
  },
}

const connection = coniglio<Events>('amqp://localhost', options)

async function exercise(client: ConiglioInstance<Events>): Promise<void> {
  client.state.toUpperCase()
  await client.publish(
    'events',
    'user.created',
    { userId: '42' },
    {
      persistent: true,
      confirmTimeoutMs: 1000,
      retry: false,
    },
  )

  // @ts-expect-error unknown routing key
  await client.publish('events', 'user.deleted', { userId: '42' })
  // @ts-expect-error payload does not match the selected routing key
  await client.publish('events', 'invoice.sent', { userId: '42' })

  for await (const message of client.listen('users', {
    routingKeys: ['user.created'],
  })) {
    const narrowed: Message<Events, 'user.created'> = message
    if (narrowed.contentIsJson) {
      narrowed.data.userId.toUpperCase()
    }
    client.ack(narrowed)
    break
  }

  await client.close()
}

connection.then(exercise).catch(() => {})

const timeout = new ConiglioPublishTimeoutError('user.created', 1000)
timeout.routingKey.toUpperCase()
timeout.timeoutMs.toFixed()

const returned = new ConiglioUnroutableError('events', 'user.created', 'event-1', 312, 'NO_ROUTE')
returned.exchange.toUpperCase()
returned.routingKey.toUpperCase()
returned.messageId.toUpperCase()
returned.replyCode?.toFixed()
returned.replyText?.toUpperCase()
