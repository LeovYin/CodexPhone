using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;

// A native executable is required: Electron does not spawn .cmd/.ps1 overrides.
internal static class SharedCliLauncher
{
    private static async Task Relay(Stream source, Stream destination)
    {
        byte[] buffer = new byte[8192];
        int count;
        while ((count = await source.ReadAsync(buffer, 0, buffer.Length)) > 0)
        {
            await destination.WriteAsync(buffer, 0, count);
            await destination.FlushAsync();
        }
    }
    private static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') result.Append('\\', slashes * 2 + 1);
            else result.Append('\\', slashes);
            slashes = 0;
            result.Append(c);
        }
        result.Append('\\', slashes * 2);
        return result.Append('"').ToString();
    }

    public static int Main(string[] args)
    {
        try
        {
            string[] settings = File.ReadAllLines(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "launcher-paths.txt"));
            if (settings.Length != 3) throw new InvalidOperationException();
            bool appServer = Array.IndexOf(args, "app-server") >= 0;
            // The GUI intentionally clears CODEX_HOME for its separate durable/Work host.
            // Keep that host independent; only the configured local host is shared.
            string home = Environment.GetEnvironmentVariable("CODEX_HOME");
            string sharedHome = Environment.GetEnvironmentVariable("CODEXPHONE_SHARED_HOME");
            appServer = appServer && !String.IsNullOrWhiteSpace(home) && !String.IsNullOrWhiteSpace(sharedHome)
                && String.Equals(Path.GetFullPath(home).TrimEnd('\\'), Path.GetFullPath(sharedHome).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
            foreach (string query in new string[] { "proxy", "daemon", "generate-ts", "generate-json-schema", "help", "--help", "-h", "--version", "-V", "--print-startup-config" })
                if (Array.IndexOf(args, query) >= 0) appServer = false;
            var command = new StringBuilder();
            if (appServer) command.Append(Quote(settings[1])).Append(' ').Append(Quote(settings[2])).Append(' ');
            foreach (string arg in args) command.Append(Quote(arg)).Append(' ');
            var start = new ProcessStartInfo(appServer ? settings[0] : settings[2], command.ToString());
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardInput = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            if (!appServer)
            {
                start.EnvironmentVariables["CODEX_CLI_PATH"] = settings[2];
                start.EnvironmentVariables["CODEX_APP_RUNTIME_CLI_PATH"] = settings[2];
                foreach (string name in new string[] { "CODEXPHONE_SHARED_HOME", "CODEXPHONE_SHARED_SESSION", "CODEXPHONE_SHARED_PORT", "CODEXPHONE_SHARED_RUNTIME_FILE" })
                    start.EnvironmentVariables.Remove(name);
            }
            // Explicitly relay handles: inherited libuv pipe handles are not reliably inherited twice.
            // Preserve the GUI's real tool environment. No credentials are stored here.
            using (var child = Process.Start(start))
            {
                Task input = Relay(Console.OpenStandardInput(), child.StandardInput.BaseStream);
                input.ContinueWith(delegate { try { child.StandardInput.Close(); } catch { } });
                Task output = Relay(child.StandardOutput.BaseStream, Console.OpenStandardOutput());
                Task errors = Relay(child.StandardError.BaseStream, Console.OpenStandardError());
                child.WaitForExit();
                Task.WaitAll(output, errors);
                return child.ExitCode;
            }
        }
        catch { Console.Error.WriteLine("CodexPhone CLI adapter could not start. Re-run the shared launcher setup."); return 1; }
    }
}
