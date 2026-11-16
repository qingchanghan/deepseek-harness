/** File images stay on the Session's Host and require complete authorized bytes. */
import { expect, it, vi } from 'vitest'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { readChatFileImage } from '../src/client/file-image.ts'

const sid = SessionId('host-qualified-session')
const bytes = new Uint8Array([137, 80, 78, 71])
const response = { ok: true as const, value: { absolutePath: '/remote/run/plot.png', version: '1', data: bytes, offset: 0, eof: true } }
function files() {
  return {
    stat: vi.fn<ClientRemote['workspaceFiles']['stat']>(async (_sid, path) => path.startsWith('/remote/')
      ? { ok: true, value: { absolutePath: path, version: '1' } }
      : { ok: false, error: new RemoteError('workspace-file/not-found', 'missing', { path }) }),
    readBytes: vi.fn<ClientRemote['workspaceFiles']['readBytes']>().mockResolvedValue(response),
  }
}

it('reads relative output images using their unique recorded absolute target and owning Session', async () => {
  const api = files()
  const signal = new AbortController().signal
  const blob = await readChatFileImage(api, sid, 'run/plot.png', ['/remote/run/plot.png'], signal)
  expect(api.readBytes).toHaveBeenCalledExactlyOnceWith(sid, '/remote/run/plot.png', {}, signal)
  expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(bytes)
  expect(blob!.type).toBe('')
})

it('assigns SVG an image MIME type without treating it as an HTML document', async () => {
  const blob = await readChatFileImage(files(), sid, '/remote/plot.SVG', [], new AbortController().signal)
  expect(blob?.type).toBe('image/svg+xml')
})

it('does not read bytes for missing or cancelled targets', async () => {
  const api = files()
  const controller = new AbortController()
  expect(await readChatFileImage(api, sid, 'missing.png', [], controller.signal)).toBeUndefined()
  controller.abort()
  expect(await readChatFileImage(api, sid, '/remote/plot.png', [], controller.signal)).toBeUndefined()
  expect(api.readBytes).not.toHaveBeenCalled()
})

it('discards a binary response after cancellation', async () => {
  const api = files()
  const controller = new AbortController()
  api.readBytes.mockImplementation(async () => { controller.abort(); return response })
  expect(await readChatFileImage(api, sid, '/remote/plot.png', [], controller.signal)).toBeUndefined()
})

it('does not render a refused or incomplete file read', async () => {
  const api = files()
  api.readBytes.mockResolvedValueOnce({ ok: false, error: new RemoteError('workspace-file/too-large', 'large', { path: '/remote/plot.png', limit: 32 }) })
  expect(await readChatFileImage(api, sid, '/remote/plot.png', [], new AbortController().signal)).toBeUndefined()
  api.readBytes.mockResolvedValueOnce({ ok: true, value: { ...response.value, eof: false } })
  expect(await readChatFileImage(api, sid, '/remote/plot.png', [], new AbortController().signal)).toBeUndefined()
})
