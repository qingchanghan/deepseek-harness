import { MessageId } from '@deepseek-ai/dsh-llm/brand'
// @vitest-environment jsdom
/** Chat inject factories exercised over independently mounted Conversation and Chat plugins. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ISession, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import {
  SlotTestRuntime, stubConfigForm, usePinnedBrowserLanguages,
} from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionBehaviorOverrides } from '@deepseek-ai/dsh-client-test-runtime'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import {
  apply as applyConversation, inject as injectConversation,
  type GroupKey,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  apply as applyChat, inject as injectChat, type ChatFlowDataInjected, type ChatViewInjected,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { createChatStore } from '../src/client/stores.ts'
import { CHAT_SETTINGS_NAMESPACE, type ChatSettings } from '../src/chat-settings.ts'
import type { LinkOpeningRowInjected } from '../src/client/settings/LinkOpeningRow.tsx'
import type { TranscriptViewRowInjected } from '../src/client/settings/TranscriptViewRow.tsx'
import type { FileCopyToastInjected } from '../src/client/chat/FileCopyToast.tsx'

usePinnedBrowserLanguages('zh-CN')

const ROOT = 'root-1' as SessionId
const ATTACHMENT = {
  attachmentId: AttachmentId('image-1'),
  mediaType: 'image/png',
  bytes: 1,
  width: 1,
  height: 1,
} as const

type ChatInstance = ReturnType<ReturnType<typeof createChatStore>['create']>
type ChatActions = ChatInstance['actions']

function sessionFakeFor() {
  return {
    loadOlder: vi.fn<ISession['loadOlder']>(() => Promise.resolve()),
    loadThrough: vi.fn<ISession['loadThrough']>(() => Promise.resolve()),
    readAttachment: vi.fn<ISession['readAttachment']>(() => Promise.resolve({
      ok: true,
      value: { attachment: ATTACHMENT, data: Uint8Array.of(1) },
    })),
    prompt: vi.fn<ISession['prompt']>(() => Promise.resolve({ ok: true, value: { accepted: true } })),
    cancel: vi.fn<ISession['cancel']>(() => Promise.resolve({ ok: true, value: { accepted: true } })),
  } satisfies SessionBehaviorOverrides
}

async function bench(initialSettings?: ChatSettings, withBrowserRegistry = true, withProcessGroups = true) {
  const runtime = await SlotTestRuntime.create()
  const chatSettings = stubConfigForm<ChatSettings>()
  if (initialSettings !== undefined) chatSettings.publish({ value: initialSettings })
  runtime.ctx.provide('configForms', {
    developerTools: { enabled: createSnapshotStore(true) },
    get: (id: string) => id === CHAT_SETTINGS_NAMESPACE ? chatSettings.scope : stubConfigForm().scope,
  } as never)
  const layout = { closeRightbar: vi.fn(), openRightbar: vi.fn() }
  runtime.ctx.provide('layout', layout as never)
  const sidebarRight = {
    openResource: vi.fn<(address: string) => void>(),
    openTab: vi.fn<(kind: string, options?: unknown) => void>(),
  }
  runtime.ctx.provide('sidebarRight', sidebarRight as never)
  const browserAvailable = createSnapshotStore(true)
  const sidebarRightTabs = {
    get: vi.fn<(kind: string) => object | undefined>(() => browserAvailable.getSnapshot() ? {} : undefined),
    subscribe: (listener: () => void) => browserAvailable.subscribe(listener),
    register: vi.fn(() => () => {}),
  }
  if (withBrowserRegistry) runtime.ctx.provide('sidebarRightTabs', sidebarRightTabs as never)
  runtime.ctx.provide('resources', { register: vi.fn(() => () => {}) } as never)
  const openWorkspacePath = vi.fn<ClientRemote['session']['openWorkspacePath']>(
    () => Promise.resolve({ ok: true, value: { opened: true } }),
  )
  runtime.remote.provideNamespaces({ session: { openWorkspacePath } })
  const stat = vi.fn<ClientRemote['workspaceFiles']['stat']>(async (sessionId, path) => {
    const cwd = runtime.ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
    return cwd === undefined
      ? { ok: false, error: new RemoteError('workspace-file/not-found', 'missing', { path }) }
      : { ok: true, value: { absolutePath: resolveWorkspacePath(cwd, path), version: 'v1' } }
  })
  runtime.remote.provideNamespaces({ workspaceFiles: { stat } })
  const openSession = vi.fn<(id: SessionId) => void>()
  runtime.ctx.provide('uiWorkspace', {
    openWorkspace: vi.fn(async (_workspaceId: WorkspaceId, beforeOpen: (id: SessionId) => void) => {
      beforeOpen(ROOT)
      openSession(ROOT)
    }),
    openSession,
  } as never)
  const session = sessionFakeFor()
  await runtime.sessions.add({
    id: ROOT,
    summary: { title: 'R', displayTitle: 'R', cwd: '/proj' },
    session,
  })
  const rootReference = runtime.sessions.retain(ROOT)
  await rootReference.ready
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.root.declare({
    'main': { kind: 'keyed', scope: 'root' },
    'settings.general.item': { kind: 'list', scope: 'root' },
    'shell.overlay': { kind: 'list', scope: 'root' },
  }, (_props: { renderSlot?: unknown }) => null)
  await runtime.mount({ inject: [...injectConversation], apply: applyConversation })
  const registerGroups = withProcessGroups ? undefined
    : vi.spyOn(runtime.ctx.uiConversation.groups, 'register').mockImplementation(() => () => {})
  const chat = await runtime.mount({ inject: [...injectChat], apply: applyChat })
  registerGroups?.mockRestore()
  runtime.renderRoot()

  const chatViewApi = (reference: SessionReference) => {
    const id = reference.sessionId
    const entry = runtime.slots.entries('conversation.view')[0]!
    const instance = runtime.storeOf('conversation.view', reference) as ChatInstance
    const injected = (entry.inject as unknown as (
      sessionId: SessionId,
      actions: ChatActions,
    ) => ChatViewInjected)(id, instance.actions)
    return { instance, injected }
  }
  const chatFlowApi = (reference: SessionReference) => {
    const entry = runtime.slots.entries('conversation.chat.flow')[0]!
    const instance = runtime.storeOf('conversation.chat.flow', reference) as ChatInstance
    const injectFlow = entry.inject as (sessionId: SessionId) => ChatFlowDataInjected
    return { instance, injected: injectFlow(reference.sessionId) }
  }
  return {
    get linkPreference() {
      const row = runtime.slots.entries('settings.general.item').find(entry => entry.options.id === 'link-opening')!
      const preference: object = row.inject!()
      return preference as LinkOpeningRowInjected
    },
    runtime, chat, chatSettings, browserAvailable, stat,
    layout, openWorkspacePath, sidebarRight, sidebarRightTabs, session, chatViewApi, chatFlowApi, rootReference, openSession,
  }
}

describe('Chat inject API', () => {
  it('reports an unresolved relative path without copying it', async () => {
    const b = await bench()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    try {
      const id = 'no-cwd' as SessionId
      await b.runtime.sessions.add({ id, summary: {} })
      const reference = b.runtime.sessions.retain(id)
      await reference.ready
      const { injected } = b.chatViewApi(reference)
      const toast = b.runtime.slots.entries('shell.overlay').find(entry => entry.options.id === 'chat.file-copy')!
      const injectedToast: object = toast.inject!()
      const feedback = injectedToast as FileCopyToastInjected
      await injected.copyFilePath('RESULTS.md')
      expect(writeText).not.toHaveBeenCalled()
      expect(feedback.hooks.notice.getSnapshot()).toMatchObject({ outcome: 'unresolved' })
      await injected.copyFilePath('/remote/RESULTS.md')
      expect(writeText).toHaveBeenCalledExactlyOnceWith('/remote/RESULTS.md')
    } finally {
      vi.unstubAllGlobals()
      await b.runtime.dispose()
    }
  })

  it('keeps the latest copy outcome when an earlier clipboard request settles late', async () => {
    const b = await bench()
    const first = Promise.withResolvers<undefined>()
    const writeText = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    try {
      const { injected } = b.chatViewApi(b.rootReference)
      const toast = b.runtime.slots.entries('shell.overlay').find(entry => entry.options.id === 'chat.file-copy')!
      const injectedToast: object = toast.inject!()
      const feedback = injectedToast as FileCopyToastInjected
      const earlier = injected.copyFilePath('earlier.md')
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
      await injected.copyFilePath('latest.md')
      const latest = feedback.hooks.notice.getSnapshot()
      first.reject(new Error('clipboard denied'))
      await earlier
      expect(feedback.hooks.notice.getSnapshot()).toBe(latest)
      expect(latest).toMatchObject({ outcome: 'copied' })
    } finally {
      first.resolve(undefined)
      vi.unstubAllGlobals()
      await b.runtime.dispose()
    }
  })

  it.each([
    { cwd: '/proj', path: 'out/My Notes.md', expected: '/proj/out/My Notes.md' },
    { cwd: '/data/shiyuan/workspace/sglang', path: 'metric_hit_rate.py', expected: '/data/shiyuan/workspace/sglang/metric_hit_rate.py' },
    { cwd: 'C:\\work', path: 'result.json', expected: 'C:\\work\\result.json' },
    { cwd: '/proj', path: '/remote/results.md', expected: '/remote/results.md' },
  ])('copies $path under the owning workspace $cwd without opening a file', async ({ cwd, path, expected }) => {
    const b = await bench()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    try {
      const id = 'copy-session' as SessionId
      await b.runtime.sessions.add({ id, summary: { cwd, host: { id: 'h20', name: 'H20' } } })
      const reference = b.runtime.sessions.retain(id)
      await reference.ready
      const { injected } = b.chatViewApi(reference)
      const toast = b.runtime.slots.entries('shell.overlay').find(entry => entry.options.id === 'chat.file-copy')!
      const injectedToast: object = toast.inject!()
      const feedback = injectedToast as FileCopyToastInjected
      await injected.copyFilePath(path)
      expect(writeText).toHaveBeenCalledExactlyOnceWith(expected)
      expect(feedback.hooks.notice.getSnapshot()).toMatchObject({ outcome: 'copied' })
      expect(b.sidebarRight.openResource).not.toHaveBeenCalled()
      writeText.mockRejectedValueOnce(new Error('clipboard denied'))
      await injected.copyFilePath(path)
      expect(feedback.hooks.notice.getSnapshot()).toMatchObject({ outcome: 'failed' })
      feedback.dismissNotice()
      expect(feedback.hooks.notice.getSnapshot()).toBeNull()
      await b.chat.dispose()
      expect(b.runtime.slots.entries('shell.overlay').some(entry => entry.options.id === 'chat.file-copy')).toBe(false)
    } finally {
      vi.unstubAllGlobals()
      await b.runtime.dispose()
    }
  })

  it('uses the same verified remote target for copy and preview, and drops a lookup after reset', async () => {
    const b = await bench()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    try {
      const relative = 'run/metric.py'
      const target = '/remote/output/run/metric.py'
      b.runtime.ctx.provide('chatFileMentions', { forClosing: () => undefined, candidates: () => [target] })
      b.stat.mockImplementation(async (_id, path) => path === target
        ? { ok: true, value: { absolutePath: target, version: 'v1' } }
        : { ok: false, error: new RemoteError('workspace-file/not-found', 'missing', { path }) })
      const { injected } = b.chatViewApi(b.rootReference)
      await injected.copyFilePath(relative)
      expect(writeText).toHaveBeenCalledExactlyOnceWith(target)
      await injected.openFile(relative)
      expect(b.sidebarRight.openResource).toHaveBeenCalledExactlyOnceWith(`dsh-resource://file/session/root-1/${target}`)
      const pending = Promise.withResolvers<Awaited<ReturnType<ClientRemote['workspaceFiles']['stat']>>>()
      b.stat.mockReturnValueOnce(pending.promise)
      const copy = injected.copyFilePath(relative)
      b.runtime.ctx.emit('connection/reset')
      pending.resolve({ ok: true, value: { absolutePath: target, version: 'v1' } })
      await copy
      expect(writeText).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
      await b.runtime.dispose()
    }
  })

  it('projects independent Settings choices and saves timing to Host settings', async () => {
    const b = await bench()
    try {
      const row = b.runtime.slots.entries('settings.general.item')
        .find(entry => entry.options.id === 'transcript-view')!
      const preference = row.inject!()
      const setCollapseTiming = preference.setCollapseTiming as TranscriptViewRowInjected['setCollapseTiming']
      const { injected } = b.chatViewApi(b.rootReference)
      const presentation = injected.hooks.presentation
      expect(presentation.getSnapshot()).toMatchObject({ mode: 'detailed', collapseTiming: 'completion' })
      setCollapseTiming('next-input')
      expect(presentation.getSnapshot()).toMatchObject({ mode: 'detailed', collapseTiming: 'next-input' })
      expect(b.chatSettings.set).toHaveBeenCalledWith('collapseTiming', 'next-input')
      b.chatSettings.publish({ status: 'ready', value: { linkOpening: 'sidebar', transcriptView: 'standard', performanceUsage: 'detailed', collapseTiming: 'next-input' }, revision: 1, writable: true })
      expect(presentation.getSnapshot()).toMatchObject({ mode: 'standard', collapseTiming: 'next-input' })
      setCollapseTiming('completion')
      expect(presentation.getSnapshot()).toMatchObject({ mode: 'standard', collapseTiming: 'completion' })
      expect(b.chatSettings.set).toHaveBeenLastCalledWith('collapseTiming', 'completion')
      expect(b.session.prompt).not.toHaveBeenCalled()
      expect(b.session.cancel).not.toHaveBeenCalled()
    } finally {
      await b.runtime.dispose()
    }
  })

  it('resolves keyed Group sources across registration, activation, and removal', async () => {
    const b = await bench(undefined, true, false)
    try {
      const { injected } = b.chatFlowApi(b.rootReference)
      const key = 'injected-group' as GroupKey
      expect(injected.keyedHooks.chatGroup(key)).toBeUndefined()
      const conversation = b.runtime.ctx.uiConversation
      const remove = conversation.groups.register({
        kind: 'test-group', target: 'chat',
        create: () => null,
        update: () => null,
        buildGroups: () => ({
          entries: [{ kind: 'group', key }],
          groups: { kind: 'replace', snapshots: [{
            key, data: { turn: 1, closed: true, summary: { counts: [], running: undefined, runningDetail: '' } }, members: [],
          }] },
        }),
      })
      await Promise.resolve()
      conversation.binding(b.rootReference.binding).activate('chat')
      const source = injected.keyedHooks.chatGroup(key)
      expect(source?.getSnapshot()?.data.turn).toBe(1)
      expect(injected.keyedHooks.chatGroup(key)).toBe(source)
      remove()
      await Promise.resolve()
      expect(source?.getSnapshot()).toBeUndefined()
      expect(injected.keyedHooks.chatGroup(key)).toBeUndefined()
    } finally {
      await b.runtime.dispose()
    }
  })

  it('loads older history and forks through the Session Controller', async () => {
    const b = await bench()
    const { injected } = b.chatViewApi(b.rootReference)
    injected.loadOlder()
    expect(b.session.loadOlder).toHaveBeenCalledOnce()

    void injected.loadThrough(SessionSeq(42))
    expect(b.session.loadThrough).toHaveBeenCalledWith(42)

    const track = vi.fn()
    b.runtime.ctx.provide('productAnalytics', { track } as never)
    const forkCreated = vi.spyOn(b.runtime.sessions, 'fork').mockImplementation(async (input) => { input.onCreated?.(ROOT); return ROOT })
    injected.forkAt(17)
    expect(track).toHaveBeenCalledWith('branch_session_click', { session_id: ROOT, parent_session_id: ROOT, click_position: 'footer' })
    await b.runtime.sessions.replaceEvents(ROOT, [
      { type: 'event', event: { type: 'turn/start', seq: SessionSeq(10), time: 10, data: { turn: 1 } } },
      { type: 'event', event: { type: 'step/start', seq: SessionSeq(11), time: 11, data: { turn: 1, step: 1 } } },
      { type: 'event', event: { type: 'assistant/message', seq: SessionSeq(12), time: 12, surfaceOp: 'append', data: {
        turn: 1, step: 1, stream: [], message: { id: MessageId('reply'), role: 'assistant', content: [{ type: 'text', text: 'answer' }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } },
      } } },
      { type: 'event', event: { type: 'turn/end', seq: SessionSeq(17), time: 17, data: { turn: 1, reason: { kind: 'completed' } } } },
    ])
    injected.forkAt(17)
    expect(track).toHaveBeenLastCalledWith('branch_session_click', { session_id: ROOT, parent_session_id: ROOT, parent_message_id: 'reply', click_position: 'footer' })
    forkCreated.mockRestore()
    injected.forkAt(17)
    await vi.waitFor(() => {
      expect(b.openSession).toHaveBeenCalledWith(ROOT)
    })
    expect(b.runtime.sessions.calls).toContainEqual({
      method: 'fork', args: [{ sessionId: ROOT, atSeq: 17, increaseTitle: true, onCreated: expect.any(Function) as (childId: SessionId) => void }],
    })

    const fork = vi.spyOn(b.runtime.sessions, 'fork').mockRejectedValueOnce(new Error('fork failed'))
    injected.forkAt(18)
    await vi.waitFor(() => {
      expect(fork).toHaveBeenCalledWith({
        sessionId: ROOT, atSeq: 18, increaseTitle: true, onCreated: expect.any(Function) as (childId: SessionId) => void,
      })
    })
    await b.runtime.dispose()
  })

  it('addresses file paths under the Session\'s scope and opens them in the right Sidebar', async () => {
    const b = await bench()
    const { injected } = b.chatViewApi(b.rootReference)
    await injected.openFile('src/a.ts')
    // Files stay in the product: a relative path is handed to the Sidebar as an
    // address under this session's scope, not to a desktop opener.
    expect(b.sidebarRight.openResource).toHaveBeenCalledWith('dsh-resource://file/session/root-1/src/a.ts')
    expect(b.openWorkspacePath).not.toHaveBeenCalled()

    // An absolute path inside the session's workspace is the same session-relative address.
    await injected.openFile('/proj/src/a.ts')
    expect(b.sidebarRight.openResource).toHaveBeenLastCalledWith('dsh-resource://file/session/root-1/src/a.ts')

    // A name a URL would otherwise mangle survives the round trip.
    await injected.openFile('src/a b#c.ts')
    expect(b.sidebarRight.openResource).toHaveBeenLastCalledWith('dsh-resource://file/session/root-1/src/a%20b%23c.ts')

    // A line travels as the `file` type's navigation parameter, not in the address.
    await injected.openFile('src/a.ts', { line: 7 })
    expect(b.sidebarRight.openResource).toHaveBeenLastCalledWith('dsh-resource://file/session/root-1/src/a.ts', { params: { line: 7 } })
    await b.runtime.dispose()
  })

  it('opens message HTTP(S) links in Sidebar Browser tabs', async () => {
    const b = await bench()
    const { injected } = b.chatViewApi(b.rootReference)
    injected.openExternalLink('http://example.test/path')
    injected.openExternalLink('https://example.test/path')
    expect(b.sidebarRight.openTab.mock.calls).toEqual([
      ['browser', { params: { url: 'http://example.test/path' } }],
      ['browser', { params: { url: 'https://example.test/path' } }],
    ])
    await b.runtime.dispose()
  })

  it('opens message HTTP(S) links in the system browser when no Sidebar Browser is registered', async () => {
    const b = await bench()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    try {
      b.sidebarRightTabs.get.mockReturnValue(undefined)
      const { injected } = b.chatViewApi(b.rootReference)
      injected.openExternalLink('https://example.test/path')
      expect(b.sidebarRight.openTab).not.toHaveBeenCalled()
      expect(open).toHaveBeenCalledWith('https://example.test/path', '_blank', 'noopener,noreferrer')
    } finally {
      open.mockRestore()
      await b.runtime.dispose()
    }
  })

  it('applies restored and live link destinations without remounting the Chat view', async () => {
    const settings: ChatSettings = { transcriptView: 'compact', performanceUsage: 'detailed', linkOpening: 'new-tab' }
    const b = await bench(settings)
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    try {
      const { injected } = b.chatViewApi(b.rootReference)
      const source = b.linkPreference.hooks.linkOpening
      expect(source.getSnapshot()).toBe('new-tab')
      injected.openExternalLink('https://example.test/restored')
      expect(open).toHaveBeenLastCalledWith('https://example.test/restored', '_blank', 'noopener,noreferrer')
      expect(b.sidebarRight.openTab).not.toHaveBeenCalled()

      b.chatSettings.publish({ value: { ...settings, linkOpening: 'sidebar' } })
      expect(source.getSnapshot()).toBe('sidebar')
      injected.openExternalLink('http://example.test/live')
      expect(b.sidebarRight.openTab).toHaveBeenLastCalledWith('browser', { params: { url: 'http://example.test/live' } })

      b.linkPreference.setLinkOpening('new-tab')
      expect(b.chatSettings.set).toHaveBeenCalledWith('linkOpening', 'new-tab')
      injected.openExternalLink('http://example.test/selected')
      expect(open).toHaveBeenLastCalledWith('http://example.test/selected', '_blank', 'noopener,noreferrer')

      await b.chat.dispose()
      expect(b.runtime.slots.entries('settings.general.item').some(row => row.options.id === 'link-opening')).toBe(false)
      b.chatSettings.publish({ value: { ...settings, linkOpening: 'sidebar' } })
      expect(source.getSnapshot()).toBe('new-tab')
    } finally {
      open.mockRestore()
      await b.runtime.dispose()
    }
  })

  it('follows browser registration and routes absent browsers externally', async () => {
    const b = await bench()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const available = b.linkPreference.hooks.browserAvailable
    const changed = vi.fn()
    const unsubscribe = available.subscribe(changed)
    try {
      const { injected } = b.chatViewApi(b.rootReference)
      expect(available.getSnapshot()).toBe(true)
      b.browserAvailable.set(false)
      expect(available.getSnapshot()).toBe(false)
      expect(changed).toHaveBeenCalledOnce()
      injected.openExternalLink('https://example.test/disabled')
      expect(open).toHaveBeenCalledWith('https://example.test/disabled', '_blank', 'noopener,noreferrer')
      b.browserAvailable.set(true)
      injected.openExternalLink('https://example.test/enabled')
      expect(b.sidebarRight.openTab).toHaveBeenCalledWith('browser', { params: { url: 'https://example.test/enabled' } })
      expect(b.linkPreference.hooks.linkOpening.getSnapshot()).toBe('sidebar')
    } finally {
      unsubscribe()
      open.mockRestore()
      await b.runtime.dispose()
    }
  })

  it('keeps Chat available while the optional tab registry appears and leaves', async () => {
    const b = await bench(undefined, false)
    try {
      expect(b.runtime.slots.entries('conversation.view')).toHaveLength(1)
      expect(b.runtime.slots.entries('settings.general.item').some(row => row.options.id === 'link-opening')).toBe(false)
      const registry = await b.runtime.mount({
        apply(ctx) { ctx.provide('sidebarRightTabs', b.sidebarRightTabs as never) },
      })
      await vi.waitFor(() => {
        expect(b.runtime.slots.entries('settings.general.item').some(row => row.options.id === 'link-opening')).toBe(true)
      })
      await registry.dispose()
      expect(b.runtime.slots.entries('settings.general.item').some(row => row.options.id === 'link-opening')).toBe(false)
      expect(b.runtime.slots.entries('conversation.view')).toHaveLength(1)
    } finally {
      await b.runtime.dispose()
    }
  })

  it('keeps local link choices usable when settings cannot persist', async () => {
    const b = await bench()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    try {
      const { injected } = b.chatViewApi(b.rootReference)
      b.chatSettings.publish({ status: 'unavailable' })
      b.chatSettings.set.mockResolvedValueOnce(false)
      b.linkPreference.setLinkOpening('new-tab')
      b.chatSettings.publish({ value: undefined })
      injected.openExternalLink('https://example.test/local')
      expect(open).toHaveBeenCalledWith('https://example.test/local', '_blank', 'noopener,noreferrer')
      expect(b.sidebarRight.openTab).not.toHaveBeenCalled()

      b.chatSettings.set.mockRejectedValueOnce(new Error('settings unavailable'))
      b.linkPreference.setLinkOpening('sidebar')
      await Promise.resolve()
      injected.openExternalLink('https://example.test/local-sidebar')
      expect(b.sidebarRight.openTab).toHaveBeenCalledWith('browser', { params: { url: 'https://example.test/local-sidebar' } })
    } finally {
      open.mockRestore()
      await b.runtime.dispose()
    }
  })

  it('leaves skill preview injection to the skill reference owner', async () => {
    const b = await bench()
    try {
      const { injected } = b.chatViewApi(b.rootReference)
      expect(injected).not.toHaveProperty('openSkill')
    } finally {
      await b.runtime.dispose()
    }
  })

  it('keeps a relative path under the Session without a cwd, and addresses a path outside the workspace absolutely', async () => {
    const b = await bench()
    const NO_CWD = 'root-2' as SessionId
    await b.runtime.sessions.add({
      id: NO_CWD,
      summary: { title: 'N', displayTitle: 'N' },
      session: sessionFakeFor(),
    })
    using reference = b.runtime.sessions.retain(NO_CWD)
    const { injected } = b.chatViewApi(reference)
    // The Host resolves the relative path against the root it holds for the
    // Session; the Client need not know it.
    await injected.openFile('src/a.ts')
    expect(b.sidebarRight.openResource).toHaveBeenCalledWith('dsh-resource://file/session/root-2/src/a.ts')
    // An absolute path outside every known root still names its Session.
    await injected.openFile('/abs/a.ts')
    expect(b.sidebarRight.openResource).toHaveBeenLastCalledWith('dsh-resource://file/session/root-2//abs/a.ts')
    await b.runtime.dispose()
  })

  it('fails loud when a Chat View inject resolves no Session', async () => {
    const b = await bench()
    const entry = b.runtime.slots.entries('conversation.view')[0]!
    const injectView = entry.inject as unknown as (
      sessionId: SessionId,
      actions: ChatActions,
    ) => ChatViewInjected
    expect(() => injectView('never-listed' as SessionId, {} as ChatActions))
      .toThrow(/unknown session/)
    const flowEntry = b.runtime.slots.entries('conversation.chat.flow')[0]!
    const injectFlow = flowEntry.inject as (sessionId: SessionId) => ChatFlowDataInjected
    expect(() => injectFlow('never-listed' as SessionId)).toThrow(/unknown session/)
    await b.runtime.dispose()
  })

  it('owns image loading, scroll memory, and optional closing-file mentions', async () => {
    const b = await bench()
    const { injected } = b.chatViewApi(b.rootReference)
    const owner = {} as never

    const flow = b.chatFlowApi(b.rootReference)
    expect(flow.instance).toBe(b.chatViewApi(b.rootReference).instance)
    expect(flow.injected.keyedHooks.chatNode('missing')).toBe(injected.keyedHooks.chatNode('missing'))
    expect(flow.injected.keyedHooks.chatNodeProcess('missing')).toBe(injected.keyedHooks.chatNodeProcess('missing'))
    expect(flow.injected.keyedHooks.chatNodeBottom('missing')).toBe(injected.keyedHooks.chatNodeBottom('missing'))

    expect(injected.fileMentions(owner)).toBeUndefined()
    const mentions = { resolve: vi.fn() } as never
    const forClosing = vi.fn(() => mentions)
    b.runtime.ctx.provide('chatFileMentions', { forClosing } as never)
    expect(injected.fileMentions(owner)).toBe(mentions)
    expect(forClosing).toHaveBeenCalledWith(owner, ROOT)

    expect(injected.chatScroll.read()).toBeNull()
    const position = { anchorKey: 'node-1', anchorTop: 4, scrollTop: 12 }
    injected.chatScroll.save(position)
    expect(injected.chatScroll.read()).toEqual(position)
    injected.chatScroll.save(null)
    expect(injected.chatScroll.read()).toBeNull()

    const loaded = await injected.loadImage(ATTACHMENT)
    expect(loaded).toEqual(expect.any(String))
    expect(b.session.readAttachment).toHaveBeenCalledWith(ATTACHMENT.attachmentId)
    expect(injected.loadImage.peek?.(ATTACHMENT)).toBe(loaded)
    await b.runtime.dispose()
  })
})
