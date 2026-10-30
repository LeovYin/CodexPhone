# CodexPhone 原生安卓客户端

Kotlin + Jetpack Compose 客户端，通过已有 Tailscale VPN 连接 Windows CodexPhone Host。Codex 和模型仍运行在电脑，手机不需要 Codex 官方账号或模型 API 密钥。

## 安装与首次连接

1. 从仓库 Releases 下载 CodexPhone-0.2.0-android.apk 并安装，系统要求 Android 8.0+。这是签名的 Release APK，无需 Android Studio。
2. 电脑打开同版本 Windows EXE。若已有旧共享服务，任务结束后点击新版面板的“配对另一台手机”，刷新手机桥接与一次性配对码；已有手机授权会保留。App 设置页可查看实际 Host 版本。
3. 手机和电脑加入同一个 Tailscale 网络，并打开手机 Tailscale。无需 Serve/Funnel。
4. 电脑启动共享连接，在 App 填写面板地址（http://100.x.x.x:4318）和一次性配对码。地址不要附加网页路径。
5. 打开已有任务，或选择电脑端允许启动的项目新建任务。回车换行，发送箭头提交。项目登记仍在电脑/网页端完成。

Host 0.2.0 提供请求去重与状态查询；旧 Host 可以浏览，但 App 会禁止发送。不要为升级强行停止正在工作的 Codex，待任务结束再切换。

后续同签名、更高 versionCode 的 APK 可直接覆盖安装。若安装过本地 Debug APK，签名不同，需要先卸载；卸载会移除手机草稿与凭据。首次安装可为浏览器临时允许“安装未知应用”，安装后可关闭此权限。

## 当前功能与边界

- 原生任务列表、项目筛选、搜索、分页和收藏。
- 查看、续聊、新建、追加运行中指令、中断；选择 Host 提供的模型与强度。
- 前台 WebSocket、断线重连与快照补齐；切回前台重新同步。
- 全局审批和问答，操作结果同步电脑。
- Markdown、代码、表格、消息复制、鉴权本地图片与 SVG、图片缩放。
- 每个对话独立草稿、最近对话缓存、待确认请求恢复。

提交前持久保存请求编号。超时后先查询 Host：已完成则确认，未记录才允许用原编号重试；结果不确定时需先检查电脑对话。Host 记录保留 7 天，App 超过 6 天不再提供安全重试。去重依赖保留 Host 状态目录，不要删除记录后重试旧请求。

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
- gradle/libs.versions.toml：依赖版本；app/build.gradle.kts：SDK、签名与构建类型。

练习顺序：先改一个 Compose 组件，再追踪 state → 页面 → 操作 → ViewModel → API → state，然后为一个 API 补测试。当前保持单 app 模块便于阅读，规模增长后再拆模块。

## 数据与安全

配对令牌、草稿与缓存使用 Android Keystore 加密，备份规则排除这些文件。设置里可撤销配对并清除本机数据；电脑离线时只能先清除本机，仍需在电脑撤销授权。图片磁盘缓存关闭。卸载会清除手机数据。

HTTP 仅允许内网/Tailscale 地址，公网服务需 HTTPS。HTTP 传输依赖 Tailscale 的加密隧道，局域网 HTTP 本身不加密；不要向公网转发 4318。API 不跟随重定向；设备令牌仅发送给配对 Host，本地图片需鉴权，外部 HTTPS 图片不携带配对令牌。第三方图片服务器仍能看到普通图片访问。

本项目采用 MIT。第三方库保留自己的许可，见 THIRD_PARTY_NOTICES.md 和 THIRD_PARTY_LICENSES.txt。
