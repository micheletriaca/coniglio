import type { RetryOptions } from './types'

export interface NormalizedRetryOptions {
  initialDelayMs: number
  maxDelayMs: number
  maxAttempts: number
}

export const normalizeRetryOptions = (
  options: RetryOptions | undefined,
  defaults: NormalizedRetryOptions,
): NormalizedRetryOptions => {
  const normalized = {
    initialDelayMs: options?.initialDelayMs ?? defaults.initialDelayMs,
    maxDelayMs: options?.maxDelayMs ?? defaults.maxDelayMs,
    maxAttempts: options?.maxAttempts ?? defaults.maxAttempts,
  }

  if (!Number.isFinite(normalized.initialDelayMs) || normalized.initialDelayMs < 0) {
    throw new RangeError('initialDelayMs must be a finite number greater than or equal to 0')
  }
  if (
    !Number.isFinite(normalized.maxDelayMs) ||
    normalized.maxDelayMs < normalized.initialDelayMs
  ) {
    throw new RangeError(
      'maxDelayMs must be a finite number greater than or equal to initialDelayMs',
    )
  }
  if (
    normalized.maxAttempts !== Infinity &&
    (!Number.isInteger(normalized.maxAttempts) || normalized.maxAttempts < 1)
  ) {
    throw new RangeError('maxAttempts must be a positive integer or Infinity')
  }

  return normalized
}

export const backoffDelay = (failedAttempt: number, options: NormalizedRetryOptions): number => {
  const exponential = Math.min(
    options.initialDelayMs * 2 ** Math.max(0, failedAttempt - 1),
    options.maxDelayMs,
  )
  const minimum = exponential / 2
  return Math.min(minimum + Math.random() * (exponential - minimum), options.maxDelayMs)
}

const signalReason = (signal: AbortSignal): Error => {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError')
}

export const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw signalReason(signal)
}

export const abortableDelay = async (milliseconds: number, signal: AbortSignal): Promise<void> => {
  throwIfAborted(signal)
  if (milliseconds === 0) return

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)

    const onAbort = () => {
      clearTimeout(timer)
      reject(signalReason(signal))
    }

    signal.addEventListener('abort', onAbort, { once: true })
  })
}
