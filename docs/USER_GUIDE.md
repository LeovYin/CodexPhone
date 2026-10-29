# CodexPhone 使用说明

CodexPhone 是社区开源工具，让手机通过自己的 Tailscale 网络继续电脑上的 Codex 对话。它不是 OpenAI 官方产品。

## 使用前准备

- Windows 11 x64，已安装 Codex Windows 桌面应用。
- 先确认电脑里的 Codex 能正常发消息；使用自己的 API 服务或已有的 Codex 配置。
- 电脑和手机安装 Tailscale，并登录同一网络；不需要启用 Serve 或 Funnel。
- 本版本不支持 macOS、Linux 或 Windows ARM64。

EXE 已包含 Node.js 和本项目原生适配器，不需要另外安装 Node.js、pnpm 或编译器。Codex 和 Tailscale 需要分别自行安装。

## 第一次连接

1. 下载并打开 CodexPhone EXE。它会把程序释放到当前用户的 LocalAppData/CodexPhone/versions，不需要管理员权限。
2. 点击“启动共享连接”。如果电脑 Codex 已打开，请从 Codex 菜单正常退出；本程序会自动重新打开它。
3. 等待操作完成。为覆盖 Codex 启动时的配置刷新，程序会等待后端稳定至少 15 秒。
4. 用手机打开面板显示的 Tailscale HTTP 地址。不要把 0.0.0.0 当成手机访问地址。
5. 输入面板显示的一次性配对码。配对码有效 10 分钟，只能使用一次；已有设备不需要重复配对。
6. 配对成功后，在手机“管理项目”中选择或填写电脑上的项目目录，然后打开已有对话或新建任务。

首次运行时 Windows 可能提示程序没有数字签名。本项目目前未签名，请核对来源和发布页 SHA-256；如果组织策略阻止运行，请联系管理员。程序不会修改安全策略。

## 日常使用

- 以后使用 CodexPhone 的“启动共享连接”打开 Codex。直接从开始菜单打开，可能使用独立后端。
- 按回车换行，点击箭头发送。模型和思考强度由本机 Codex 的目录提供，实际可用性取决于自己的服务。
- 手机和电脑共享同一后端；在同一个对话中接着发消息即可。
- 配对新手机：点击“配对另一台手机”。会重启手机桥接以换发配对码，请先等待手机任务完成；已有配对保留。
- 关闭启动面板不会停止正在运行的 Codex 或手机桥接。
- API 配置和聊天历史保留在 Codex 自己的用户目录。配对、重点对话和项目登记保存在用户目录下的 .codexphone。
- 手机浏览器没有安装要求；HTTP 地址下不保证“安装到桌面”或 Service Worker 等需要安全上下文的功能。

## 手机打不开或发送失败

1. 确认两端 Tailscale 在线，手机使用面板显示的本机地址，而不是别人的 IP。
2. 点击“检查环境”，检查 Codex、共享桥接和依赖状态。
3. 查看防火墙或 Tailscale ACL 是否允许自己的手机访问电脑 TCP 4318。程序不会自动创建防火墙规则，也不要把此端口直接映射到公网。
4. 若桥接显示 disconnected/degraded，等待电脑 Codex 完成启动并恢复连接。
5. 若 4318 被其他程序占用，不要随意结束未知程序；可从 PowerShell 使用 scripts/Start-SharedCodex.ps1 -PhonePort 其他端口启动。
6. 日志目录可从面板打开。求助时只提交经过检查的必要片段；日志可能含配对码或项目名称，不要上传整个用户目录。

## 更新与移除

- 更新前先完成任务并正常退出 Codex，再运行新版本 EXE。配对数据在用户目录中，升级不清空。
- 切换版本时不要让新旧两个启动面板同时操作服务。
- 原始 Codex App Server 仅监听 127.0.0.1；手机连接的是带鉴权的桥接端口。
- 恢复独立模式：先完成任务并退出 Codex，运行释放目录里的 Restore-Standalone.cmd。之后手机和电脑拥有独立后端，不能同时控制桌面持有的对话。
- 移除：退出 Codex 后，结束已核对属于本程序的手机桥接，再删除 LocalAppData/CodexPhone 下的程序文件。用户目录 .codexphone 是配对数据，按需保留。

## 兼容范围

已验证的 Codex Windows 版本：26.1023.6123.0；CLI：0.165.0-alpha.1.2。桌面启动接入和实验性 WebSocket 传输可能随 Codex 升级变化，不能保证未测试版本完全兼容。

## 开源与第三方许可

CodexPhone 使用 MIT 许可证。Node.js 许可见 runtime/NODE-LICENSE.txt，其他随包依赖见 THIRD-PARTY-NOTICES.txt 和各包的许可证文件。OpenAI Codex 和 Tailscale 不包含在此安装包中。
