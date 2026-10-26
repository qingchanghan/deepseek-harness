/**
 * Configuration and observation types for SSH-attached remote Hosts.
 * @module @deepseek-ai/dsh-api-remote-hosts/types
 */

import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** Workspace offered by an attached Host for a new conversation. */
export interface RemoteHostWorkspace {
  /** Identity interpreted only by the selected Host. */
  readonly workspaceId: WorkspaceId
  /** Absolute working directory on that Host. */
  readonly path: string
  /** User-facing Workspace title. */
  readonly title: string
}

/** One SSH development machine this Host may attach to. */
export interface RemoteHostEntry {
  /** Stable identity used by routing and displayed grouping. */
  readonly id: string
  /** Display name, for example `H20-141-sy`; defaults to {@link id}. */
  readonly name?: string
  /** OpenSSH host alias, `user@host`, or host name. */
  readonly sshTarget: string
  /** OpenSSH port; omitted uses the client's own SSH configuration. */
  readonly sshPort?: number
  /** Remote Harness home; omitted resolves `$DSH_HOME` then `~/.dsh` remotely. */
  readonly remoteHome?: string
}

/** Attachment lifecycle of one configured host. */
export type RemoteHostStatusKind = 'idle' | 'connecting' | 'connected' | 'error'

/** One configured host as observed by a Client. */
export interface RemoteHostStatus extends RemoteHostEntry {
  /** Stable identity. */
  readonly id: string
  /** Display name. */
  readonly name: string
  /** Current attachment lifecycle. */
  readonly status: RemoteHostStatusKind
  /** Failure description while {@link status} is `error`, otherwise omitted. */
  readonly error?: string
  /** Remote process id of the attached Web instance. */
  readonly pid?: number
}

/** Configured connections and their current edit revision. */
export interface RemoteHostsSnapshot {
  /** All configured hosts, including disconnected and failed connections. */
  readonly hosts: RemoteHostStatus[]
  /** Whether the current profile supports persistent connection edits. */
  readonly writable: boolean
  /** Revision required when replacing the configured host list. */
  readonly revision: number
}

/** One revision-checked replacement of the configured connections. */
export interface RemoteHostsUpdate {
  /** Complete connection list, including unchanged hosts. */
  readonly hosts: RemoteHostEntry[]
  /** Revision returned by the last describe call. */
  readonly expectedRevision: number
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A configured host or its connection state changed.
     * @mode emit
     */
    'remote-hosts/changed'(): void
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A connection edit could not be validated or persisted. */
    'remote-hosts/configuration-rejected': { readonly reason: string }
    /** Connection settings changed after the editor read them. */
    'remote-hosts/conflict': { readonly expected: number; readonly actual: number }
    /** A requested connection no longer exists. */
    'remote-hosts/not-found': { readonly id: string }
    /** The selected Host has no usable connection. */
    'remote-hosts/not-connected': { readonly id: string }
  }
}
