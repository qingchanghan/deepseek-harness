/** Resolve conversation links through their owning Host without reading file contents. */
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/remote'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { isAbsoluteWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'

/**
 * Resolve directory-prefixed links against each parent of the recorded workspace.
 * @param path - parsed relative link without a line anchor.
 * @param cwd - absolute workspace path on the Session Host, when known.
 * @returns candidates requiring Host checks; bare names and traversal paths yield none.
 */
export function parentFileCandidates(path: string, cwd: string | undefined): readonly string[] {
  const relative = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
  if (cwd === undefined || !isAbsoluteWorkspacePath(cwd) || isAbsoluteWorkspacePath(relative)
    || !relative.includes('/') || relative.split('/').some(part => part === '..' || part === '')) return []
  const normalized = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  const parts = normalized.split('/')
  const rootParts = normalized.startsWith('//') ? 4 : 1
  const candidates: string[] = []
  for (let length = parts.length - 1; length >= rootParts; length -= 1) {
    const candidate = `${parts.slice(0, length).join('/')}/${relative}`
    candidates.push(cwd.includes('\\') ? candidate.replace(/\//g, '\\') : candidate)
  }
  return candidates
}

/**
 * Prefer the workspace target, then accept exactly one existing candidate.
 * @param stat - metadata lookup routed by Session identity to its owning Host.
 * @param sessionId - Session whose workspace resolves the relative link.
 * @param path - parsed link; absolute paths retain their spelling even when absent.
 * @param candidates - targets inferred from recorded outputs and workspace ancestors.
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
