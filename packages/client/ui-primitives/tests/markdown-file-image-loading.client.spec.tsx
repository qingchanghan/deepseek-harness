// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MarkdownDelegateProvider } from '../src/markdown/MarkdownDelegate.tsx'
import { MarkdownText } from './markdown-test-components.tsx'

const labels = { open: 'View image', dialog: 'Image preview', close: 'Close', loading: 'Loading image', failed: 'Image unavailable' }
const createUrl = vi.fn(() => 'blob:loaded-image')
const revokeUrl = vi.fn()
const blob = new Blob(['image'])
beforeEach(() => {
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: createUrl, revokeObjectURL: revokeUrl }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers() })

function content(load: (path: string, signal: AbortSignal) => Promise<Blob | undefined>, text = '![plot](run/plot.png)') {
  return <MarkdownDelegateProvider openFile={vi.fn()} fileImages={{ load, labels }}>
    <MarkdownText text={text} />
  </MarkdownDelegateProvider>
}

it('shows loading, displays Session image bytes, and releases their URL after closing the view', async () => {
  const pending = Promise.withResolvers<Blob>()
  const load = vi.fn(() => pending.promise)
  const view = render(content(load))
  expect(screen.getByRole('status').textContent).toBe('Loading image')
  await act(async () => { pending.resolve(blob) })
  expect(screen.getByRole('img').getAttribute('src')).toBe('blob:loaded-image')
  fireEvent.click(screen.getByRole('button', { name: 'View image: plot' }))
  expect(screen.getByRole('dialog').querySelector('img')?.getAttribute('src')).toBe('blob:loaded-image')
  view.unmount()
  expect(revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:loaded-image')
})

it('starts link reads only when a hover preview mounts and cancels them when it closes', async () => {
  vi.useFakeTimers()
  const load = vi.fn(async (_path: string, _signal: AbortSignal) => blob)
  render(content(load, '[plot](run/plot.png)'))
  expect(load).not.toHaveBeenCalled()
  const link = screen.getByRole('button', { name: 'plot' })
  fireEvent.pointerEnter(link.parentElement!)
  await act(async () => { vi.advanceTimersByTime(500) })
  expect(load).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('img').getAttribute('src')).toBe('blob:loaded-image')
  fireEvent.keyDown(link, { key: 'Escape' })
  expect(load.mock.calls[0]![1].aborted).toBe(true)
  expect(revokeUrl).toHaveBeenCalledTimes(1)
})

it.each(['missing', 'rejected', 'url-failed'] as const)('reports %s with the localized fallback and no local-host URL', async (failure) => {
  const load = vi.fn(async () => {
    if (failure === 'rejected') throw new Error('disconnected')
    return failure === 'missing' ? undefined : blob
  })
  if (failure === 'url-failed') createUrl.mockImplementationOnce(() => { throw new Error('unavailable') })
  render(content(load))
  expect(await screen.findByText('Image unavailable · plot')).toBeTruthy()
  expect(screen.queryByRole('img')).toBeNull()
})

it('retains the file destination when a failed image has no description', async () => {
  render(content(async () => undefined, '![](run/plot.png)'))
  expect(await screen.findByText('Image unavailable · run/plot.png')).toBeTruthy()
})

it('ignores a late successful read after its path is replaced', async () => {
  const pending = Promise.withResolvers<Blob>()
  const load = vi.fn(async (_path: string, _signal: AbortSignal) => blob).mockReturnValueOnce(pending.promise)
  const view = render(content(load))
  view.rerender(content(load, '![new](new.png)'))
  await screen.findByRole('img', { name: 'new' })
  await act(async () => { pending.resolve(blob) })
  expect(load.mock.calls[0]![1].aborted).toBe(true)
  expect(createUrl).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('img', { name: 'plot' })).toBeNull()
})

it('ignores late failures after unmount and keeps image-only links as one activation', async () => {
  const pending = Promise.withResolvers<Blob>()
  const view = render(content(() => pending.promise))
  view.unmount()
  await act(async () => { pending.reject(new Error('late')) })
  expect(revokeUrl).not.toHaveBeenCalled()
  render(content(async () => blob, '[![plot](plot.png)](plot.png)'))
  await screen.findByRole('img')
  expect(screen.getAllByRole('button')).toHaveLength(1)
})
