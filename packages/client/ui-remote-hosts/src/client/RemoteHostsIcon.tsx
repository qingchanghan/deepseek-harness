/** The sidebar Hosts entry glyph; the sidebar owns the button around it. */

import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the hosts glyph at the edge the sidebar asks for.
 * @param props - the sidebar's icon share.
 * @returns the icon element.
 */
export function RemoteHostsIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="1.75" y="2.25" width="12.5" height="5" rx="1.2" />
      <rect x="1.75" y="9.25" width="12.5" height="4.5" rx="1.2" />
      <path d="M4.25 4.75h.01M4.25 11.5h.01" />
      <path d="M10.5 4.75h1.75M10.5 11.5h1.75" />
    </svg>
  )
}
