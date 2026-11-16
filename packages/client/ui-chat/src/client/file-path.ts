/** Resolve conversation links through their owning Host without reading file contents. */
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/remote'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { isAbsoluteWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'

/**
 * Prefer the workspace target, then accept exactly one existing recorded candidate.
 * @param stat - metadata lookup routed by Session identity to its owning Host.
 * @param sessionId - Session whose workspace resolves the relative link.
 * @param path - parsed link; absolute paths retain their spelling even when absent.
 * @param candidates - recorded targets and siblings suggested by the deliverables owner.
 * @param signal - connection/plugin lifetime cancellation.
 * @returns absolute path, or absence on missing, ambiguous, cancelled, or inaccessible targets.
 */
export async function resolveChatFilePath(
  stat: ClientRemote['workspaceFiles']['stat'],
  sessionId: SessionId,
  path: string,
  candidates: readonly string[],
  signal: AbortSignal,
): Promise<string | undefined> {
  const aborted = () => signal.aborted
  if (aborted()) return undefined
  if (isAbsoluteWorkspacePath(path)) return path
  const workspace = await stat(sessionId, path, signal)
  if (aborted()) return undefined
  if (workspace.ok) return workspace.value.absolutePath
  if (workspace.error.code !== 'workspace-file/not-found') return undefined
  const matches = new Set<string>()
  for (const candidate of new Set(candidates)) {
    const result = await stat(sessionId, candidate, signal)
    if (aborted()) return undefined
    if (result.ok) matches.add(result.value.absolutePath)
    else if (result.error.code !== 'workspace-file/not-found') return undefined
    if (matches.size > 1) return undefined
  }
  return matches.values().next().value
}
