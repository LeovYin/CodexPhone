# 构建与发布

在 Windows x64 构建机上安装 Node.js 24 LTS、pnpm 11，以及 Windows .NET Framework 编译器。发布包的使用者不需要这些开发工具。

依次执行：

    pnpm install --frozen-lockfile
    pnpm typecheck
    pnpm test
    pnpm test:e2e
    pnpm release:build
    pnpm release:test

release:build 生成 releases/版本号/ 下的 EXE、便携 ZIP、版本说明和 SHA256SUMS.txt。Node.js 下载版本固定在构建脚本参数中，并核对官方 SHASUMS256。更新内置 Node.js 时必须明确修改版本并重新运行发布测试。

程序按白名单复制运行文件。生产依赖不包含开发工具；去除 pnpm 本机元数据和 junction；保留包许可。绝不从开发机复制 .codex、.codexphone、auth.json、devices.json、日志或数据库。

EXE 验证内嵌 ZIP 的 SHA-256；解包后校验 integrity.json 中的文件。压缩包的校验用于发现损坏，不代替代码签名或来源验证。

发布测试会从 EXE 解包到包含中文和空格的临时目录，使用内置 Node.js 启动真实桥接，并连接本机模拟 App Server。验证配对、静态资源、鉴权与目录迁移，不调用真实模型，不重启正式 Codex。

源码发布只使用 Export-Source.ps1 的白名单清单。发布前检查导出文件和差异。不要直接把开发工作目录整体上传。

GitHub Actions 可构建和上传工作流产物。正式 Release 应包含 EXE、便携 ZIP、SHA256SUMS.txt 和 RELEASE_NOTES.md。新版本先作为预览发布，完成多台机器兼容验证后再调整稳定性标记。

## Android Release APK

要求 JDK 17 和 Android SDK 35。先构建 Windows 包，再运行 scripts/Build-Android.ps1；首次附加 -CreateSigningKey，随后保留并离线备份 LocalAppData 下 CodexPhone/signing/ 的密钥与密码。不要将签名目录放入仓库或上传到 GitHub。正式 APK 的 applicationId 固定为 app.codexphone；升级时提高 versionCode 并保持签名一致。

脚本运行单元测试、Release lint、正式构建与 apksigner 验签，将 APK 加入同版本 releases 目录。APK 为不可调试的 Release 构建。GitHub CI 只构建 unsigned APK，不持有发布密钥，也不代替发布签名。Compose 设备流程测试须在模拟器或测试设备上另行执行。

发布附件同时包含安卓安装说明、第三方许可和 APK。所有附件完成后重新生成 SHA256SUMS.txt，排除校验文件自身。Publish-GitHub.mjs --publish 按白名单提交源码、校验附件、创建标签并上传；仅在检查完成并获得发布授权后执行。
