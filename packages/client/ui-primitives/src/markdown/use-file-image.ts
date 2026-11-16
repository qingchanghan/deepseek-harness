/** Mounted Markdown image reads and their browser URL lifetimes. */
import { useEffect, useState } from 'react'
import type { MarkdownDelegate } from './MarkdownDelegate.tsx'

type Loader = NonNullable<NonNullable<MarkdownDelegate['fileImages']>['load']>
type Source = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; src: string }

/**
 * Read one file image while its renderer is mounted; superseded reads cannot publish.
 * @param path - decoded file destination in the owner's filesystem.
 * @param load - owner-authorized binary reader.
 * @returns loading, failure, or a Blob URL released on replacement or unmount.
 */
export function useFileImage(path: string, load: Loader): Source {
  const [result, setResult] = useState<{ path: string; load: Loader; source: Source }>()
  useEffect(() => {
    const controller = new AbortController()
    let url: string | undefined
    void (async () => {
      try {
        const blob = await load(path, controller.signal)
        if (controller.signal.aborted) return
        if (blob === undefined) {
          setResult({ path, load, source: { kind: 'failed' } })
          return
        }
        url = URL.createObjectURL(blob)
        setResult({ path, load, source: { kind: 'ready', src: url } })
      } catch (_error: unknown) {
        // This renderer owns read and browser-URL failures; expose its localized fallback.
        if (!controller.signal.aborted) setResult({ path, load, source: { kind: 'failed' } })
      }
    })()
    return () => {
      controller.abort()
      if (url !== undefined) URL.revokeObjectURL(url)
    }
  }, [path, load])
  return result?.path === path && result.load === load ? result.source : { kind: 'loading' }
}
