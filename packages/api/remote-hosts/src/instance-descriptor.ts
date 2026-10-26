/**
 * Publish this Web process as an attachable instance.
 *
 * A peer reaches a running Web GUI through the URL printed at startup, which
 * carries the process launch token. That URL lives only in the terminal, so a
 * process that should later be attached to over SSH also records an equivalent
 * descriptor below the Harness home. The file is private to the owning user;
 * readers must treat a stale descriptor (its process is gone) as absent.
 * @module @deepseek-ai/dsh-web-app/instance-descriptor
 */

import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Directory below the Harness home holding one descriptor per Web process. */
export const WEB_INSTANCE_DIRECTORY = 'web-instances'

/** Descriptor format version; a reader refuses an unknown version. */
export const WEB_INSTANCE_DESCRIPTOR_VERSION = 1 as const

/** Stable file-name suffix shared by writers and readers. */
export const WEB_INSTANCE_FILE_SUFFIX = '.json'

/** One running Web GUI, as recorded for a local or SSH-attached client. */
export interface WebInstanceDescriptor {
  /** Descriptor format version written by this process. */
  readonly version: typeof WEB_INSTANCE_DESCRIPTOR_VERSION
  /** Process id that wrote the descriptor; a reader treats a dead pid as stale. */
  readonly pid: number
  /** ISO-8601 start time, used only to order several live instances. */
  readonly startedAt: string
  /** Listener scheme; a peer derives the tunnel target from it. */
  readonly protocol: 'http:' | 'https:'
  /** Listener bind address the peer tunnels to. */
  readonly host: string
  /** Listener port the peer tunnels to. */
  readonly port: number
  /**
   * Authenticated root URL including the process launch token. Reading it
   * grants the same authority as seeing the startup URL, so the file mode is
   * owner-only.
   */
  readonly url: string
  /** Absolute Harness home that contains this descriptor. */
  readonly home: string
}

/**
 * Directory holding instance descriptors.
 * @param dshHome - absolute Harness home.
 * @returns the descriptor directory path.
 */
export function webInstanceDirectory(dshHome: string): string {
  return join(dshHome, WEB_INSTANCE_DIRECTORY)
}

/**
 * Descriptor path of one process.
 * @param dshHome - absolute Harness home.
 * @param pid - process id, defaulting to this process.
 * @returns the descriptor file path for that pid.
 */
export function webInstancePath(dshHome: string, pid: number = process.pid): string {
  return join(webInstanceDirectory(dshHome), `${String(pid)}${WEB_INSTANCE_FILE_SUFFIX}`)
}

/**
 * Build the descriptor this process publishes.
 * @param input - Listener facts, the authenticated URL, Harness home, and start time.
 * @returns the complete descriptor value.
 */
export function webInstanceDescriptor(input: {
  readonly protocol: 'http:' | 'https:'
  readonly host: string
  readonly port: number
  readonly url: string
  readonly home: string
  readonly pid?: number
  readonly startedAt?: string
}): WebInstanceDescriptor {
  return {
    version: WEB_INSTANCE_DESCRIPTOR_VERSION,
    pid: input.pid ?? process.pid,
    startedAt: input.startedAt ?? new Date().toISOString(),
    protocol: input.protocol,
    host: input.host,
    port: input.port,
    url: input.url,
    home: input.home,
  }
}

/**
 * Recognise one parsed descriptor.
 * @param value - untrusted JSON value.
 * @returns whether the value is a complete descriptor of the current version.
 */
export function isWebInstanceDescriptor(value: unknown): value is WebInstanceDescriptor {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record['version'] === WEB_INSTANCE_DESCRIPTOR_VERSION
    && typeof record['pid'] === 'number' && Number.isInteger(record['pid']) && record['pid'] > 0
    && typeof record['startedAt'] === 'string'
    && (record['protocol'] === 'http:' || record['protocol'] === 'https:')
    && typeof record['host'] === 'string' && record['host'].length > 0
    && typeof record['port'] === 'number' && Number.isInteger(record['port'])
    && typeof record['url'] === 'string' && record['url'].length > 0
    && typeof record['home'] === 'string' && record['home'].length > 0
}

/**
 * Write the process descriptor atomically, creating its directory owner-only.
 * A concurrent writer for the same pid replaces its own previous file, which
 * only happens when the same pid restarted within one filesystem lifetime.
 * @param dshHome - absolute Harness home.
 * @param descriptor - descriptor to publish.
 */
export async function writeWebInstance(dshHome: string, descriptor: WebInstanceDescriptor): Promise<void> {
  const directory = webInstanceDirectory(dshHome)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = webInstancePath(dshHome, descriptor.pid)
  const temporary = `${path}.${String(Date.now())}.tmp`
  await writeFile(temporary, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}

/**
 * Remove one process descriptor, ignoring a file another process replaced or
 * already removed.
 * @param dshHome - absolute Harness home.
 * @param pid - process id whose descriptor to remove.
 */
export async function removeWebInstance(dshHome: string, pid: number = process.pid): Promise<void> {
  await rm(webInstancePath(dshHome, pid), { force: true })
}
