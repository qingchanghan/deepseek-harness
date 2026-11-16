/** Clipboard outcomes outlive the conversation that requested the copy. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { NS } from '../locale.ts'

/** Latest file-copy gesture and its settled outcome. */
export interface FileCopyNotice {
  seq: number
  outcome: 'copied' | 'failed' | 'unresolved'
}

/** App-wide clipboard feedback and dismissal. */
export interface FileCopyToastInjected {
  hooks: { notice: ObservableSnapshot<FileCopyNotice | null> }
  dismissNotice: () => void
}

/**
 * Show the latest clipboard result outside the conversation's lifetime.
 * @param props - Clipboard outcome, dismissal, and localized copy.
 * @returns A transient success or failure toast, or nothing before a copy settles.
 */
export function FileCopyToast({ useNotice, dismissNotice, t }: InjectFace<FileCopyToastInjected> & PropsLocale<typeof NS>) {
  const notice = useNotice(value => value)
  if (notice === null) return null
  return <Toast key={notice.seq} text={t(`fileCopy.${notice.outcome}`)} onDone={dismissNotice}
    {...notice.outcome === 'copied' ? { tone: 'success' as const } : { icon: <IconWarningOutlineRegular /> }} />
}
