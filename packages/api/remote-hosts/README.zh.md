---
description: "把本机 Host 连接到 SSH 开发机上的 dsh Web 进程，将远程会话并入本地目录，并把会话操作路由到所属机器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-remote-hosts

[English](README.md) | 中文

## 概述

`dsh-api-remote-hosts` 把本地 Host 连接到 SSH 开发机上已有的 `dsh web` 进程。它发现远程实例、转发监听器、完成鉴权并维护连接。Session Controller 合并远程目录，并把会话操作路由给所属机器。连接管理可保存 profile 设置、报告失败、断开和重连。远程事件更新活动与标题，审批和提问则使用本地交互界面。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在 Web profile 中挂载该行并列出可连接的开发机。连接要求该机器上有正在运行、且启用了实例公告的 `dsh web`。

```yaml
- id: remote-hosts
  name: '@deepseek-ai/dsh-api-remote-hosts'
  config:
    hosts:
      - id: h20
        name: H20-141-sy
        sshTarget: H20-141-sy
    timeoutMs: 30000
    connectOnStart: true
```

`sshTarget` 是一个已配置好的 OpenSSH 目标；本服务以 `BatchMode=yes` 调用 `ssh`，从不提示或保存凭据。`retryDelayMs` 与 `maxRetryDelayMs` 限定失败连接后的倍增重试，因为开发机可能在本 Host 启动之后才运行 `dsh web`。远端 Harness home 不是 `$DSH_HOME` 或 `~/.dsh` 时用 `remoteHome` 指定。插件激活时会连接每台配置的主机，生命周期变化通过 `remote-hosts/changed` 报告。

在侧边栏打开**主机**，即可添加或编辑连接、查看错误并重新连接。页面通过带修订号校验的 Settings 写入，把 `hosts` 保存在当前 profile 中。主机断开或没有会话时仍然可见；移除连接会保留远端会话。SSH 发现、HTTP 请求和 socket 握手使用 `timeoutMs`；断开连接和插件卸载会取消所属任务并关闭 SSH 转发。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

连接时读取 `<remoteHome>/web-instances/*.json` 的全部描述，选择最新的一条，并打开 `ssh -N -L 127.0.0.1:<local>:<host>:<port>`。就绪信号是本地端口可以建立连接，因为 OpenSSH 只在控制通道上报告转发成功。客户端用描述中的启动 token 在 `/connect` 换取 API Cookie，随后一元调用走 `/api/<endpoint>`，所有流共用一条 `/api/remote.mux` socket，符合每个 API Peer 只拥有一个 socket 的约束。

一元调用转发使用共享的 Connection 解析器处理 JSON 与 multipart 字节结果，包括文件预览。失败保留远端错误码和详情。Session Controller 将远程控制基线与实时投影合并到 Local 状态，因此远程队列与 steering（中途引导）无需重新打开会话即可更新。

`describe()` 返回 `RemoteHostsSnapshot`：其中每个 `RemoteHostStatus` 包含连接配置字段、显示名、生命周期状态，以及可选的错误信息或进程 id；快照还报告设置是否可写及其修订号。`setHosts(RemoteHostsUpdate)` 接收完整的连接列表与 `expectedRevision`；修订号过期时会拒绝写入，避免覆盖其他编辑。`reconnect(id)` 与 `disconnectHost(id)` 返回相同的快照。Host 消费方通过 `connected()` 获取 `RemoteHostHandle`，并调用其 `invoke(endpoint, args, signal?)` 与 `stream(endpoint, payload, signal?)`。

`$events` 的 emit 在本地重新发布。审批和提问通过交互桥到达本地浏览器；没有本地应答者时，请求交回远端链路。连接变化会使会话目录失效，浏览器据此读取当前主机列表。

</details>


`followWorkspaces(id, signal)` 校验所连接 Host 的 `workspace/follow` 基线与增量，并持续产出完整的 `RemoteHostWorkspaces` 快照，直到取消。快照保留工作区顺序、会话归属、创建与更新时间、归档和置顶状态。无效帧或流意外关闭会明确报错；消费方保留最后一次成功的快照并提供重试。`workspaces(id, signal)` 只读取第一个快照并释放流。`createWorkspace(id, path)` 通过 `workspace/create` 将已有远程目录加入工作区。这些方法要求主机已连接，保留远程标识，不修改本地 Workspace 注册表。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

None.

</details>

<a id="model-experience"></a>
## 模型体验

无。连接只在两个 Host 之间搬运已经组装好的会话数据，不注册任何面向模型的能力。

#### KV Cache 影响

无直接影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **远端审批需要浏览器应答** — `approval/request` 与 `user-questions/request` 会桥接到本地浏览器既有的审批界面；没有已连接的应答浏览器时交回远端链路，远端也没有应答者则按失败关闭。
- **不支持 HTTPS** — 连接要求通过 SSH 转发访问远端 HTTP 监听。
- **内容搜索仍为本地** — `session/search` 尚未到达所连接的 Host。
