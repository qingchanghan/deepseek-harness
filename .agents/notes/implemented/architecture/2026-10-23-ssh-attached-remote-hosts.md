# Agent Note: SSH-attached remote Hosts

Status: implemented

English | [中文](2026-10-23-ssh-attached-remote-hosts.zh.md)

## Problem

Developers run coding agents on the machine that holds the checkout, the build cache, and the GPUs, while the interface they sit in front of is somewhere else. The Harness already reaches a remote execution world through the [POSIX SSH providers](2026-09-11-posix-ssh-runtime.md), but that model keeps the Host local and moves only files, processes, and terminals. It cannot show the Sessions a `dsh web` process on the development machine already owns, and it cannot let the local interface continue one of those conversations.

The Web and desktop clients connect to exactly one Host. `ctx.connection` owns one transport generation, `ctx.remote` one generated Remote assembly, and the Session catalog, history streams, and sidebar all assume that Host. A remote development machine therefore cannot appear beside the local one by pointing a browser at another URL without leaving the local interface, its workspace grouping, and its settings.

## Decision

One configured OpenSSH destination becomes one attached Host inside the local Host. The local Host stays the only process the client connects to; it is simultaneously a Client of each attached remote Host.

### Instance attachment

`dsh web` publishes a private descriptor below `$DSH_HOME/web-instances/<pid>.json` once its listener is ready. The descriptor carries the listener address, the authenticated root URL (including the process launch token), the owning pid, and the Harness home. Only the owning user can read it, and the process removes it on unload. This is what makes attachment mean "join the process that is already running" rather than "start a second writer beside it".

Attachment reads every descriptor over SSH, chooses the newest live one, and opens `ssh -N -L 127.0.0.1:<free>:<host>:<port>`. OpenSSH reports a successful forward on its control channel before the listener is reachable, so readiness is a TCP connection to the local port. The client exchanges the launch token at `/connect` for an API cookie and then speaks the public wire protocol: `/api/<endpoint>` for unary calls and one `/api/remote.mux` socket for every stream. Speaking the wire contract instead of mounting the remote package's generated Client contribution keeps the local Host independent of the remote Harness version.

A failed attachment retries with doubling delay, because a development machine may start `dsh web` after the local Host booted. Operator disconnect and plugin unload stop the retries.

### Session federation

`session/list` merges each attached Host's catalog into the local list and annotates every remote row with `host: { id, name }`. A row whose identity a local Session already uses stays local. The Session Controller keeps each remote Session's owner across disconnects and routes Session operations there. Its Gateway forwarder resolves Session resources before local lookup or Agent activation, covering command catalogs and workspace files as well. Success values retain binary attachments, and remote failures keep their code and details. Forwarding accepts owner calls only: the attached transport cannot represent another principal's authority. Uplink streams are refused until that transport can carry them.

The federated control stream publishes one combined Local and remote baseline before live projection updates. This keeps inbox queues, steering, Goals, and todos on the same observable path. Host membership changes restart the stream, and cancellation or one source failure closes every follower.

The remote `$events` stream is consumed by the attachment itself. `api-session/*` notifications are republished as the same local Cordis events, so running state, titles, and activity reach the browser exactly like a local Session's. A forwarded `approval/request` or `user-questions/request` enters the local application bridge: the Gateway delivers it to every answering browser exactly like a local waterfall, the first answer returns to the remote Host, and the synthetic Agent Context is disposed when the question settles. Without an answering browser, or for every other waterfall, the frame is answered with `next` so the remote chain keeps its own answerers.

### Presentation

The browser learns nothing about attachment. Remote rows are ordinary catalog rows with one extra annotation; the new **Hosts** panel groups the catalog as Local first and then one section per attached machine, and opens any row through the ordinary Conversation view. The Workspace browser omits hosted rows so a Session never appears in two navigation trees.

## Alternatives considered

**Point the browser at the remote URL.** The remote GUI would run natively with full fidelity, but the local interface and its grouping would be left behind, which is the problem being solved. Embedding it is refused by the Host/Origin and `sec-fetch-site` trust fence, and its absolute `/api` paths cannot be remounted under a local prefix without changing the remote application.

**Mount a second Client tree in the browser.** Each remote could own an isolated Connection and Remote assembly, but every UI store and Conversation consumer addresses one catalog, so the Session object layer, history adapters, and panel registries would all need a source dimension. Merging at the Host keeps those layers single-source.

**Run the whole Harness on the remote machine.** That is the existing remote-execution arrangement inverted: model credentials, Session storage, and the interface would move with the checkout. The developer wants the remote files and the local window, not a remote account boundary.

**Start a managed remote `dsh web` when none is published.** A second process on the same Harness home would contend for Session writer locks and split the user's terminal and the attached view into different processes. Discovery of the published instance is what keeps one writer.

## Consequences

The local Host now owns SSH child processes, tunnels, API cookies, and reconnection, and every Session-addressed method must keep its remote delegation consistent with the local implementation. Attachment requires a plain-HTTP listener reachable from the SSH destination; HTTPS descriptors are rejected explicitly.

Remote approvals reach the local browser only while one is connected and retains the Session; otherwise they are delegated to the remote chain, which fails closed when it has no answerer. `session/create` accepts an explicit attached Host and registers the returned identity before history or prompts can follow it; `session/search` remains local. The destination picker reads the remote Workspace baseline and can adopt an existing remote directory without registering it locally. The Hosts panel saves connection entries in the profile's `remote-hosts` row through revision-checked settings updates; disconnect preserves that configuration and suppresses retries until reconnection or application restart.

The attachment owner treats event-stream completion and missed WebSocket heartbeat replies as lost connectivity. A local watchdog is necessary because server-side heartbeats cannot report a half-open tunnel to this process. Recovery rediscovers the remote descriptor and rebuilds subscriptions; it never replays a prompt or mutation whose outcome is unknown. Only event-stream readiness resets retry backoff, so a reachable HTTP listener with a failing event socket cannot create a rapid retry loop.

## Testing

The attachment transport is covered by unit tests for descriptor publication, SSH command construction, descriptor parsing, and forwarding arguments. The wire client, the federated list, routed rename and follow, and prompt admission were exercised against two real `dsh web` processes joined by a local SSH substitute that implemented the forward, with the remote catalog row carrying `host: H20-141-sy`. Client coverage renders the Hosts panel over a catalog with Local and two attached rows and asserts grouping and navigation.
