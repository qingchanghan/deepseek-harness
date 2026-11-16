/**
 * The summary blank bit means "conversation not started" (no turn has run),
 * not "log empty": standalone plugin events — command lifecycle records,
 * plan/mode, permission knob events, session titles — never flip it, so running /plan or /goal on a
 * fresh session keeps it list-hidden and reusable, while the first accepted
 * prompt's turn/start clears it. The host/session-added frame shares the
 * same predicate function (covered by the workspace spec's frame assertion).
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
// Side-effect type imports: the configuration-event SessionEventMap merges.
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { createSessionTestRemote, type TestSessionRemote } from './test-remote.ts'
import { applySessionListMetadata } from '../src/list.ts'
import type { SessionListMetadata } from '../src/types.ts'

async function harness(): Promise<{ ctx: Context; remote: TestSessionRemote; attach: (session: Session) => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  return {
    ctx,
    remote: createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' }),
    attach: async (session) => {
      await ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
    },
  }
}

/** Append the standalone (non-conversation) event family a fresh session can accumulate. */
function appendStandalone(session: Session): void {
  session.append('command/run', {
    commandId: CommandId('blank-cmd-1'), name: 'plan', args: '', source: { kind: 'user' },
  })
  session.append('plan/mode', { active: true })
  session.append('command/done', { commandId: CommandId('blank-cmd-1'), kind: 'success', text: 'Plan mode on.' })
  session.append('session/title', {
    title: 'standalone title', messageSeqs: [], source: { kind: 'fallback' },
  })
  // Permission configuration events from a /permission switch on a fresh session.
  session.append('permission/preset', { preset: 'danger-full-access' })
  session.append('sandbox/mode', { mode: 'danger-full-access' })
}

async function listBlank(remote: TestSessionRemote, id: string): Promise<boolean | undefined> {
  const result = await remote.list({})
  if (!result.ok) throw new Error('list failed')
  return result.value.items.find(item => item.sessionId === id)?.blank
}

describe('summary blank = conversation not started', () => {
  it('promotes replies and tool progress above newer prompts and rebuilds the same activity from history', async () => {
    const { ctx, remote, attach } = await harness()
    const now = vi.spyOn(Date, 'now').mockReturnValue(1)
    try {
      const older = ctx.sessions.create(SessionId('activity-older'), { meta: { cwd: '/work' } })
      const newer = ctx.sessions.create(SessionId('activity-newer'), { meta: { cwd: '/work' } })
      await attach(older)
      await attach(newer)
      const activities = vi.fn()
      ctx.on('api-session/activity', activities)
      const ids = async () => {
        const result = await remote.list({})
        if (!result.ok) throw new Error('list failed')
        return result.value.items.map(item => item.sessionId)
      }
      const prompt = (session: Session, time: number) => {
        now.mockReturnValue(time)
        session.append('turn/start', { turn: 1 })
        session.append('user/message', createUserMessage({
          source: { kind: 'user' }, content: [{ type: 'text', text: 'work' }],
        }), { surfaceOp: 'append' })
      }
      prompt(older, 1000)
      prompt(newer, 2000)
      expect(await ids()).toEqual([newer.id, older.id])
      now.mockReturnValue(3000)
      older.append('assistant/message', {
        turn: 1, step: 1, stream: [],
        message: createAssistantMessage({
          source: { provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text: 'progress' }],
        }),
      }, { surfaceOp: 'append' })
      expect(await ids()).toEqual([older.id, newer.id])
      expect(activities).toHaveBeenLastCalledWith(older.id, 3000)
      now.mockReturnValue(4000)
      newer.append('session/title', { title: 'renamed', messageSeqs: [], source: { kind: 'fallback' } })
      expect(await ids()).toEqual([older.id, newer.id])
      expect(activities).toHaveBeenLastCalledWith(older.id, 3000)
      const callId = ToolCallId('activity-tool')
      const call = newer.append('tool/call', { turn: 1, step: 1, callId, name: 'read', arguments: '{}' })
      now.mockReturnValue(5000)
      newer.append('tool/result', {
        turn: 1, step: 1,
        message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'ready' }], isError: false }),
      }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
      expect(await ids()).toEqual([newer.id, older.id])
      expect(activities).toHaveBeenLastCalledWith(newer.id, 5000)
      const rebuilt = newer.snapshotEvents().reduce<SessionListMetadata>(applySessionListMetadata,
        { blank: true, lastPromptAt: null })
      expect(rebuilt).toEqual({ blank: false, lastPromptAt: 2000 })
      expect(ctx.sessionProjections.snapshot(newer).values.sessionActivity).toBe(5000)
      const replay = ctx.sessions.create(SessionId('activity-replayed'), { seed: newer.snapshotEvents() })
      expect(ctx.sessionProjections.snapshot(replay).values.sessionActivity).toBe(5000)
      now.mockReturnValue(4500)
      replay.append('step/end', { turn: 1, step: 1 })
      expect(ctx.sessionProjections.snapshot(replay).values.sessionActivity).toBe(5000)
    } finally {
      now.mockRestore()
      await ctx.fiber.dispose()
    }
  })

  it('standalone events (command lifecycle, plan/mode, title) keep the session blank', async () => {
    const { ctx, remote, attach } = await harness()
    const session = ctx.sessions.create()
    await attach(session)
    expect(await listBlank(remote, session.id)).toBe(true)
    appendStandalone(session)
    expect(await listBlank(remote, session.id)).toBe(true)
  })

  it('the first turn clears blank', async () => {
    const { ctx, remote, attach } = await harness()
    const session = ctx.sessions.create()
    await attach(session)
    appendStandalone(session)
    session.append('turn/start', { turn: 0 })
    expect(await listBlank(remote, session.id)).toBe(false)
  })
})
