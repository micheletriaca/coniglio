import coniglio = require('coniglio')

type Events = {
  ready: { ok: boolean }
}

const connection = coniglio<Events>('amqp://localhost')

void connection.then(async (client) => {
  await client.publish('', 'ready', { ok: true })
  await client.close()
})

void coniglio.ConiglioClosedError
void coniglio.ConiglioPublishTimeoutError
void coniglio.ConiglioUnroutableError
