/**
 * OpenSSH transport for remote Host attachment.
 *
 * Deployment-owned OpenSSH aliases supply authentication and host identity, as
 * they do for the SSH execution providers. This module runs non-interactive
 * commands (`BatchMode`) and opens one local forward per attached process; it
 * never prompts, stores, or forwards credentials of its own.
 * @module @deepseek-ai/dsh-api-remote-hosts/ssh
 */

import { spawn as spawnProcess, type ChildProcess } from 'node:child_process'
import { connect, createServer } from 'node:net'
import type { WebInstanceDescriptor } from './instance-descriptor.ts'

/** One SSH destination from the plugin configuration. */
export interface SshTarget {
  /** OpenSSH host alias, `user@host`, or plain host name. */
  readonly sshTarget: string
  /** OpenSSH port; omitted uses the client's own configuration. */
  readonly sshPort?: number
  /** Remote Harness home; omitted resolves `$DSH_HOME` then `~/.dsh` remotely. */
  readonly remoteHome?: string
  /** Connection and command deadline in milliseconds. */
  readonly timeoutMs: number
}

/** Process spawn hook; production uses `node:child_process`. */
export type SpawnProcess = typeof spawnProcess

/** One forwarded listener a tunnel owns. */
export interface Tunnel {
  /** Local port the forward listens on. */
  readonly port: number
  /** Stop forwarding and release the child process. */
  readonly close: () => Promise<void>
}

/** Marker separating descriptors printed by the discovery command. */
const INSTANCE_MARKER = '--DSH-INSTANCE--'

/**
 * Quote one script for the remote login shell.
 * @param script - POSIX shell script text.
 * @returns a single-quoted argument safe to append to an `ssh` command.
 */
export function shellQuote(script: string): string {
  return `'${script.replaceAll('\'', '\'\\\'\'')}'`
}

/**
 * Read the instances published on one SSH host.
 *
 * A host with no published instance returns an empty list: absence is a
 * normal state, not a transport failure.
 * @param target - destination and deadline.
 * @param signal - caller cancellation.
 * @param spawn - process hook.
 * @returns every readable descriptor, ordered by start time.
 */
export async function listRemoteInstances(
  target: SshTarget,
  signal?: AbortSignal,
  spawn: SpawnProcess = spawnProcess,
): Promise<WebInstanceDescriptor[]> {
  const home = target.remoteHome === undefined ? '"${DSH_HOME:-$HOME/.dsh}"' : shellQuote(target.remoteHome)
  const script = [
    `home=${home}`,
    'for f in "$home"/web-instances/*.json; do',
    '  if [ -f "$f" ]; then',
    '    pid=$(sed -n \'s/.*"pid"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p\' "$f" | head -n 1)',
    '    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then',
    '      continue',
    '    fi',
    `    printf '\\n${INSTANCE_MARKER}\\n'`,
    '    cat "$f"',
    '  fi',
    'done',
  ].join('\n')
  const output = await runSsh(target, script, signal, spawn)
  const descriptors: WebInstanceDescriptor[] = []
  for (const chunk of output.split(INSTANCE_MARKER)) {
    const text = chunk.trim()
    if (text === '') continue
    try {
      const parsed: unknown = JSON.parse(text)
      if (isDescriptor(parsed)) descriptors.push(parsed)
    } catch {
      // A partially written or foreign file is not an instance this process can use.
    }
  }
  return descriptors.sort((left, right) => left.startedAt.localeCompare(right.startedAt))
}

/**
 * Choose the newest live instance among the descriptors one host published.
 * @param descriptors - descriptors read from that host.
 * @param isAlive - remote liveness check; defaults to treating every descriptor as alive.
 * @returns the newest descriptor, or undefined when none is attachable.
 */
export function newestInstance(
  descriptors: readonly WebInstanceDescriptor[],
  isAlive: (descriptor: WebInstanceDescriptor) => boolean = () => true,
): WebInstanceDescriptor | undefined {
  return descriptors.filter(isAlive).at(-1)
}

/**
 * Open one local forward to the remote listener.
 *
 * The forwarding child is owned by the returned handle; `ExitOnForwardFailure`
 * makes a refused forward reject instead of leaving a socket that silently
 * drops connections. Readiness is the local port accepting a TCP connection,
 * because OpenSSH reports a successful forward on its control channel only.
 * @param target - destination and deadline.
 * @param remote - remote listener address and port.
 * @param spawn - process hook.
 * @returns the local port and its owner.
 */
