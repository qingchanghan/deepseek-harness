/** OpenSSH command construction and instance discovery parsing. */

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { listRemoteInstances, newestInstance, openTunnel, type SshTarget } from '../src/ssh.ts'

/** Child-process stand-in carrying the streams `ssh` transport code reads. */
function child(): EventEmitter & {
  stdout: PassThrough
  stderr: PassThrough
  exitCode: number | null
  signalCode: string | null
  kill: (signal?: string) => boolean
} {
  const spawned = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: (signal = 'SIGTERM') => {
      spawned.signalCode = signal
      process.nextTick(() => { spawned.emit('close', null, signal) })
      return true
    },
  })
  return spawned
}

const descriptor = (pid: number, startedAt: string, port: number): string => JSON.stringify({
  version: 1,
  pid,
  startedAt,
  protocol: 'http:',
  host: '127.0.0.1',
  port,
  url: `http://127.0.0.1:${String(port)}/?token=t`,
  home: '/home/dev/.dsh',
})

const target: SshTarget = { sshTarget: 'h20-141-sy', timeoutMs: 5_000 }

describe('remote instance discovery', () => {
  it('reads every published descriptor and orders them by start time', async () => {
    const calls: string[][] = []
    const spawn = ((command: string, args: string[]) => {
      calls.push([command, ...args])
      const spawned = child()
      spawned.stdout.end([
        '--DSH-INSTANCE--',
        descriptor(7, '2026-10-23T01:00:00.000Z', 4000),
        '--DSH-INSTANCE--',
        descriptor(9, '2026-10-23T02:00:00.000Z', 5000),
        '',
      ].join('\n'))
      spawned.exitCode = 0
      process.nextTick(() => { spawned.emit('close', 0) })
      return spawned
    }) as never
    const instances = await listRemoteInstances({ ...target, remoteHome: '/srv/dsh home' }, undefined, spawn)
    expect(instances.map(instance => instance.pid)).toEqual([7, 9])
    expect(newestInstance(instances)?.pid).toBe(9)
    const args = calls[0] ?? []
    expect(args[0]).toBe('ssh')
    expect(args).toContain('BatchMode=yes')
    expect(args).not.toContain('--')
    expect(args.at(-1)).toContain("home='/srv/dsh home'")
  })

  it('returns an empty list when the remote host publishes nothing', async () => {
    const spawn = (() => {
      const spawned = child()
      spawned.stdout.end('')
      spawnCloser(spawned)
      return spawned
    }) as never
    await expect(listRemoteInstances(target, undefined, spawn)).resolves.toEqual([])
  })
})

describe('ssh forwarding', () => {
  it('forwards the remote listener on a fresh loopback port', async () => {
    const calls: string[][] = []
    const spawn = ((command: string, args: string[]) => {
      calls.push([command, ...args])
      return child()
    }) as never
    await expect(openTunnel({ ...target, timeoutMs: 50 }, { host: '127.0.0.1', port: 53179 }, spawn))
      .rejects.toThrow(/did not become reachable|ssh exited/)
    const args = calls[0] ?? []
    expect(args).toContain('-N')
    expect(args).toContain('ExitOnForwardFailure=yes')
    const forward = args[args.indexOf('-L') + 1] ?? ''
    expect(forward).toMatch(/^127\.0\.0\.1:\d+:127\.0\.0\.1:53179$/)
  })
})

/** Finish a fake child successfully without sharing the real timer path. */
function spawnCloser(spawned: EventEmitter & { exitCode: number | null }): void {
  spawned.exitCode = 0
  process.nextTick(() => { spawned.emit('close', 0) })
}
