export class AsyncQueue<T> {
  private readonly values: T[] = []
  private waiter?: {
    resolve: (result: IteratorResult<T>) => void
    reject: (error: unknown) => void
  }

  private finished = false
  private failure?: unknown

  push(value: T): boolean {
    if (this.finished) return false

    if (this.waiter) {
      const waiter = this.waiter
      this.waiter = undefined
      waiter.resolve({ done: false, value })
    } else {
      this.values.push(value)
    }

    return true
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.values.length > 0) {
      return { done: false, value: this.values.shift()! }
    }
    if (this.failure !== undefined) throw this.failure
    if (this.finished) return { done: true, value: undefined }

    if (this.waiter) {
      throw new Error('AsyncQueue only supports one pending reader')
    }

    return await new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiter = { resolve, reject }
    })
  }

  clear(onValue?: (value: T) => void): void {
    if (onValue) {
      for (const value of this.values) onValue(value)
    }
    this.values.length = 0
  }

  finish(error?: unknown, onValue?: (value: T) => void): void {
    if (this.finished) return

    this.clear(onValue)
    this.finished = true
    this.failure = error

    if (this.waiter) {
      const waiter = this.waiter
      this.waiter = undefined
      if (error !== undefined) waiter.reject(error)
      else waiter.resolve({ done: true, value: undefined })
    }
  }
}
