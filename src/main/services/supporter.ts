import type { SupporterStatus } from '../../shared/contracts'
import { Buffer } from 'node:buffer'
import { createPublicKey, verify } from 'node:crypto'

const publicKey
  = 'MCowBQYDK2VwAyEAfMVNlhn0cvx36RIntYqA/dRgtdJ9+kA7GdOi9wbQQl4='
export interface SupporterState {
  key: string
  exports: number
}
interface Storage {
  get: () => SupporterState
  set: (value: SupporterState) => void
}

export class SupporterService {
  private readonly publicKey
  constructor(
    private readonly storage: Storage,
    key = publicKey,
  ) {
    this.publicKey = createPublicKey({
      key: Buffer.from(key, 'base64'),
      type: 'spki',
      format: 'der',
    })
  }

  private verify(key: unknown): SupporterStatus | null {
    if (typeof key !== 'string' || key.length > 4096)
      return null
    try {
      const parts = key.trim().split('.')
      if (parts.length !== 2 || parts.some(part => !/^[\w-]+$/.test(part)))
        return null
      const [payload, signature] = parts as [string, string]
      if (
        !verify(
          null,
          Buffer.from(payload),
          this.publicKey,
          Buffer.from(signature, 'base64url'),
        )
      ) {
        return null
      }
      const data = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      )
      if (
        typeof data?.email !== 'string'
        || !/^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/.test(data.email)
        || (data.name !== undefined && typeof data.name !== 'string')
      ) {
        return null
      }
      return { active: true, name: data.name || null, email: data.email }
    }
    catch {
      return null
    }
  }

  status(): SupporterStatus {
    return (
      this.verify(this.storage.get().key) ?? {
        active: false,
        name: null,
        email: null,
      }
    )
  }

  activate(key: unknown): SupporterStatus {
    const status = this.verify(key)
    if (!status) {
      throw new Error(
        'Invalid supporter key. Check that you pasted the complete Poliframe key.',
      )
    }
    this.storage.set({ ...this.storage.get(), key: (key as string).trim() })
    return status
  }

  recordExport(): boolean {
    const state = this.storage.get()
    const count
      = Number.isSafeInteger(state.exports) && state.exports >= 0
        ? state.exports
        : 0
    const exports = Math.min(count + 1, Number.MAX_SAFE_INTEGER)
    this.storage.set({ ...state, exports })
    return exports % 25 === 0 && !this.status().active
  }
}
