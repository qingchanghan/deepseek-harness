/** Destination picker visibility shared by the global New Session gesture and its overlay. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

interface State { request: { hostId: string | null } | null }
type Actions = {
  open(draft: State, hostId: string | null): void
  close(draft: State): void
}

/**
 * Creates the root destination picker's registration-owned state.
 * @returns The picker visibility and requested host, with open and close actions.
 */
export function createNewSessionStore(): EngineStoreHandle<State, Actions> {
  return defineStore({
    init: (): State => ({ request: null }),
    actions: {
      open: (draft, hostId) => { draft.request = { hostId } },
      close: (draft) => { draft.request = null },
    },
  })
}
