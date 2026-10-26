/** Validated Workspace reads and adoption through the attached Host's existing API. */
import { z } from 'zod'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { RemoteHostHandle } from './index.ts'
import type { RemoteHostWorkspace } from './types.ts'

const workspace = z.object({
  workspaceId: z.string().min(1).transform(id => id as WorkspaceId),
  path: z.string().min(1),
  title: z.string(),
})
const baseline = z.object({ type: z.literal('baseline'), value: z.object({ items: z.array(workspace) }) })

/**
 * Read the first Workspace baseline and release its remote stream.
 * @param host - Selected, connected Host.
 * @param signal - Caller cancellation and read deadline.
 * @returns Workspaces in remote order.
 */
export async function readWorkspaces(host: RemoteHostHandle, signal: AbortSignal): Promise<{ items: RemoteHostWorkspace[] }> {
  for await (const frame of host.stream('workspace/follow', { args: {} }, signal)) {
    return baseline.parse(frame).value
  }
  throw new Error('The remote Host closed its Workspace stream before sending a baseline')
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
