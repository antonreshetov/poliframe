import { Buffer } from 'node:buffer'
import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SupporterService } from '../src/main/services/supporter'

function setup() {
  const pair = generateKeyPairSync('ed25519')
  let state = { key: '', exports: 0 }
  const storage = {
    get: () => state,
    set: (value: typeof state) => {
      state = value
    },
  }
  const publicKey = pair.publicKey
    .export({ type: 'spki', format: 'der' })
    .toString('base64')
  const service = new SupporterService(storage, publicKey)
  const issue = (data: object = {}) => {
    const payload = Buffer.from(
      JSON.stringify({
        email: 'supporter@example.com',
        name: 'Supporter',
        ...data,
      }),
    ).toString('base64url')
    return `${payload}.${sign(null, Buffer.from(payload), pair.privateKey).toString('base64url')}`
  }
  return { service, storage, publicKey, issue }
}

describe('supporter licenses', () => {
  it('activates offline and verifies the stored signature after restart', () => {
    const { service, storage, publicKey, issue } = setup()
    expect(service.status().active).toBe(false)
    expect(service.activate(issue())).toEqual({
      active: true,
      name: 'Supporter',
      email: 'supporter@example.com',
    })
    expect(new SupporterService(storage, publicKey).status().active).toBe(true)
    storage.set({ ...storage.get(), key: 'forged' })
    expect(service.status().active).toBe(false)
  })

  it('rejects foreign, malformed and tampered keys without losing an existing activation', () => {
    const { service, issue } = setup()
    const valid = issue()
    service.activate(valid)
    const [payload, signature] = valid.split('.')
    const modified = Buffer.from(
      JSON.stringify({
        email: 'attacker@example.com',
      }),
    ).toString('base64url')
    for (const key of [
      null,
      '',
      'a.b.c',
      `${valid}.extra`,
      `${modified}.${signature}`,
      `${payload}.AAAA`,
      issue({ name: 1 }),
      issue({ email: 'invalid' }),
      setup().issue(),
      'a'.repeat(4097),
    ]) {
      expect(() => service.activate(key)).toThrow(/Invalid supporter key/)
      expect(service.status().active).toBe(true)
    }
  })

  it('prompts every 25 exports, persists counts, and stops prompting after activation', () => {
    const { service, storage, publicKey, issue } = setup()
    for (let index = 1; index <= 25; index++)
      expect(service.recordExport()).toBe(index === 25)
    const restarted = new SupporterService(storage, publicKey)
    for (let index = 26; index <= 50; index++)
      expect(restarted.recordExport()).toBe(index === 50)
    restarted.activate(issue())
    for (let index = 0; index < 50; index++)
      expect(restarted.recordExport()).toBe(false)
    expect(storage.get().exports).toBe(100)
  })
})
