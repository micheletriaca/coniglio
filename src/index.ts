import amqplib from 'amqplib'
import { ConiglioClient } from './client'
import type {
  ConiglioInstance,
  ConiglioOptions,
  RoutingKeyMap
} from './types'

export * from './errors'
export type * from './types'

export default async function coniglio<
  T extends RoutingKeyMap = Record<string, unknown>
> (
  url: string,
  options: ConiglioOptions = {}
): Promise<ConiglioInstance<T>> {
  const client = new ConiglioClient<T>(url, options, amqplib.connect)
  await client.initialize()
  return client
}
