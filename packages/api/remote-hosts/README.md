---
description: "Attach the local Host to dsh Web processes on SSH development machines, merge their Sessions into the local catalog, and route Session operations to the owning machine."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-remote-hosts

English | [中文](README.zh.md)

## Summary

`dsh-api-remote-hosts` attaches the local Host to existing `dsh web` processes on SSH development machines. It discovers remote instances, forwards their listeners, authenticates, and maintains their connections. The Session Controller merges remote catalogs and routes Session operations to the owning machine. Connection management saves profile settings, reports failures, and supports disconnecting and reconnecting. Remote events keep activity and titles current, while approval and question requests use the local interaction UI.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the row in a Web profile and list the development machines it may attach to. Attachment needs a running `dsh web` on that machine whose instance announcement is enabled.

```yaml
- id: remote-hosts
  name: '@deepseek-ai/dsh-api-remote-hosts'
  config:
    hosts:
      - id: h20
        name: H20-141-sy
        sshTarget: H20-141-sy
    timeoutMs: 30000
    heartbeatIntervalMs: 15000
    connectOnStart: true
```

`sshTarget` is an existing OpenSSH destination; the service runs `ssh` with `BatchMode=yes` and never prompts or stores credentials. `retryDelayMs` (5 seconds by default) and `maxRetryDelayMs` (60 seconds) bound automatic retries after failed attachment or lost connectivity. Each attempt rediscovers the running instance, including its current port and launch token. The retry delay resets when the remote event stream announces readiness. `remoteHome` names the remote Harness home when it is not `$DSH_HOME` or `~/.dsh`. Each configured host attaches when the plugin activates, and `remote-hosts/changed` reports lifecycle changes.

Open **Hosts** in the sidebar to add or edit connections, inspect failures, and reconnect. The page saves `hosts` in the active profile through revision-checked Settings writes. It keeps configured hosts visible while disconnected or empty; removing a connection preserves remote Sessions. SSH discovery, HTTP requests, socket handshakes, and heartbeat replies use `timeoutMs`. The client sends WebSocket probes at `heartbeatIntervalMs`; a missing reply, socket failure, or ended event stream triggers reconnection. Calls and prompts are never replayed automatically. Disconnect and plugin disposal cancel owned work, probes, and retries, and close the SSH forward.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Attachment reads every `<remoteHome>/web-instances/*.json`, chooses the newest descriptor, and opens `ssh -N -L 127.0.0.1:<local>:<host>:<port>`. Readiness is the local port accepting a connection, because OpenSSH reports forwarding success only on its control channel. The client exchanges the descriptor's launch token at `/connect` for an API cookie, then uses `/api/<endpoint>` for unary calls and one `/api/remote.mux` socket for every stream, matching the one-socket-per-API-Peer rule.

Unary forwarding uses the shared Connection parser for JSON and multipart byte results, including file previews. Failures retain the remote code and details. The Session Controller combines remote control baselines and live projections with Local state, so remote queues and steering update without reopening the Session.

`describe()` returns a `RemoteHostsSnapshot`: every `RemoteHostStatus` includes its configured connection fields, display name, lifecycle status, and optional error, process id, or `retryAt` (the next scheduled retry as epoch milliseconds); the snapshot also reports whether settings are writable and their revision. `setHosts(RemoteHostsUpdate)` accepts the complete connection list and `expectedRevision`; stale revisions fail without overwriting another edit. `reconnect(id)` and `disconnectHost(id)` return the same snapshot. Host consumers use `connected()` for `RemoteHostHandle` instances exposing `invoke(endpoint, args, signal?)` and `stream(endpoint, payload, signal?)`.

`$events` emits are republished locally. Approval and question requests reach the local browser through the interaction bridge; requests without a local answerer delegate back to the remote chain. Connection changes invalidate the Session catalog so browsers read the current host membership.

</details>


`followWorkspaces(id, signal)` validates the attached Host's `workspace/follow` baseline and increments, yielding complete `RemoteHostWorkspaces` snapshots until cancellation. Snapshots preserve Workspace order, membership, creation and update times, archives, and pins. Invalid frames and unexpected stream closure fail visibly; consumers retain their last successful snapshot while offering retry. `workspaces(id, signal)` reads only the first snapshot and releases the stream. `createWorkspace(id, path)` adopts an existing remote directory through `workspace/create`. These methods require a connected host, preserve remote identities, and do not modify the local Workspace registry.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

<a id="model-experience"></a>
## Model Experience

None, as attachment moves already-composed Session data between two Hosts and registers nothing model-facing.

#### KV Cache effect

No direct effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Remote approvals need an answering browser** — `approval/request` and `user-questions/request` are bridged into the local browser's normal approval UI; with no answering browser connected they are delegated back to the remote chain, which fails closed when it has no answerer of its own.
- **HTTPS is unsupported** — attachment requires a remote HTTP listener reached through the SSH forward.
- **Content search stays local** — `session/search` does not reach attached Hosts.
