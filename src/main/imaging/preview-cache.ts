import type { Buffer } from 'node:buffer'

/** Worker-local LRU: only completed previews are retained, with a hard byte limit. */
export class PreviewCache {
  private entries = new Map<string, Buffer>()
  private bytes = 0

  constructor(private readonly budget: number) {}

  async get(key: string, create: () => Promise<Buffer>): Promise<Buffer> {
    const existing = this.entries.get(key)
    if (existing) {
      this.entries.delete(key)
      this.entries.set(key, existing)
      return existing
    }
    const value = await create()
    if (value.byteLength <= this.budget) {
      while (this.bytes + value.byteLength > this.budget) {
        const oldest = this.entries.keys().next().value!
        this.bytes -= this.entries.get(oldest)!.byteLength
        this.entries.delete(oldest)
      }
      this.entries.set(key, value)
      this.bytes += value.byteLength
    }
    return value
  }
}
