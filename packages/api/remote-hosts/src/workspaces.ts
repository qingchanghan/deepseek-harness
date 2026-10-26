/** Validated Workspace reads and adoption through the attached Host's existing API. */
import { z } from 'zod'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteHostHandle } from './index.ts'
import type { RemoteHostWorkspace, RemoteHostWorkspaces } from './types.ts'

const workspaceId = z.string().min(1).transform(id => id as WorkspaceId)
const sessionIds = z.array(z.string().min(1).transform(id => id as SessionId))
const workspace = z.object({
  workspaceId,
  path: z.string().min(1),
  title: z.string(),
  sessionIds,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
const value = z.object({ items: z.array(workspace), archivedSessionIds: sessionIds, pinnedSessionIds: sessionIds })
const baseline = z.object({ type: z.literal('baseline'), value })
const increment = z.discriminatedUnion('type', [
  z.object({ type: z.literal('replace'), value }),
  z.object({ type: z.literal('upsert'), workspace }),
  z.object({ type: z.literal('remove'), workspaceId }),
  z.object({ type: z.literal('order'), workspaceIds: z.array(workspaceId) }),
  z.object({ type: z.literal('archived'), archivedSessionIds: sessionIds }),
  z.object({ type: z.literal('pinned'), pinnedSessionIds: sessionIds }),
])

/**
 * Read the first Workspace baseline and release its remote stream.
 * @param host - Selected, connected Host.
 * @param signal - Caller cancellation and read deadline.
 * @returns Workspaces in remote order.
 */
export async function readWorkspaces(host: RemoteHostHandle, signal: AbortSignal): Promise<RemoteHostWorkspaces> {
  for await (const snapshot of followWorkspaces(host, signal)) return snapshot
  throw new Error('The remote Host closed its Workspace stream before sending a baseline')
}

/**
 * Project ordered remote Workspace changes into complete display snapshots.
 * @param host - Selected, connected Host.
 * @param signal - Owning Client resource lifetime.
 * @returns Validated membership, Workspace order, archive and pin state.
 */
export async function* followWorkspaces(host: RemoteHostHandle, signal: AbortSignal): AsyncIterable<RemoteHostWorkspaces> {
  let snapshot: RemoteHostWorkspaces | undefined
  for await (const frame of host.stream('workspace/follow', { args: {} }, signal)) {
    if (snapshot === undefined) snapshot = baseline.parse(frame).value
    else {
      const change = increment.parse(frame)
      switch (change.type) {
        case 'replace': snapshot = change.value; break
        case 'upsert': snapshot = { ...snapshot, items: snapshot.items.some(item => item.workspaceId === change.workspace.workspaceId)
          ? snapshot.items.map(item => item.workspaceId === change.workspace.workspaceId ? change.workspace : item)
          : [...snapshot.items, change.workspace] }; break
        case 'remove': snapshot = { ...snapshot, items: snapshot.items.filter(item => item.workspaceId !== change.workspaceId) }; break
        case 'order': {
          const order = new Map(change.workspaceIds.map((id, index) => [id, index]))
          const items = [...snapshot.items].sort((a, b) => (order.get(a.workspaceId) ?? Infinity) - (order.get(b.workspaceId) ?? Infinity))
          snapshot = { ...snapshot, items }
          break
        }
        case 'archived': snapshot = { ...snapshot, archivedSessionIds: change.archivedSessionIds }; break
        case 'pinned': snapshot = { ...snapshot, pinnedSessionIds: change.pinnedSessionIds }; break
        default: assertNever(change)
      }
    }
    yield snapshot
  }
  if (!signal.aborted) throw new Error('The remote Host closed its Workspace stream unexpectedly')
}

function assertNever(value: never): never {
  throw new Error(`Unexpected Workspace change: ${String(value)}`)
}

/**
 * Adopt an existing directory on the selected Host.
 * @param host - Selected, connected Host.
 * @param path - Directory validated by the remote Workspace registry.
 * @returns The adopted Workspace; no local directory is created.
 */
export async function addWorkspace(host: RemoteHostHandle, path: string): Promise<RemoteHostWorkspace> {
  const value = await host.invoke('workspace/create', { request: { path } })
  return z.object({ workspace }).parse(value).workspace
}
