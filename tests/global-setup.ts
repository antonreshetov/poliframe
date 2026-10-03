import type { TestProject } from 'vitest/node'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

// The real Node worker needs emitted JavaScript; unit tests import source directly.
export default async function setup(project: TestProject) {
  const directory = await mkdtemp(path.join(tmpdir(), 'poliframe-tests-'))
  try {
    execFileSync(
      process.execPath,
      [
        path.resolve('node_modules/typescript/bin/tsc'),
        '-p',
        'tsconfig.main.json',
        '--outDir',
        directory,
      ],
      { stdio: 'inherit' },
    )
    await symlink(
      path.resolve('node_modules'),
      path.join(directory, 'node_modules'),
      'junction',
    )
    project.provide('workerBuild', directory)
  }
  catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  return () => rm(directory, { recursive: true, force: true })
}

declare module 'vitest' {
  export interface ProvidedContext {
    workerBuild: string
  }
}
