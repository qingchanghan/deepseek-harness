/** Clipboard control with localized success and retry feedback. */
import { useState } from 'react'
import { Button } from './Button.tsx'
import { Tooltip } from './Tooltip.tsx'
import { IconCheckOutlineRegular, IconCopyOutlineRegular } from './icons/index.tsx'
import { writeClipboard } from './clipboard.ts'

/**
 * Copy the complete supplied text, independent of any visual truncation.
 * @param props - text and caller-owned copy, success, and failure labels.
 * @returns a compact clipboard button whose status remains until the text or result changes.
 */
export function CopyButton({ text, label, copiedLabel, failedLabel }: {
  readonly text: string
  readonly label: string
  readonly copiedLabel: string
  readonly failedLabel: string
}) {
  const [result, setResult] = useState<{ text: string; ok: boolean }>()
  const current = result?.text === text ? result : undefined
  const status = current === undefined ? label : current.ok ? copiedLabel : failedLabel
  return <Tooltip label={status} side="bottom">
    <Button size="sm" aria-label={status} aria-live="polite" data-copy-text={text} onClick={() => {
      void writeClipboard(text).then((ok) => { setResult({ text, ok }) })
    }}>
      {current?.ok ? <IconCheckOutlineRegular size={16} /> : <IconCopyOutlineRegular size={16} />}
    </Button>
  </Tooltip>
}
