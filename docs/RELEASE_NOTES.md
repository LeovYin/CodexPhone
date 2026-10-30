# CodexPhone v0.2.0 · Android + Windows Preview

首个可安装的 Kotlin / Jetpack Compose 原生 Android 发布版，使用持久发布密钥签名。APK 为 Release 构建，GitHub 暂标 Preview，供不同手机兼容测试。

- Android 8.0+：配对、浏览/搜索/收藏、创建/继续任务、前台实时同步。
- 原生多行输入，选择模型/推理强度，审批问答、中断与追加指令。
- Markdown 表格、代码、图片和 SVG，复制与图片缩放。
- Keystore 加密凭据、草稿与最近对话缓存，断线补齐，未确认提交恢复。
- Host 0.2.0：持久请求去重、提交状态查询、全局审批、撤销设备时关闭实时连接。旧网页客户端保持兼容。
- 配套 Windows x64 EXE 和便携包，不附带个人配置、聊天记录、签名私钥或 API 凭据。

## 安装

先在任务空闲时打开 Windows 0.2.0 EXE。若已有旧共享服务，点击新版面板“配对另一台手机”刷新手机桥接，保留已有设备授权；在 App 设置确认 Host 版本为 0.2.0。Android 安装同版本 APK，在已有 Tailscale VPN 中填写电脑地址和一次性配对码。无需 Serve/Funnel 或官方账号。原版 Codex 与手机继续共用后端。

同签名后续 APK 可覆盖升级。本地 Debug APK 需先卸载，卸载会清除手机数据。安装包与全部附件的 SHA-256 见 SHA256SUMS.txt。

## 限制

后台返回时补齐状态，本版不提供锁屏推送、图片上传或多电脑同时连接。真实手机键盘、厂商后台策略及各模型服务还需对应设备验证。桌面共享依赖 Codex 当前启动入口与实验性 WebSocket 传输。Windows EXE 尚未代码签名；Android APK 已签名。

Codex / Tailscale 不随包分发。本工具采用 MIT，非 OpenAI 官方产品。不要将 4318 直接暴露到公网。完整安装与开发说明见仓库 apps/android/README.md。
