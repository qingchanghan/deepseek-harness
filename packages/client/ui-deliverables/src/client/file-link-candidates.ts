/** Recorded file targets used to recover relative links outside the Session workspace. */
import type { ConversationTimelineSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { isAbsoluteWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import type {} from './turn-deliverables.ts'

/**
 * Match recorded targets or align a relative link's first directory with their ancestors.
 * @param path - parsed relative link, with no line anchor.
 * @param timeline - loaded Session turns containing successful mutations and deliveries.
 * @returns distinct absolute candidates; callers must verify existence and reject ambiguity.
 */
export function fileLinkCandidates(path: string, timeline: ConversationTimelineSnapshot): readonly string[] {
  const relative = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
  if (isAbsoluteWorkspacePath(relative) || relative.split('/').some(part => part === '..' || part === '')) return []
  const slash = relative.indexOf('/')
  const directory = `/${relative.slice(0, slash)}/`
  const candidates = new Set<string>()
  for (const turn of timeline.turns.values()) {
    const data = turn.data.get('deliverables')
    const files = [...data?.produced ?? [], ...data?.presented ?? []]
    for (const file of files) {
      if (!isAbsoluteWorkspacePath(file.path)) continue
      const absolute = file.path.replace(/\\/g, '/')
      if (absolute.endsWith(`/${relative}`) || ('argumentPath' in file && file.argumentPath === path)) candidates.add(file.path)
      // Bare names require a recorded exact target. Directory links may name
      // another descendant of an ancestor recorded by a successful output.
      if (slash > 0) {
        for (let index = absolute.indexOf(directory); index !== -1; index = absolute.indexOf(directory, index + 1)) {
          const candidate = `${absolute.slice(0, index + 1)}${relative}`
          candidates.add(file.path.includes('\\') ? candidate.replace(/\//g, '\\') : candidate)
        }
      }
    }
  }
  return [...candidates]
}
