using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class CodexPhoneBootstrap
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
    private static string installedRoot;
    private static string version;
    private static string integrityHash;
    private static string Hash(Stream stream) { using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant(); }
    private static string SafePath(string root, string relative)
    {
        string target = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
        if (!target.StartsWith(Path.GetFullPath(root).TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("安装包包含无效路径。");
        return target;
    }
    private static bool Verify(string root)
    {
        try
        {
            string manifest = Path.Combine(root, "integrity.json");
            using (var file = File.OpenRead(manifest)) if (Hash(file) != integrityHash) return false;
            var data = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(manifest, Encoding.UTF8));
            var files = (Dictionary<string, object>)data["files"];
            if (files.Count == 0) return false;
            foreach (var entry in files)
            {
                using (var file = File.OpenRead(SafePath(root, entry.Key)))
                    if (!String.Equals(Hash(file), (string)entry.Value, StringComparison.Ordinal)) return false;
            }
            return true;
        }
        catch { return false; }
    }
    private static string Extract(string explicitDestination)
    {
        var assembly = Assembly.GetExecutingAssembly();
        Dictionary<string, object> meta;
        using (var reader = new StreamReader(assembly.GetManifestResourceStream("codexphone.release")))
            meta = Json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
        version = (string)meta["version"];
        integrityHash = (string)meta["integritySha256"];
        string digest = (string)meta["payloadSha256"];
        string destination = explicitDestination ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CodexPhone", "versions", version + "-" + digest.Substring(0, 12));
        if (explicitDestination == null && Verify(destination)) return destination;
        if (Directory.Exists(destination)) throw new IOException("安装目录已经存在或校验失败。请移走该版本目录后重试：" + destination);
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(destination)));
        string staging = destination + ".extract-" + Guid.NewGuid().ToString("N");
        Directory.CreateDirectory(staging);
        try
        {
            using (var payload = assembly.GetManifestResourceStream("codexphone.payload"))
            {
                if (Hash(payload) != digest) throw new InvalidDataException("安装包校验失败，请重新下载。");
                payload.Position = 0;
                using (var archive = new ZipArchive(payload, ZipArchiveMode.Read))
                    foreach (var entry in archive.Entries)
                    {
                        string target = SafePath(staging, entry.FullName);
                        if (String.IsNullOrEmpty(entry.Name)) Directory.CreateDirectory(target);
                        else { Directory.CreateDirectory(Path.GetDirectoryName(target)); entry.ExtractToFile(target); }
                    }
            }
            if (!Verify(staging)) throw new InvalidDataException("文件校验失败，请重新下载。");
            Directory.Move(staging, destination);
            return destination;
        }
        finally { if (Directory.Exists(staging)) Directory.Delete(staging, true); }
    }
    [STAThread]
    public static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try
        {
            bool extractOnly = args.Length == 2 && args[0] == "--extract-only";
            bool renderPreview = args.Length == 2 && args[0] == "--render-preview";
            using (var mutex = new Mutex(false, "Local\\CodexPhone-PackageExtraction"))
            {
                try { if (!mutex.WaitOne(60000)) throw new IOException("另一个 CodexPhone 正在释放文件，请稍后重试。"); }
                catch (AbandonedMutexException) { }
                try { installedRoot = Extract(extractOnly ? Path.GetFullPath(args[1]) : null); }
                finally { mutex.ReleaseMutex(); }
            }
            if (extractOnly) return 0;
            if (args.Length == 1 && args[0] == "--install-shortcut")
            {
                var setup = new ProcessStartInfo("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(installedRoot, "scripts", "Create-Shortcut.ps1") + "\" -Executable \"" + Assembly.GetExecutingAssembly().Location + "\"");
                setup.UseShellExecute = false; setup.CreateNoWindow = true;
                using (var process = Process.Start(setup)) { process.WaitForExit(); return process.ExitCode; }
            }
            if (renderPreview)
            {
                using (var form = new LauncherForm(installedRoot, version))
                {
                    form.ShowInTaskbar = false;
                    form.StartPosition = FormStartPosition.Manual;
                    form.Location = new Point(-32000, -32000);
                    form.Show();
                    Application.DoEvents();
                    form.PerformLayout();
                    using (var bitmap = new Bitmap(form.Width, form.Height))
                    {
                        form.DrawToBitmap(bitmap, new Rectangle(0, 0, form.Width, form.Height));
                        bitmap.Save(Path.GetFullPath(args[1]), System.Drawing.Imaging.ImageFormat.Png);
                    }
                }
                return 0;
            }
            Application.Run(new LauncherForm(installedRoot, version));
            return 0;
        }
        catch (Exception error)
        {
            if (args.Length > 0) { Console.Error.WriteLine(error.Message); return 1; }
            MessageBox.Show(error.Message, "CodexPhone", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private sealed class LauncherForm : Form
    {
        private readonly string root;
        private readonly TextBox output = new TextBox();
        private readonly Label state = new Label();
        private readonly Button start = new Button(), pair = new Button(), check = new Button();
        private bool busy;
        public LauncherForm(string directory, string releaseVersion)
        {
            root = directory;
            Text = "CodexPhone";
            Icon = new Icon(Path.Combine(root, "runtime", "codexphone.ico"));
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(640, 650);
            MinimumSize = new Size(610, 640);
            BackColor = ColorTranslator.FromHtml("#F5F7FB");
            Font = new Font("Microsoft YaHei UI", 10F);
            AutoScaleMode = AutoScaleMode.Dpi;
            var title = new Label { Text = "把电脑里的任务，带到手机上。", Font = new Font(Font.FontFamily, 21, FontStyle.Bold), ForeColor = ColorTranslator.FromHtml("#182338"), Location = new Point(28, 27), AutoSize = true };
            Controls.Add(title);
            Controls.Add(new Label { Text = "CodexPhone  " + releaseVersion + "    /    Windows", Location = new Point(30, 77), AutoSize = true, ForeColor = ColorTranslator.FromHtml("#657188") });
            Controls.Add(new Label { Text = "先在电脑配置好 Codex，让手机与电脑加入同一个 Tailscale 网络。", Location = new Point(30, 113), Size = new Size(580, 45), ForeColor = ColorTranslator.FromHtml("#182338") });
            ConfigureButton(start, "启动共享连接", 30, 168, 190, true);
            ConfigureButton(pair, "配对另一台手机", 232, 168, 180, false);
            ConfigureButton(check, "检查环境", 424, 168, 180, false);
            start.Click += async delegate { await RunScript("Start-SharedCodex.ps1", "-WaitForDesktopExit", true); };
            pair.Click += async delegate {
                if (MessageBox.Show("将刷新一次性配对码，已有手机仍保持配对。请先等待手机任务完成。", "配对手机", MessageBoxButtons.OKCancel, MessageBoxIcon.Information) == DialogResult.OK)
                    await RunScript("Show-Connection.ps1", "-RenewPairing", false);
            };
            check.Click += async delegate { await RunScript("Check-Install.ps1", "", false); };
            state.Text = "准备就绪 · 点击启动，共享你现有的 Codex 对话";
            state.Location = new Point(30, 227); state.Size = new Size(574, 26); state.ForeColor = ColorTranslator.FromHtml("#315FCA"); Controls.Add(state);
            output.Location = new Point(30, 265); output.Size = new Size(574, 265);
            output.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
            output.Multiline = true; output.ReadOnly = true; output.ScrollBars = ScrollBars.Vertical;
            output.BackColor = Color.White; output.BorderStyle = BorderStyle.FixedSingle;
            output.Font = new Font("Microsoft YaHei UI", 9F);
            output.Text = "首次连接：启动后，如提示等待退出，请从 Codex 菜单正常退出。" + Environment.NewLine +
                "本程序随后自动重新打开 Codex，显示手机访问地址和一次性配对码。" + Environment.NewLine + Environment.NewLine +
                "运行依赖已内置。API 密钥与模型配置沿用你电脑上的 Codex。" + Environment.NewLine +
                "关闭这个面板不会停止已经启动的共享连接。";
            Controls.Add(output);
            var open = new LinkLabel { Text = "在电脑浏览器打开", Location = new Point(30, 550), AutoSize = true, Anchor = AnchorStyles.Bottom | AnchorStyles.Left, LinkColor = ColorTranslator.FromHtml("#315FCA") };
            open.LinkClicked += delegate { Process.Start(new ProcessStartInfo("http://127.0.0.1:4318") { UseShellExecute = true }); }; Controls.Add(open);
            var logs = new LinkLabel { Text = "打开日志目录", Location = new Point(210, 550), AutoSize = true, Anchor = AnchorStyles.Bottom | AnchorStyles.Left, LinkColor = ColorTranslator.FromHtml("#315FCA") };
            logs.LinkClicked += delegate { string folder = Path.Combine(root, ".codexphone"); Directory.CreateDirectory(folder); Process.Start(new ProcessStartInfo(folder) { UseShellExecute = true }); }; Controls.Add(logs);
            var guide = new LinkLabel { Text = "使用说明", Location = new Point(375, 550), AutoSize = true, Anchor = AnchorStyles.Bottom | AnchorStyles.Left, LinkColor = ColorTranslator.FromHtml("#315FCA") };
            guide.LinkClicked += delegate { Process.Start(new ProcessStartInfo(Path.Combine(root, "USER_GUIDE.txt")) { UseShellExecute = true }); }; Controls.Add(guide);
            var shortcut = new LinkLabel { Text = "桌面快捷方式", Location = new Point(466, 550), AutoSize = true, Anchor = AnchorStyles.Bottom | AnchorStyles.Left, LinkColor = ColorTranslator.FromHtml("#315FCA") };
            shortcut.LinkClicked += async delegate { await RunScript("Create-Shortcut.ps1", "-Executable \"" + Assembly.GetExecutingAssembly().Location + "\"", false); }; Controls.Add(shortcut);
            Controls.Add(new Label { Text = "社区开源工具 · MIT 许可 · 非 OpenAI 官方产品", Location = new Point(30, 602), AutoSize = true, Anchor = AnchorStyles.Bottom | AnchorStyles.Left, ForeColor = ColorTranslator.FromHtml("#657188") });
            FormClosing += delegate(object sender, FormClosingEventArgs e) {
                if (busy) { e.Cancel = true; MessageBox.Show("当前操作仍在进行，请等它完成后再关闭面板。", "CodexPhone"); }
            };
        }
        private void ConfigureButton(Button button, string text, int x, int y, int width, bool primary)
        {
            button.Text = text; button.Location = new Point(x, y); button.Size = new Size(width, 44);
            button.FlatStyle = FlatStyle.Flat; button.FlatAppearance.BorderColor = ColorTranslator.FromHtml(primary ? "#315FCA" : "#DFE5EE");
            button.BackColor = ColorTranslator.FromHtml(primary ? "#315FCA" : "#FFFFFF"); button.ForeColor = primary ? Color.White : ColorTranslator.FromHtml("#182338");
            button.Cursor = Cursors.Hand; Controls.Add(button);
        }
        private void Append(string line)
        {
            if (line == null || IsDisposed) return;
            BeginInvoke((Action)delegate { output.AppendText(line + Environment.NewLine); });
        }
        private async Task<int> Execute(string script, string arguments)
        {
            var info = new ProcessStartInfo("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(root, "scripts", script) + "\" " + arguments);
            info.UseShellExecute = false; info.CreateNoWindow = true; info.WorkingDirectory = root;
            info.RedirectStandardOutput = true; info.RedirectStandardError = true;
            info.StandardOutputEncoding = Encoding.UTF8; info.StandardErrorEncoding = Encoding.UTF8;
            info.EnvironmentVariables["CODEXPHONE_UTF8"] = "1";
            using (var process = new Process { StartInfo = info })
            {
                process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { Append(e.Data); };
                process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { Append(e.Data); };
                process.Start(); process.BeginOutputReadLine(); process.BeginErrorReadLine();
                await Task.Run((Action)process.WaitForExit);
                return process.ExitCode;
            }
        }
        private async Task RunScript(string script, string arguments, bool showConnection)
        {
            if (busy) return;
            busy = true; start.Enabled = pair.Enabled = check.Enabled = false;
            output.Clear(); state.Text = "正在处理… 如果正在等待退出，请从 Codex 菜单正常退出。";
            try
            {
                int code = await Execute(script, arguments);
                if (code == 0 && showConnection) code = await Execute("Show-Connection.ps1", "");
                state.Text = code == 0 ? "操作完成 · 手机访问地址和配对信息见下方" : "操作未完成 · 请查看下方信息，或点击检查环境";
            }
            catch (Exception error) { Append(error.Message); state.Text = "操作未完成 · 请检查环境"; }
            finally { busy = false; start.Enabled = pair.Enabled = check.Enabled = true; }
        }
    }
}