export async function openTunnel(
  target: SshTarget,
  remote: { readonly host: string; readonly port: number },
  spawn: SpawnProcess = spawnProcess,
): Promise<Tunnel> {
  const port = await freePort()
  const args = [
    ...sshArgs(target),
    '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-L', `127.0.0.1:${String(port)}:${remote.host}:${String(remote.port)}`,
    target.sshTarget,
  ]
  const child = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  let spawnFailure: Error | undefined
  child.once('error', (error: Error) => { spawnFailure = error })
  const closed = new Promise<void>((resolve) => { child.once('close', () => { resolve() }) })
  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      if (child.exitCode !== null || child.signalCode !== null) { await closed; return }
      child.kill('SIGTERM')
      const deadline = setTimeout(() => { child.kill('SIGKILL') }, target.timeoutMs)
      try { await closed } finally { clearTimeout(deadline) }
    })()
    return stopping
  }
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  try {
    await waitForPort(port, target.timeoutMs, child, () => spawnFailure)
  } catch (error: unknown) {
    await stop()
    const reason = stderr.trim().split('\n').at(-1)
    throw new Error(
      `ssh forward to ${target.sshTarget} failed: ${reason === undefined || reason === '' ? String(error) : reason}`,
      { cause: error },
    )
  }
  return { port, close: stop }
}

/**
 * Run one script through the destination's login shell and collect stdout.
 * @param target - destination, deadline, and optional home override.
 * @param script - POSIX shell script.
 * @param signal - caller cancellation.
 * @param spawn - process hook.
 * @returns the complete standard output.
 */
async function runSsh(
  target: SshTarget,
  script: string,
  signal: AbortSignal | undefined,
  spawn: SpawnProcess,
): Promise<string> {
  signal?.throwIfAborted()
  // `ssh` joins the arguments after the destination with spaces and hands the
  // text to the remote login shell, so the script travels as one raw argument.
  const child = spawn('ssh', [...sshArgs(target), '-T', target.sshTarget, script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { stdout += chunk })
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  const abort = (): void => { child.kill('SIGTERM') }
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => { child.kill('SIGTERM') }, target.timeoutMs)
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new Error('cancelled')
    if (code !== 0) {
      throw new Error(`ssh ${target.sshTarget} exited with ${String(code)}: ${stderr.trim()}`)
    }
    return stdout
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

/**
 * Common non-interactive `ssh` options.
 * @param target - destination and deadline.
 * @returns arguments placed before the destination.
 */
function sshArgs(target: SshTarget): string[] {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${String(Math.max(1, Math.ceil(target.timeoutMs / 1000)))}`,
    '-o', 'ServerAliveInterval=15',
  ]
  if (target.sshPort !== undefined) args.push('-p', String(target.sshPort))
  return args
}

/**
 * Reserve one loopback port by binding and releasing it.
 * @returns the port number the kernel assigned.
 */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('ssh forward could not reserve a local port')
  }
  const port = address.port
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  return port
}

/**
 * Wait until the forwarded local port accepts a connection.
 * @param port - local forwarding port.
 * @param timeoutMs - deadline.
 * @param child - forwarding process, whose early exit aborts the wait.
 * @param failure - spawn error observed before readiness.
 */
async function waitForPort(port: number, timeoutMs: number, child: ChildProcess, failure: () => Error | undefined): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const error = failure()
    if (error !== undefined) throw error
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('ssh exited before the forward was ready')
    const ready = await new Promise<boolean>((resolve) => {
      const socket = connect({ port, host: '127.0.0.1' })
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => { socket.destroy(); resolve(false) })
    })
    if (ready) return
    await new Promise<void>((resolve) => { setTimeout(resolve, 100) })
  }
  throw new Error('the ssh forward did not become reachable before the deadline')
}

/**
 * Recognize a descriptor published by `dsh web`.
 * @param value - untrusted parsed JSON.
 * @returns whether the value carries every field this client reads.
 */
function isDescriptor(value: unknown): value is WebInstanceDescriptor {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record['version'] === 1
    && typeof record['pid'] === 'number'
    && typeof record['startedAt'] === 'string'
    && (record['protocol'] === 'http:' || record['protocol'] === 'https:')
    && typeof record['host'] === 'string'
    && typeof record['port'] === 'number'
    && typeof record['url'] === 'string'
    && typeof record['home'] === 'string'
}
