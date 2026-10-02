import path from 'node:path'
import { Worker } from 'node:worker_threads'

interface Job {
  id: number
  type: 'preview' | 'export'
  payload: object
  resolve: (value: any) => void
  reject: (error: Error) => void
}
export class RenderJobs {
  private worker?: Worker
  private active?: Job
  private queue: Job[] = []
  private sequence = 0
  private closed = false
  private stopping?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>

  request<T>(type: Job['type'], payload: object): Promise<T> {
    if (this.closed)
      return Promise.reject(new Error('Application is closing'))
    if (type === 'preview') {
      this.queue = this.queue.filter((job) => {
        if (job.type !== 'preview')
          return true
        job.reject(new Error('Preview superseded'))
        return false
      })
    }
    if (this.queue.length >= 3)
      return Promise.reject(new Error('Render queue is busy'))
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.sequence, type, payload, resolve, reject })
      this.next()
    })
  }

  private next() {
    if (this.active || this.stopping || !this.queue.length || this.closed)
      return
    if (!this.worker) {
      const worker = new Worker(path.join(__dirname, '../imaging/worker.js'))
      this.worker = worker
      worker.on('message', (message) => {
        if (this.worker !== worker || this.active?.id !== message.id)
          return
        clearTimeout(this.timer)
        const active = this.active!
        this.active = undefined
        if (message.error)
          active.reject(new Error(message.error))
        else active.resolve(message.result)
        this.next()
      })
      worker.on('error', (error) => {
        if (this.worker === worker)
          this.reset(error instanceof Error ? error : new Error(String(error)))
      })
      worker.on('exit', (code) => {
        if (this.worker === worker)
          this.reset(new Error(`Image worker exited (${code})`))
      })
    }
    this.active = this.queue.shift()!
    this.worker.postMessage({
      ...this.active.payload,
      type: this.active.type,
      id: this.active.id,
    })
    this.timer = setTimeout(
      () => this.reset(new Error('Rendering exceeded the time limit')),
      120_000,
    )
  }

  private reset(error: Error): Promise<void> {
    if (this.stopping)
      return this.stopping
    clearTimeout(this.timer)
    const worker = this.worker
    this.worker = undefined
    const active = this.active
    this.active = undefined
    const stopped = worker
      ? worker.terminate().then(() => {})
      : Promise.resolve()
    const completion = stopped.then(
      () => {
        this.stopping = undefined
        active?.reject(error)
        this.next()
      },
      () => {
        this.stopping = undefined
        active?.reject(error)
        this.next()
      },
    )
    this.stopping = completion
    return completion
  }

  async cancelExport() {
    this.queue = this.queue.filter((job) => {
      if (job.type !== 'export')
        return true
      job.reject(new Error('Export cancelled'))
      return false
    })
    if (this.active?.type === 'export')
      await this.reset(new Error('Export cancelled'))
  }

  async close() {
    this.closed = true
    clearTimeout(this.timer)
    this.queue.forEach(job =>
      job.reject(new Error('Application is closing')),
    )
    this.queue = []
    this.active?.reject(new Error('Application is closing'))
    this.active = undefined
    const worker = this.worker
    this.worker = undefined
    await worker?.terminate()
    await this.stopping
  }
}
