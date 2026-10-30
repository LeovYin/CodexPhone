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
                DesktopManager.Render(installedRoot, version, Path.GetFullPath(args[1]));
                return 0;
            }
            DesktopManager.Run(installedRoot, version);
            return 0;
        }
        catch (Exception error)
        {
            if (args.Length > 0) { Console.Error.WriteLine(error.Message); return 1; }
            MessageBox.Show(error.Message, "CodexPhone", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

}
