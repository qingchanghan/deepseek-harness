/** Local connection draft using the shared, focus-managed modal and form controls. */
import { useId, useState, type ReactNode } from 'react'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteHostEntry } from '@deepseek-ai/dsh-api-remotes/client'
import type { Translate } from './locales.ts'
import css from './HostsPanel.module.css'

/** A connection editor's data and save operation. */
export interface HostEditorProps {
  readonly entry: RemoteHostEntry | undefined
  readonly save: (entry: RemoteHostEntry) => Promise<boolean>
  readonly close: () => void
  readonly t: Translate
}

/**
 * Edit one connection without discarding a rejected draft.
 * @param props - Existing connection or a new draft, save action, and localized copy.
 * @returns Focus-contained connection editor.
 */
export function HostEditor({ entry, save, close, t }: HostEditorProps): ReactNode {
  const formId = useId()
  const [id] = useState(() => entry?.id ?? `host-${randomUUID()}`)
  const [name, setName] = useState(entry?.name ?? '')
  const [target, setTarget] = useState(entry?.sshTarget ?? '')
  const [port, setPort] = useState(entry?.sshPort?.toString() ?? '')
  const [home, setHome] = useState(entry?.remoteHome ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (): Promise<void> => {
    const sshTarget = target.trim()
    const sshPort = port === '' ? undefined : Number(port)
    if (!/^[^\s-][^\s]*$/u.test(sshTarget)) { setError(t('editor.invalidTarget')); return }
    if (sshPort !== undefined && (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535)) {
      setError(t('editor.invalidPort')); return
    }
    setError(null)
    setBusy(true)
    try {
      if (await save({ id, name: name.trim() || sshTarget, sshTarget,
        ...sshPort === undefined ? {} : { sshPort }, ...home.trim() === '' ? {} : { remoteHome: home.trim() },
      })) close()
    } finally { setBusy(false) }
  }
  return (
    <Modal open title={t(entry === undefined ? 'editor.addTitle' : 'editor.editTitle')}
      description={t('editor.description')} closeLabel={t('editor.close')} onClose={() => { if (!busy) close() }}
      footer={<>
        <Button disabled={busy} onClick={close}>{t('editor.cancel')}</Button>
        <Button variant="primary" type="submit" form={formId} disabled={busy}>{t('editor.save')}</Button>
      </>}
    >
      <form id={formId} className={css.form} onSubmit={(event) => { event.preventDefault(); void submit() }}>
        <label className={css.field}>
          <span>{t('editor.name')}</span>
          <Input value={name} onChange={(event) => { setName(event.target.value) }} disabled={busy} />
        </label>
        <label className={css.field}>
          <span>{t('editor.target')}</span>
          <Input data-modal-autofocus value={target} onChange={(event) => { setTarget(event.target.value) }} disabled={busy} required />
          <span className={css.hint}>{t('editor.targetHelp')}</span>
        </label>
        <label className={css.field}>
          <span>{t('editor.port')}</span>
          <Input type="number" min={1} max={65535} step={1} value={port} onChange={(event) => { setPort(event.target.value) }} disabled={busy} />
        </label>
        <label className={css.field}>
          <span>{t('editor.home')}</span>
          <Input value={home} onChange={(event) => { setHome(event.target.value) }} disabled={busy} />
          <span className={css.hint}>{t('editor.homeHelp')}</span>
        </label>
        {error === null ? null : <p role="alert" className={css.error}>{error}</p>}
      </form>
    </Modal>
  )
}
