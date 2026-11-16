/** Host metadata determines which relative conversation link may be copied. */
import { describe, expect, it, vi } from 'vitest'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { parentFileCandidates, resolveChatFilePath } from '../src/client/file-path.ts'

const sessionId = SessionId('remote-session')
const signal = () => new AbortController().signal
const statFor = (paths: Readonly<Record<string, string>>) => vi.fn<ClientRemote['workspaceFiles']['stat']>(async (_session, path) =>
  paths[path] === undefined
    ? { ok: false, error: new RemoteError('workspace-file/not-found', 'missing', { path }) }
    : { ok: true, value: { absolutePath: paths[path], version: '1' } })

describe('conversation file path resolution', () => {
  it('derives parent candidates without leaving POSIX, drive, or UNC roots', () => {
    expect(parentFileCandidates('./out/logs/file.log', '/data/work/trees/task/')).toEqual([
      '/data/work/trees/out/logs/file.log', '/data/work/out/logs/file.log', '/data/out/logs/file.log', '/out/logs/file.log',
    ])
    expect(parentFileCandidates('out\\logs\\file.log', 'C:\\work\\trees\\task')).toEqual([
      'C:\\work\\trees\\out\\logs\\file.log', 'C:\\work\\out\\logs\\file.log', 'C:\\out\\logs\\file.log',
    ])
    expect(parentFileCandidates('out/file.log', '\\\\server\\share\\trees\\task')).toEqual([
      '\\\\server\\share\\trees\\out\\file.log', '\\\\server\\share\\out\\file.log',
    ])
    for (const cwd of ['/', 'C:\\', '\\\\server\\share', 'relative', undefined]) {
      expect(parentFileCandidates('out/file.log', cwd)).toEqual([])
    }
    for (const path of ['file.log', '../out/file.log', 'out/../file.log', '/out/file.log', 'out//file.log', 'out/']) {
      expect(parentFileCandidates(path, '/workspace/task')).toEqual([])
    }
  })

  it('uses workspace ancestors only after a miss and rejects multiple existing matches', async () => {
    const path = 'out/varlen.log'
    const candidates = parentFileCandidates(path, '/work/trees/task')
    const stat = statFor({ '/work/out/varlen.log': '/work/out/varlen.log' })
    expect(await resolveChatFilePath(stat, sessionId, path, candidates, signal())).toBe('/work/out/varlen.log')
    const ambiguous = statFor({ '/work/out/varlen.log': '/work/out/varlen.log', '/out/varlen.log': '/out/varlen.log' })
    expect(await resolveChatFilePath(ambiguous, sessionId, path, candidates, signal())).toBeUndefined()
  })

  it('prefers an existing workspace file over similarly named output files', async () => {
    const stat = statFor({ 'out/a.txt': '/workspace/out/a.txt', '/else/out/a.txt': '/else/out/a.txt' })
    expect(await resolveChatFilePath(stat, sessionId, 'out/a.txt', ['/else/out/a.txt'], signal())).toBe('/workspace/out/a.txt')
    expect(stat).toHaveBeenCalledTimes(1)
  })
  it('resolves a unique existing recorded target through the addressed Host', async () => {
    const stat = statFor({ '/outside/run/a.txt': '/outside/run/a.txt' })
    const requestSignal = signal()
    expect(await resolveChatFilePath(stat, sessionId, 'run/a.txt', ['/gone/run/a.txt', '/outside/run/a.txt'], requestSignal))
      .toBe('/outside/run/a.txt')
    expect(stat).toHaveBeenLastCalledWith(sessionId, '/outside/run/a.txt', requestSignal)
  })
  it('refuses missing and ambiguous targets instead of guessing a path', async () => {
    expect(await resolveChatFilePath(statFor({}), sessionId, 'a.txt', [], signal())).toBeUndefined()
    const stat = statFor({ '/a/result.txt': '/a/result.txt', '/b/result.txt': '/b/result.txt' })
    expect(await resolveChatFilePath(stat, sessionId, 'result.txt', ['/a/result.txt', '/b/result.txt'], signal())).toBeUndefined()
  })
  it('stops on an inaccessible candidate and preserves absolute literals without a network call', async () => {
    const stat = statFor({})
    stat.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/bad-request', 'unavailable', {}) })
    expect(await resolveChatFilePath(stat, sessionId, 'a.txt', ['/else/a.txt'], signal())).toBeUndefined()
    expect(stat).toHaveBeenCalledTimes(1)
    expect(await resolveChatFilePath(stat, sessionId, '/remote/deleted.txt', [], signal())).toBe('/remote/deleted.txt')
    expect(stat).toHaveBeenCalledTimes(1)
  })
  it('refuses a partial candidate check and coalesces aliases of the same file', async () => {
    const stat = statFor({ '/a/file': '/canonical/file', '/alias/file': '/canonical/file' })
    expect(await resolveChatFilePath(stat, sessionId, 'file', ['/a/file', '/alias/file', '/a/file'], signal())).toBe('/canonical/file')
    expect(stat).toHaveBeenCalledTimes(3)
    stat.mockImplementation(async (_session, path) => path === 'file'
      ? { ok: false, error: new RemoteError('workspace-file/not-found', 'missing', { path }) }
      : { ok: false, error: new RemoteError('gateway/bad-request', 'unavailable', {}) })
    expect(await resolveChatFilePath(stat, sessionId, 'file', ['/a/file'], signal())).toBeUndefined()
    const cancelled = new AbortController()
    cancelled.abort()
    stat.mockClear()
    expect(await resolveChatFilePath(stat, sessionId, '/absolute', [], cancelled.signal)).toBeUndefined()
    expect(stat).not.toHaveBeenCalled()
  })
  it('discards a candidate that arrives after its connection was cancelled', async () => {
    const controller = new AbortController()
    const candidate = Promise.withResolvers<Awaited<ReturnType<ClientRemote['workspaceFiles']['stat']>>>()
    const started = Promise.withResolvers<undefined>()
    const stat = statFor({})
    stat.mockImplementation(async (_session, path) => {
      if (path === 'file') return { ok: false, error: new RemoteError('workspace-file/not-found', 'missing', { path }) }
      started.resolve(undefined)
      return candidate.promise
    })
    const resolved = resolveChatFilePath(stat, sessionId, 'file', ['/remote/file'], controller.signal)
    await started.promise
    controller.abort()
    candidate.resolve({ ok: true, value: { absolutePath: '/remote/file', version: '1' } })
    expect(await resolved).toBeUndefined()
  })
})
