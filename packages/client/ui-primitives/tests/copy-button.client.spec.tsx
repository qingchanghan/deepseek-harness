// @vitest-environment jsdom
/** Clipboard feedback and exact text survive path truncation and denied clipboard access. */
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CopyButton } from '../src/CopyButton.tsx'
import { writeClipboard } from '../src/clipboard.ts'

vi.mock('../src/clipboard.ts', () => ({ writeClipboard: vi.fn() }))
afterEach(() => { cleanup(); vi.resetAllMocks() })
const labels = { label: 'Copy path', copiedLabel: 'Path copied', failedLabel: 'Copy failed; retry' }

it('copies the full remote path and resets feedback when the file changes', async () => {
  vi.mocked(writeClipboard).mockResolvedValue(true)
  const path = '/data/workspace/a very long directory/report.md'
  const view = render(<CopyButton text={path} {...labels} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: labels.label })) })
  expect(writeClipboard).toHaveBeenCalledWith(path)
  expect(screen.getByRole('button', { name: labels.copiedLabel })).toBeTruthy()
  view.rerender(<CopyButton text="/data/another.txt" {...labels} />)
  expect(screen.getByRole('button', { name: labels.label })).toBeTruthy()
})

it('reports a denied copy and lets the user retry', async () => {
  vi.mocked(writeClipboard).mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  render(<CopyButton text="/data/report.md" {...labels} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: labels.label })) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: labels.failedLabel })) })
  expect(screen.getByRole('button', { name: labels.copiedLabel })).toBeTruthy()
  expect(writeClipboard).toHaveBeenCalledTimes(2)
})
