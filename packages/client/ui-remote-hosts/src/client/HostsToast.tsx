/** Operation feedback hosted outside the Hosts page lifetime. */
import type { ReactNode } from 'react'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { HostsPanelInjected } from './HostsPanel.tsx'

/** Shared notice source and dismissal callback. */
export type HostsToastProps = InjectFace<Pick<HostsPanelInjected, 'hooks' | 'dismissNotice'>>

/**
 * Show save and connection outcomes after page navigation.
 * @param props - Framework-bound notice hook and dismissal operation.
 * @returns Current transient notice, or null.
 */
export function HostsToast({ useHosts, dismissNotice }: HostsToastProps): ReactNode {
  const notice = useHosts(state => state.notice)
  if (notice === null) return null
  return <Toast key={notice.seq} text={notice.text} {...notice.tone === 'success' ? { tone: 'success' as const } : {}}
    icon={<IconWarningOutlineRegular />} onDone={dismissNotice} />
}
