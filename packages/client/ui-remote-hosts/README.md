---
description: "Add and manage SSH development-machine connections, inspect connection failures, and browse local and remote Sessions by host."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-remote-hosts

English | [中文](README.zh.md)

## Summary

Use **Hosts** to add SSH development machines and browse their Sessions beside local Sessions. Connection states and errors stay visible even when a machine has no Sessions. You can edit, disconnect, reconnect, or remove a connection without editing YAML.

## Table of Contents

- [Use this package](#use-this-package)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The Web bundle loads this plugin. Open **Hosts** near the top of the sidebar, select **Add remote host**, and enter an existing OpenSSH host alias or `user@hostname`. You can supply a display name, SSH port, and remote Harness data directory. The remote machine needs a running `dsh web` process; see the [connection prerequisites](../../api/remote-hosts/README.md#use-this-package).

Saving writes the active profile and starts the connection. The host row shows its status and any connection error. Use **Reconnect** to retry immediately or **Disconnect** to stop automatic retries. **Remove** deletes the saved connection settings and preserves remote Sessions. Concurrent configuration edits are refused; close and reopen the editor to read the current settings.

Local Sessions appear first, followed by remote hosts in display-name order. Each group's Sessions follow recent activity. Select a Session to read its history or continue the conversation. Connected-host changes refresh the catalog automatically, including when the first list request is still running. Subagent children and blank navigation Sessions do not become rows.

The sidebar workspace area shows **Local** and remote hosts, with collapsible Workspaces under each host. Remote membership, Workspace names and order, archive state, and pins update live. Unassigned Sessions appear under **Ungrouped**. Folder icons, Session activity indicators, relative times, hover cards, and the selected conversation use the Local row components. Sessions within each Workspace follow recent activity. Saved disconnected or failed hosts stay listed with their status; a failed Workspace stream retains its last successful rows and offers **Refresh**. **Manage remote hosts…** opens the connection page. Sidebar search filters remote Session titles; remote conversation content is not searched.


When remote hosts are configured, **New Session** opens a destination picker. Choose **Local** or a remote host, select its Workspace, and select **Create Session**. The picker defaults to the current conversation's host. The selected directory makes the blank conversation immediately usable while the remote Session catalog refreshes. To add a Workspace, enter an existing absolute directory on that host. Disconnected hosts must reconnect before listing Workspaces or creating Sessions; failures leave the picker open.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

<a id="model-experience"></a>
## Model Experience

None, as connection management and Session navigation register no model-facing capability.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **SSH authentication uses the existing client configuration** — the panel does not save passwords or private keys.
- **No per-host filters or search** — the page groups all visible Sessions.
