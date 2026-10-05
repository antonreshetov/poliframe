const { generateKeyPairSync } = require('node:crypto')
const { mkdirSync, writeFileSync } = require('node:fs')
const { homedir } = require('node:os')
const { join } = require('node:path')

const directory = join(homedir(), '.poliframe')
const destination = join(directory, 'license-private.pem')
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
mkdirSync(directory, { recursive: true, mode: 0o700 })
writeFileSync(
  destination,
  privateKey.export({ type: 'pkcs8', format: 'pem' }),
  { mode: 0o600, flag: 'wx' },
)
console.log(
  `Private key saved to ${destination}. Back it up securely; never commit it.`,
)
console.log(
  publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
)
