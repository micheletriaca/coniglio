import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { URL, fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import esmConiglio, {
  ConiglioClosedError as EsmClosedError
} from '../../lib/index.esm.js'

const require = createRequire(import.meta.url)
const cjsConiglio = require('../../index.cjs')
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))
const tsc = fileURLToPath(
  new URL('../../node_modules/.bin/tsc', import.meta.url)
)

describe('published package API', () => {
  it('loads equivalent ESM and CommonJS entry points', () => {
    assert.equal(typeof esmConiglio, 'function')
    assert.equal(typeof cjsConiglio, 'function')
    assert.equal(cjsConiglio.ConiglioClosedError.name, 'ConiglioClosedError')
    assert.equal(EsmClosedError.name, 'ConiglioClosedError')
  })

  it('exposes valid ESM and CommonJS TypeScript declarations', () => {
    execFileSync(tsc, [
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--types',
      'node',
      'test/fixtures/public-api.mts',
      'test/fixtures/public-api.cts'
    ], {
      cwd: repositoryRoot,
      stdio: 'pipe'
    })
  })
})
