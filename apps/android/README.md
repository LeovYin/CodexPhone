# CodexPhone 原生安卓客户端

Kotlin + Jetpack Compose 客户端，通过已有 Tailscale VPN 连接 Windows CodexPhone Host。Codex 和模型仍运行在电脑，手机不需要 Codex 官方账号或模型 API 密钥。

## 安装与首次连接

1. 从仓库 Releases 下载 `CodexPhone-0.3.1-android.apk` 并安装，系统要求 Android 8.0+。
2. 先等电脑上的任务完成，再安装 0.3.1 Windows EXE。在管理中心选择“更新共享服务”，完成后确认 Host 版本为 0.3.1。
3. 电脑打开“账号与电脑”页，使用至少 12 位密码创建账号并绑定本机。默认账号服务运行于电脑的 4321 端口。
4. 手机和电脑加入同一个 Tailscale 网络，并打开手机 Tailscale。无需 Serve/Funnel。
5. 手机填写账号服务的 Tailscale 地址（`http://100.x.x.x:4321`）和账号密码。登录后自动连接绑定的电脑。电脑本机登录服务时才使用 127.0.0.1；手机不可填写该地址。
6. 打开已有任务，或选择电脑端允许启动的项目新建任务。回车换行，发送箭头提交。

账号会话持续 30 天，同一手机无需重复绑定。成功登录的服务器和用户名会记在手机上；在“设置”中退出登录后，可从地址框的下拉菜单切换服务器。密码不会保存。默认 SQLite 数据库位于电脑 `%USERPROFILE%/.codexphone/accounts/`。账号服务和桥接只应通过可信的内网/Tailscale 访问。

后续同签名、更高 versionCode 的 APK 可直接覆盖安装。若安装过本地 Debug APK，签名不同，需要先卸载；卸载会移除手机草稿与凭据。首次安装可为浏览器临时允许“安装未知应用”，安装后可关闭此权限。

## 当前功能与边界

- 原生任务列表、项目筛选、搜索、分页和收藏。
- 查看、续聊、新建、中断；选择 Host 提供的模型与强度。
- 运行中发送默认排队，输入框上方显示排队条；点击“引导”插入当前轮次，点击移除取消尚未发送的条目。
- 默认读取最近 20 轮并定位末尾，右上角“对话导航”查看轮次摘要、跳到某轮或最新位置；按需加载更早消息。
- 前台 WebSocket、断线重连与快照补齐；切回前台重新同步。
- 全局审批和问答，操作结果同步电脑。
- Agent 需要用户输入时全局弹出问题，回答完所有选项和文字问题后提交，任务会继续。切换任务或应用重连后仍可恢复未回答的问题。
- Markdown、代码、表格、消息复制、鉴权本地图片与 SVG、图片缩放；完整 Mermaid 代码块离线渲染、放大与源码查看。
- 每个对话独立草稿、最近对话缓存、待确认请求恢复。缓存损坏时跳过对话缓存，保留账号、草稿和未确认提交；设置可以单独清除显示缓存。

提交前持久保存请求编号。超时后先查询 Host：已完成则确认，未记录才允许用原编号重试；结果不确定时需先检查电脑对话。Host 记录保留 7 天，App 超过 6 天不再提供安全重试。去重依赖保留 Host 状态目录，不要删除记录后重试旧请求。

排队内容持久保存在电脑，手机退出或离线不取消队列。上一轮结束且没有待审批时自动续发；电脑重启时已处于提交中的条目标记为“结果待确认”，不会自动重复发送。核对电脑对话后再移除该记录，后续队列才能继续。“引导”只影响当前轮次，使用该轮次正在使用的模型。

后台不维持永久连接，不提供可靠锁屏通知。电脑任务不受手机退后台影响。当前无图片上传、语音输入、自建 VPN 或多电脑同时连接；项目管理可使用网页。

## 开发与测试

在 Android Studio 打开本目录。要求 JDK 17、Android SDK 35；Wrapper 固定 Gradle 8.8 并校验下载摘要。

~~~powershell
.\gradlew.bat :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
# 连接测试设备或启动模拟器后：
.\gradlew.bat :app:connectedDebugAndroidTest
~~~

单元测试和 Compose 流程测试使用 MockWebServer，覆盖请求数据、鉴权隔离、多行输入、模型选择、审批、中断与草稿，不调用真实模型。模拟器测试不需要真实 Host。调试 APK 位于 app/build/outputs/apk/debug/。

从仓库根目录构建正式签名包：

~~~powershell
# JAVA_HOME 指向 JDK 17，ANDROID_HOME 指向本机 SDK。Windows 包先构建。
pnpm release:build
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Build-Android.ps1 -CreateSigningKey
~~~

首次签名密钥和密码保存在当前用户 LocalAppData 下的 CodexPhone/signing/，不进入 Git 或发布目录。**请离线备份整个目录**；丢失密钥后无法覆盖升级现有安装。后续运行省略 -CreateSigningKey。脚本执行单元测试、Release lint、Release 构建和 apksigner 验签。

## Kotlin / Android 学习导览

- MainActivity.kt：Activity 入口、系统栏、应用前后台生命周期。
- ui/PhoneApp.kt：Compose 页面、Material 组件、输入、底部栏与弹窗。UI 根据状态绘制。
- ui/PhoneViewModel.kt：单向数据流，StateFlow 发布状态；协程负责网络、重连、快照与提交状态。
- data/CodexPhoneApi.kt：OkHttp HTTP/WebSocket；Kotlin Serialization 将 JSON 映射为类型。
- data/ApiModels.kt：响应、审批和本地记录的 data class。
- data/ConversationStore.kt：草稿、缓存、提交恢复。
- data/DeviceCredentialStore.kt：Android Keystore 的 AES-GCM 加密与私有存储。
- ui/MarkdownMessage.kt：Markwon 原生文本渲染和图片资源识别。
- ui/MermaidDiagram.kt：仅图表使用隔离 WebView 加载本地 Mermaid，无原生 JavaScript 桥接、无外部请求；聊天界面继续使用 Compose。
- gradle/libs.versions.toml：依赖版本；app/build.gradle.kts：SDK、签名与构建类型。

练习顺序：先改一个 Compose 组件，再追踪 state → 页面 → 操作 → ViewModel → API → state，然后为一个 API 补测试。当前保持单 app 模块便于阅读，规模增长后再拆模块。

## 数据与安全

设备令牌、草稿、显示缓存和待确认提交使用 Android Keystore 加密并分开原子写入，备份规则排除这些文件。设置里可以清除显示缓存或移除此手机连接；电脑离线时只能先清除本机，仍需在电脑管理中心撤销授权。图片磁盘缓存关闭。卸载会清除手机数据。

HTTP 仅允许内网/Tailscale 地址，公网服务需 HTTPS。HTTP 传输依赖 Tailscale 的加密隧道，局域网 HTTP 本身不加密；不要向公网转发 4318 或 4321。API 不跟随重定向；设备令牌仅发送给已绑定 Host，本地图片需鉴权，外部 HTTPS 图片不携带设备令牌。第三方图片服务器仍能看到普通图片访问。

本项目采用 MIT。第三方库保留自己的许可，见 THIRD_PARTY_NOTICES.md 和 THIRD_PARTY_LICENSES.txt。
