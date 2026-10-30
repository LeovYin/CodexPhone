# CodexPhone 0.3.2 Preview

修复 0.3.1 Windows 管理中心因禁用按钮样式中的无效 WPF Setter 而无法启动的问题。重新构建并验证 EXE 的管理中心界面。

保留 0.3.1 的共享连接后台启动、账号与设备管理界面优化，以及 Android 服务器记忆、服务器切换和退出登录功能。密码不保存；退出后保留服务器地址和用户名。

Windows 管理中心和 Android APK 均升级为 0.3.2。APK 使用原发布密钥及更高 versionCode，可覆盖安装 0.3.1。

本版仍为 Preview。默认账号服务端口 4321，桥接端口 4318，均应限制在可信内网/Tailscale。
