/** Private instance descriptors that let an SSH peer find a running Web GUI. */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isWebInstanceDescriptor,
  removeWebInstance,
  webInstanceDescriptor,
  webInstancePath,
  writeWebInstance,
} from '../src/instance-descriptor.ts'

const homes: string[] = []

afterEach(async () => {
  await Promise.all(homes.splice(0).map(async (home) => { await rm(home, { recursive: true, force: true }) }))
})

async function home(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'dsh-remote-hosts-'))
  homes.push(created)
  return created
}

describe('web instance descriptor', () => {
  it('publishes an owner-only descriptor and removes it on request', async () => {
    const root = await home()
    const descriptor = webInstanceDescriptor({
      protocol: 'http:',
      host: '127.0.0.1',
      port: 3080,
      url: 'http://127.0.0.1:3080/?token=secret',
      home: root,
      pid: 4242,
      startedAt: '2026-10-23T00:00:00.000Z',
    })
    await writeWebInstance(root, descriptor)
    const path = webInstancePath(root, 4242)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(descriptor)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(root, 'web-instances'))).mode & 0o777).toBe(0o700)
    await removeWebInstance(root, 4242)
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects descriptors a reader cannot use', () => {
    expect(isWebInstanceDescriptor({ version: 2 })).toBe(false)
    expect(isWebInstanceDescriptor({ version: 1, pid: 1 })).toBe(false)
    expect(isWebInstanceDescriptor({
      version: 1,
      pid: 1,
      startedAt: 'now',
      protocol: 'http:',
      host: '127.0.0.1',
      port: 1,
      url: 'http://127.0.0.1:1/?token=t',
      home: '/home/u/.dsh',
    })).toBe(true)
  })
})
