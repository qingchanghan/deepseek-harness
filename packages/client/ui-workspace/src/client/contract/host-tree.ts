/** Shared Workspace tree presentation for an attached Host. */
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'

/** Host-owned membership and navigation; mutation actions remain with their owning Host. */
export interface HostWorkspaceTreeInput {
  hostId: string
  label: string
  workspaces: readonly WorkspaceView[]
  archivedSessionIds: readonly SessionId[]
  pinnedSessionIds: readonly SessionId[]
  query: string
  loading: boolean
  emptyLabel: string
  /** Open a Session through the owning Host's navigation route. */
  openSession: (sessionId: SessionId) => void
}

/** Shared tree with the standard Session, status, panel and locale hooks. */
export type HostWorkspaceTreeProps = HostWorkspaceTreeInput & Pick<FactoryComponentPropsOf<'workspace.host.tree'>,
  'useSessions' | 'useSessionStatus' | 'usePanelInfo' | 't'>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotFactoryMap {
    /** Attached Host workspaces using the same rows, icons and time labels as Local. */
    'workspace.host.tree': { scope: 'root'; props: HostWorkspaceTreeInput; locale: 'workspace' }
  }
}
