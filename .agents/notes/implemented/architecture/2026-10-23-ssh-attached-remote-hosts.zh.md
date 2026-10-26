# Agent Note: SSH-attached remote Hosts

Status: implemented

[English](2026-10-23-ssh-attached-remote-hosts.md) | 中文

## Problem

开发者把编码 agent 放在持有代码、构建缓存和 GPU 的机器上运行，而自己面对的界面在另一处。Harness 已经能通过 [POSIX SSH providers](2026-09-11-posix-ssh-runtime.zh.md) 进入远端执行世界，但那个模型把 Host 留在本地，只搬运文件、进程和终端。它无法展示开发机上 `dsh web` 进程已经拥有的会话，也无法让本地界面继续其中某个对话。

Web 与桌面客户端只连接一个 Host。`ctx.connection` 拥有一个传输代际，`ctx.remote` 拥有一套生成的 Remote 装配，会话目录、历史流和侧边栏都假定只有这个 Host。因此，让浏览器指向另一个 URL 并不能把远程开发机并排放在本地旁边，除非离开本地界面、工作区分组和设置。

## Decision

一个配置好的 OpenSSH 目标成为本地 Host 内部的一台已连接 Host。本地 Host 仍是客户端唯一连接的进程；它同时是每台已连接远程 Host 的 Client。

### Instance attachment

`dsh web` 在监听器就绪后，把私有描述写入 `$DSH_HOME/web-instances/<pid>.json`。描述包含监听地址、带进程启动 token 的已鉴权根 URL、所属 pid 与 Harness home。只有属主可读，进程卸载时删除。正因如此，连接才表示"加入已经在运行的进程"，而不是"在旁边再起一个写入者"。

连接时经 SSH 读取全部描述，选择最新的存活实例，并打开 `ssh -N -L 127.0.0.1:<free>:<host>:<port>`。OpenSSH 在本地端口真正可达之前就会在控制通道上报告转发成功，因此就绪信号是对本地端口建立 TCP 连接。客户端用启动 token 在 `/connect` 换取 API Cookie，随后使用公开线协议：一元调用走 `/api/<endpoint>`，所有流共用一条 `/api/remote.mux` socket。直接说线协议、而不是挂载远端包生成的 Client contribution，使本地 Host 不依赖远端的 Harness 版本。

失败的连接会以倍增延迟重试，因为开发机可能在本地 Host 启动之后才运行 `dsh web`。运维断开与插件卸载会停止重试。

### Session federation

`session/list` 把每台已连接 Host 的目录并入本地列表，并为每个远端行标注 `host: { id, name }`。若某行的身份已被本地会话使用，则保留本地。Session Controller 从这次合并中记住每个远端会话的属主，并把 `follow`、`page`、`prompt`、`cancel`、队列编辑、projections、重命名、fork、模型选择与附件读取路由给属主 Host；成功值与流数据原样通过，远端失败转为本地 `gateway/internal` 错误并在消息中保留远端错误码。

远端的 `$events` 流由连接方自己消费。`api-session/*` 通知以同名 Cordis 事件在本地重新发布，因此运行状态、标题与活动时间像本地会话一样到达浏览器。转发的 `approval/request` 或 `user-questions/request` 会进入本地应用桥：Gateway 像本地 waterfall 一样把它交给每个正在应答的浏览器，第一个答案回传给远端 Host，问题落定后合成 Agent Context 会被释放。没有应答浏览器时，以及其他所有 waterfall，都以 `next` 回复，让远端应答链继续处理。

### Presentation

浏览器不知道连接的存在。远端行只是多了一个标注的普通目录行；新的 **主机** 面板按 Local 在最前、每台已连接机器一组的顺序分组，并通过普通对话视图打开任意一行。Workspace 浏览器忽略远端行，使同一会话不会出现在两棵导航树里。

## Alternatives considered

**让浏览器直接指向远端 URL。** 远端 GUI 可以全保真运行，但本地界面及其分组会被抛下，而这正是要解决的问题。嵌入它会被 Host/Origin 与 `sec-fetch-site` 信任围栏拒绝，其绝对 `/api` 路径不修改远端应用也无法重新挂载到本地前缀下。

**在浏览器里挂第二棵 Client 树。** 每个远端可以拥有隔离的 Connection 与 Remote 装配，但所有 UI store 与对话消费方都面向一个目录，Session 对象层、历史适配器与面板注册表都需要增加"来源"维度。在 Host 侧合并则让这些层保持单一来源。

**把整个 Harness 放到远端。** 那是现有远程执行安排的反向版本：模型凭据、会话存储与界面会随代码一起搬走。开发者要的是远端文件与本地窗口，而不是远端账号边界。

**没有已发布实例时托管启动远端 `dsh web`。** 同一 Harness home 上的第二个进程会争抢会话写入锁，并把用户的终端与连接视图拆成两个进程。发现已发布实例才保证只有一个写入者。

## Consequences

本地 Host 现在负责 SSH 子进程、隧道、API Cookie 与重连，并且每个按会话寻址的方法都必须让远端委托与本地实现保持一致。连接要求监听器使用明文 HTTP，且能从 SSH 目标访问；HTTPS 实例描述会被明确拒绝。

只有在有浏览器连接并持有该会话时，远端审批才会到达本地浏览器；否则交回远端链路，远端没有应答者时按失败关闭。实时控制流仍只在本地，因此已连接会话的 Goal 与 todo 投影要重新打开才刷新。`session/create` 接受明确指定的所连接 Host，并在历史订阅或消息发送前登记返回的标识；`session/search` 仍在本地。目标选择器读取远程 Workspace 基线，并可将已有远程目录加入远程工作区，无需在本地注册。主机面板通过检查修订号的设置更新，把连接保存到 profile 的 `remote-hosts` 行；断开会保留配置并暂停重试，直到重新连接或重启应用。

## Testing

连接传输由单元测试覆盖：实例描述发布、SSH 命令构造、描述解析与转发参数。线客户端、联邦列表、路由的重命名与 follow、以及 prompt 准入，已在两个真实 `dsh web` 进程之间验证，两者由实现了本地转发的 SSH 替身连接，远端目录行携带 `host: H20-141-sy`。客户端测试在包含 Local 与两行已连接主机的目录上渲染主机面板，断言分组与导航。
