const { Buffer } = require('node:buffer')
const { createPrivateKey, sign } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { homedir } = require('node:os')
const { join } = require('node:path')
const process = require('node:process')
const { parseArgs } = require('node:util')

const { values } = parseArgs({
  options: { email: { type: 'string' }, name: { type: 'string' } },
})
const email = values.email?.trim()
if (!email || !/^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/.test(email)) {
  throw new Error(
    'Usage: pnpm license:issue --email user@example.com [--name "Name"]',
  )
}
const privateKey = createPrivateKey(
  readFileSync(
    process.env.POLIFRAME_LICENSE_PRIVATE_KEY
    || join(homedir(), '.poliframe', 'license-private.pem'),
  ),
)
const payload = Buffer.from(
  JSON.stringify({
    email,
    name: values.name?.trim() || undefined,
    issuedAt: new Date().toISOString(),
  }),
).toString('base64url')
console.log(
  `${payload}.${sign(null, Buffer.from(payload), privateKey).toString('base64url')}`,
)
