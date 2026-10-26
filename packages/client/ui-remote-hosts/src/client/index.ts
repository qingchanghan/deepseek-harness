/**
 * Hosts panel, browser half: the sidebar entry and the main page that groups
 * local Sessions and SSH-attached remote Sessions by the machine hosting them.
 *
 * The panel reads the ordinary Session catalog, so a remote Session is opened
 * exactly like a local one; the Host's Session Controller routes its history
 * and prompts to the attached remote process.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import { HostsController } from './controller.ts'
import { HostsToast } from './HostsToast.tsx'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { HostsPanel, type HostsPanelInjected } from './HostsPanel.tsx'
import { RemoteHostsIcon } from './RemoteHostsIcon.tsx'
import { SidebarHosts, type SidebarHostsInjected } from './SidebarHosts.tsx'
import { en, NS, zh } from './locales.ts'
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import { createNewSessionStore } from './new-session-store.ts'
import { NewSessionDialog, type NewSessionInjected } from './NewSessionDialog.tsx'
import { registerWorkspaceResource } from './workspace-resource.ts'

/** Stable keyed identity of the Hosts main panel. */
const PANEL_ID = 'hosts' as MainPanelId

export type { HostsPanelProps, HostsPanelInjected } from './HostsPanel.tsx'
export type { RemoteHostsKey } from './locales.ts'

/** Required services: the slot registry, dictionaries, and Session navigation. */
export const inject = ['slots', 'locale', 'uiWorkspace', 'remote', 'remote.remoteHosts', 'sessions', 'workspaces', 'connection', 'layout', 'resources']

/**
 * Client plugin body: register the dictionaries, the main page, and its
 * sidebar entry.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-remote-hosts: dictionaries')
  const t = ctx.locale.bind(NS)
  const controller = new HostsController(ctx.remote.remoteHosts, t)
  registerWorkspaceResource(ctx)
  const picker = createNewSessionStore()
  let pickerActions: BoundActions<typeof picker> | undefined
  ctx.on('ui-workspace/new-session', () => {
    if (pickerActions === undefined || controller.store.getSnapshot().catalog.hosts.length === 0) return
    const active = Object.values(ctx.sessions.list.getSnapshot().byId).find(session => (session.retainedBy.mainView ?? 0) > 0)
    pickerActions.open(active?.host?.id ?? null)
    return true
  })
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'remote-hosts.new-session', locale: NS, store: picker,
    inject: (actions: BoundActions<typeof picker>): NewSessionInjected => {
      pickerActions = actions
      return {
        hooks: { hosts: controller.store },
        reconnectHost: id => controller.reconnect(id),
        createSession: async (hostId, workspaceId) => {
          const navigation = ctx.layout.beginNavigation()
          const sessionId = await ctx.sessions.create({ workspaceId, ...(hostId === null ? {} : { hostId }) })
          if (!navigation.aborted) ctx.uiWorkspace.openSession(sessionId)
        },
        addWorkspace: async (hostId, path) => {
          if (hostId === null) return ctx.workspaces.create({ path })
          const result = await ctx.remote.remoteHosts.createWorkspace(hostId, path)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
      }
    },
  }, NewSessionDialog))
  const injected = (): HostsPanelInjected => ({
    hooks: { hosts: controller.store },
    openSession: (sessionId: SessionId) => { ctx.uiWorkspace.openSession(sessionId) },
    saveHost: (entry, revision) => controller.save(entry, revision),
    removeHost: (id, revision) => controller.remove(id, revision),
    reconnectHost: id => controller.reconnect(id),
    disconnectHost: id => controller.disconnect(id),
    refreshHosts: () => { void controller.load(); void ctx.sessions.refresh() },
    dismissNotice: () => { controller.dismissNotice() },
  })
  ctx.effect(() => {
    const refresh = (): void => {
      void controller.load()
    }
    const stopChanged = ctx.remote.$on('remote-hosts/changed', refresh)
    const stopReset = ctx.on('connection/reset', refresh)
    refresh()
    return () => { controller.dispose(); stopChanged(); stopReset() }
  }, 'ui-remote-hosts: connection status')
  ctx.slots.inject('sidebar.workspaces.hosts', () => ctx.slots.register({
    name: 'sidebar.workspaces.hosts', locale: NS,
    inject: (): SidebarHostsInjected => ({
      hooks: { hosts: controller.store },
      openSession: (sessionId) => { ctx.uiWorkspace.openSession(sessionId) },
      manageHosts: () => { ctx.layout.selectPanel(PANEL_ID) },
    }),
  }, SidebarHosts))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'remote-hosts.feedback', inject: injected,
  }, HostsToast))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: injected,
  }, HostsPanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 5,
    locale: NS,
    label: () => t('panel'),
  }, RemoteHostsIcon))
}
