/** Session-routed binary reads for inline and hover image previews. */
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { resolveChatFilePath } from './file-path.ts'

/**
 * Resolve a conversation file and read it through the owning Host's bounded binary API.
 * @param files - Session-routed workspace file methods.
 * @param sessionId - Session owning the authored image.
 * @param path - decoded absolute or relative image destination.
 * @param candidates - absolute targets inferred from recorded outputs and workspace ancestors.
 * @param signal - caller and connection lifetime cancellation.
 * @returns complete image bytes, or absence on missing, ambiguous, inaccessible, or cancelled reads.
 */
export async function readChatFileImage(
  files: Pick<ClientRemote['workspaceFiles'], 'stat' | 'readBytes'>,
  sessionId: SessionId,
  path: string,
  candidates: readonly string[],
  signal: AbortSignal,
): Promise<Blob | undefined> {
  const aborted = () => signal.aborted
  const resolved = await resolveChatFilePath((...args) => files.stat(...args), sessionId, path, candidates, signal)
  if (resolved === undefined || aborted()) return undefined
  const result = await files.readBytes(sessionId, resolved, {}, signal)
  if (aborted() || !result.ok || !result.value.eof) return undefined
  // Raster formats are decoded from their bytes. SVG needs its XML image MIME type;
  // its Blob is used only by img, where scripts and external resources are inert.
  return new Blob([Uint8Array.from(result.value.data)], {
    type: resolved.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : '',
  })
}
