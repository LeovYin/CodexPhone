using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

internal sealed class DesktopManager
{
    private readonly string root, version, stateRoot;
    private readonly JavaScriptSerializer json = new JavaScriptSerializer();
    private Window window;
    private TextBlock status, summary, accountSummary, accountServiceState, phoneLoginAddress;
    private TextBox logs, accountsUrl, hostUrl, username, computerName;
    private PasswordBox password;
    private StackPanel deviceList;
    private DispatcherTimer timer;
    private bool refreshing, busy, restoredBinding, editedHostAddress;
    private string tailscaleIp;
    private Process startupProcess;
    private readonly List<Button> actions = new List<Button>();
    private const string Xaml = @"<Window xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml' Title='CodexPhone 连接管理中心' Width='1100' Height='760' MinWidth='1000' MinHeight='700' WindowStartupLocation='CenterScreen' Background='#F4F6FA' FontFamily='Microsoft YaHei UI' FontSize='14' Foreground='#182338'>
<Window.Resources>
 <Style TargetType='Button'><Setter Property='Background' Value='White'/><Setter Property='BorderBrush' Value='#C9D3E2'/><Setter Property='Foreground' Value='#24334D'/><Setter Property='Padding' Value='16,10'/><Setter Property='Margin' Value='0,0,10,8'/><Setter Property='Cursor' Value='Hand'/><Setter Property='FontWeight' Value='SemiBold'/><Setter Property='Template'><Setter.Value><ControlTemplate TargetType='Button'><Border x:Name='b' Background='{TemplateBinding Background}' BorderBrush='{TemplateBinding BorderBrush}' BorderThickness='1' CornerRadius='7' Padding='{TemplateBinding Padding}'><ContentPresenter HorizontalAlignment='Center' VerticalAlignment='Center'/></Border><ControlTemplate.Triggers><Trigger Property='IsMouseOver' Value='True'><Setter TargetName='b' Property='Opacity' Value='0.88'/><Setter TargetName='b' Property='BorderBrush' Value='#8EA9DF'/></Trigger><Trigger Property='IsPressed' Value='True'><Setter TargetName='b' Property='Opacity' Value='0.72'/></Trigger><Trigger Property='IsEnabled' Value='False'><Setter TargetName='b' Property='Background' Value='#F1F3F6'/><Setter TargetName='b' Property='BorderBrush' Value='#E0E4EA'/><Setter Property='Foreground' Value='#7B8797'/></Trigger></ControlTemplate.Triggers></ControlTemplate></Setter.Value></Setter></Style>
 <Style TargetType='TextBox'><Setter Property='Padding' Value='10,9'/><Setter Property='BorderBrush' Value='#D8DFE9'/><Setter Property='VerticalContentAlignment' Value='Center'/><Setter Property='Margin' Value='0,6,0,16'/></Style>
 <Style TargetType='PasswordBox'><Setter Property='Padding' Value='10,9'/><Setter Property='BorderBrush' Value='#D8DFE9'/><Setter Property='Margin' Value='0,6,0,16'/></Style>
 <Style TargetType='TabItem'><Setter Property='Padding' Value='20,11'/><Setter Property='FontSize' Value='14'/><Setter Property='Foreground' Value='#52627A'/><Setter Property='Background' Value='#E9EDF4'/><Setter Property='BorderBrush' Value='#D9E0E9'/><Setter Property='Template'><Setter.Value><ControlTemplate TargetType='TabItem'><Border x:Name='tab' Background='{TemplateBinding Background}' BorderBrush='{TemplateBinding BorderBrush}' BorderThickness='0,0,0,2' Padding='{TemplateBinding Padding}' Margin='0,0,4,0'><ContentPresenter x:Name='headerText' ContentSource='Header' HorizontalAlignment='Center' VerticalAlignment='Center'/></Border><ControlTemplate.Triggers><Trigger Property='IsSelected' Value='True'><Setter TargetName='tab' Property='Background' Value='White'/><Setter TargetName='tab' Property='BorderBrush' Value='#315FCA'/><Setter TargetName='headerText' Property='TextElement.Foreground' Value='#244FAE'/></Trigger><Trigger Property='IsMouseOver' Value='True'><Setter TargetName='tab' Property='Background' Value='#F7F9FC'/></Trigger></ControlTemplate.Triggers></ControlTemplate></Setter.Value></Setter></Style>
</Window.Resources>
<Grid><Grid.ColumnDefinitions><ColumnDefinition Width='220'/><ColumnDefinition Width='*'/></Grid.ColumnDefinitions>
<Border Background='#182B4A'><DockPanel Margin='24,28'><StackPanel DockPanel.Dock='Top'><TextBlock Text='CodexPhone' Foreground='White' FontSize='25' FontWeight='Bold'/><TextBlock Text='连接管理中心' Foreground='#B9C8E0' Margin='0,8,0,36'/><TextBlock Text='电脑上的 Codex，&#10;随时在手机上继续。' Foreground='White' TextWrapping='Wrap' FontSize='17' LineHeight='29'/></StackPanel><StackPanel VerticalAlignment='Bottom'><TextBlock x:Name='VersionLabel' Foreground='#B9C8E0'/><TextBlock Text='关闭窗口后，&#10;共享连接和任务继续运行。' Foreground='#B9C8E0' Margin='0,18,0,0' LineHeight='23'/></StackPanel></DockPanel></Border>
<Grid Grid.Column='1' Margin='32,26'><Grid.RowDefinitions><RowDefinition Height='Auto'/><RowDefinition Height='Auto'/><RowDefinition Height='*'/></Grid.RowDefinitions>
<StackPanel><TextBlock Text='你的电脑，你的连接。' FontSize='28' FontWeight='Bold'/><TextBlock Text='在这里启用连接、登录账号，并决定每台手机能做什么。' Foreground='#63728A' Margin='0,10,0,20'/></StackPanel>
<Border Grid.Row='1' Background='#E8EFFC' CornerRadius='8' Padding='18,14' Margin='0,0,0,22'><StackPanel><TextBlock x:Name='Status' Text='正在检查电脑连接…' FontWeight='SemiBold' Foreground='#2857B5'/><TextBlock x:Name='Summary' Text='现有任务不会因打开管理中心而中断。' TextWrapping='Wrap' Foreground='#526780' Margin='0,7,0,0'/></StackPanel></Border>
<TabControl x:Name='Pages' Grid.Row='2' BorderThickness='0' Background='Transparent'>
 <TabItem Header='连接概览'><ScrollViewer VerticalScrollBarVisibility='Auto'><StackPanel Margin='0,22,4,0'><TextBlock Text='共享你的 Codex' FontSize='21' FontWeight='SemiBold'/><TextBlock Text='开始连接会启动账号服务和手机桥接。首次启用需要正常退出一次 Codex，完成后手机与电脑共用同一份任务。' TextWrapping='Wrap' Foreground='#63728A' Margin='0,10,0,20'/><WrapPanel><Button x:Name='Start' Content='开始连接手机' Background='#315FCA' Foreground='White' BorderBrush='#315FCA'/><Button x:Name='AccountsStart' Content='检查账号服务'/></WrapPanel><Border Background='White' CornerRadius='8' BorderBrush='#DEE4ED' BorderThickness='1' Padding='20' Margin='0,18,0,18'><StackPanel><TextBlock Text='手机如何连接' FontWeight='SemiBold' FontSize='17'/><TextBlock x:Name='AccountServiceState' Text='正在检查账号服务…' Margin='0,12,0,4' Foreground='#526780'/><TextBlock Text='手机登录地址（账号服务 · 4321）' Foreground='#63728A' Margin='0,10,0,2'/><DockPanel><Button x:Name='CopyLoginAddress' DockPanel.Dock='Right' Content='复制地址' Margin='10,0,0,0'/><TextBlock x:Name='PhoneLoginAddress' Text='请先连接 Tailscale' VerticalAlignment='Center' FontWeight='SemiBold'/></DockPanel><TextBlock x:Name='AccountSummary' Text='在“账号与电脑”页创建账号并绑定本机。电脑任务连接使用 4318 端口。' Margin='0,14,0,0' TextWrapping='Wrap' LineHeight='25'/></StackPanel></Border><TextBlock Text='电脑和手机保持 Tailscale 在线。手机填写上方 4321 地址登录；电脑内的任务连接使用 4318。账号服务使用 SQLite，无需安装数据库。' Foreground='#63728A' TextWrapping='Wrap' LineHeight='24'/><WrapPanel Margin='0,20,0,0'><Button x:Name='OpenWeb' Content='打开 Web 客户端'/><Button x:Name='Shortcut' Content='创建桌面快捷方式'/></WrapPanel></StackPanel></ScrollViewer></TabItem>
 <TabItem Header='账号与电脑'><ScrollViewer VerticalScrollBarVisibility='Auto'><StackPanel Margin='0,22,4,0'><TextBlock Text='一个账号，绑定一台电脑' FontSize='21' FontWeight='SemiBold'/><TextBlock Text='手机登录同一账号后自动找到本机。密码只用于登录，不保存在电脑配置中。' Foreground='#63728A' TextWrapping='Wrap' Margin='0,10,0,20'/><Grid><Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width='22'/><ColumnDefinition/></Grid.ColumnDefinitions><StackPanel><TextBlock Text='账号服务地址（管理中心使用）'/><TextBox x:Name='AccountsUrl' Text='http://127.0.0.1:4321'/><TextBlock Text='账号'/><TextBox x:Name='Username'/><TextBlock Text='密码（至少 6 个字符）'/><PasswordBox x:Name='Password'/></StackPanel><StackPanel Grid.Column='2'><TextBlock Text='本机名称'/><TextBox x:Name='ComputerName'/><TextBlock Text='手机可访问的电脑地址'/><TextBox x:Name='HostUrl' Text='http://100.x.x.x:4318'/><TextBlock Text='手机登录时填写账号服务的 Tailscale 地址，端口 4321。不要在手机填写 127.0.0.1。' Foreground='#63728A' TextWrapping='Wrap' LineHeight='24'/></StackPanel></Grid><WrapPanel><Button x:Name='Register' Content='创建账号并绑定本机' Background='#315FCA' Foreground='White' BorderBrush='#315FCA'/><Button x:Name='Login' Content='登录已有账号并绑定'/><Button x:Name='Unbind' Content='解除本机绑定'/></WrapPanel><TextBlock Text='账号可自托管在本机，也可填写你自己的独立账号服务地址。每台电脑只管理本机授权的手机。' Foreground='#63728A' TextWrapping='Wrap' LineHeight='24' Margin='0,10,0,0'/></StackPanel></ScrollViewer></TabItem>
 <TabItem Header='手机与权限'><DockPanel Margin='0,22,0,0'><StackPanel DockPanel.Dock='Top'><TextBlock Text='连接到本机的手机' FontSize='21' FontWeight='SemiBold'/><TextBlock Text='只读：查看任务。可控制：发送、引导、审批。禁用：立即断开并禁止此手机重新连接。' Foreground='#63728A' TextWrapping='Wrap' Margin='0,10,0,18'/></StackPanel><ScrollViewer VerticalScrollBarVisibility='Auto'><StackPanel x:Name='DeviceList'/></ScrollViewer></DockPanel></TabItem>
 <TabItem Header='诊断与帮助'><Grid Margin='0,22,0,0'><Grid.RowDefinitions><RowDefinition Height='Auto'/><RowDefinition Height='*'/></Grid.RowDefinitions><WrapPanel><Button x:Name='Check' Content='检查运行环境'/><Button x:Name='Upgrade' Content='更新共享服务（任务结束后）'/><Button x:Name='LogFolder' Content='打开日志目录'/><Button x:Name='Guide' Content='使用说明'/></WrapPanel><TextBox x:Name='Logs' Grid.Row='1' IsReadOnly='True' TextWrapping='Wrap' VerticalScrollBarVisibility='Auto' FontFamily='Consolas' FontSize='12' Background='White'/></Grid></TabItem>
</TabControl></Grid></Grid></Window>";
    private DesktopManager(string root, string version)
    {
        this.root = root; this.version = version;
        stateRoot = Environment.GetEnvironmentVariable("CODEXPHONE_HOME") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codexphone");
        window = (Window)XamlReader.Parse(Xaml);
        window.Icon = BitmapFrame.Create(new Uri(Path.Combine(root, "runtime", "codexphone.ico")));
        status = Find<TextBlock>("Status"); summary = Find<TextBlock>("Summary"); accountSummary = Find<TextBlock>("AccountSummary");
        accountServiceState = Find<TextBlock>("AccountServiceState"); phoneLoginAddress = Find<TextBlock>("PhoneLoginAddress");
        logs = Find<TextBox>("Logs"); accountsUrl = Find<TextBox>("AccountsUrl"); hostUrl = Find<TextBox>("HostUrl"); username = Find<TextBox>("Username"); computerName = Find<TextBox>("ComputerName"); password = Find<PasswordBox>("Password");
        computerName.Text = Environment.MachineName;
        Find<TextBlock>("VersionLabel").Text = "版本 " + version + "  /  Windows";
        deviceList = Find<StackPanel>("DeviceList");
        Bind("Start", async () => { await EnsureAccounts(); await BeginSharedStartup(); });
        Bind("AccountsStart", async () => { await EnsureAccounts(); });
        var setupAccount=new Button{Content="创建账号 / 绑定电脑"};
        setupAccount.Click+=(s,e)=>{Find<TabControl>("Pages").SelectedIndex=1;username.Focus();};
        ((WrapPanel)Find<Button>("Start").Parent).Children.Add(setupAccount);
        Bind("Upgrade", async () => { if (MessageBox.Show("更新手机桥接会短暂断开手机。请先确认电脑任务已结束；运行中的任务会阻止更新。", "更新共享服务", MessageBoxButton.OKCancel) == MessageBoxResult.OK) await Script("Start-SharedCodex.ps1", "-WaitForDesktopExit -RefreshBridge"); });
        Bind("Register", async () => { await BindAccount(true); }); Bind("Login", async () => { await BindAccount(false); });
        Bind("Unbind", async () => { if (MessageBox.Show("解除后所有手机将断开本机连接，电脑任务继续执行。确定解除？", "解除绑定", MessageBoxButton.OKCancel) == MessageBoxResult.OK) await Request("/api/admin/account", "DELETE", null); });
        Bind("Check", async () => { await Script("Check-Install.ps1", ""); });
        Bind("OpenWeb", () => Open("http://127.0.0.1:4318"));
        Find<Button>("CopyLoginAddress").Click += (s,e) => { UpdateLoginAddress(); if (phoneLoginAddress.Text.StartsWith("http")) { Clipboard.SetText(phoneLoginAddress.Text); summary.Text="已复制手机登录地址。在安卓登录页粘贴后填写相同账号。"; } };
        accountsUrl.TextChanged += (s,e) => UpdateLoginAddress();
        hostUrl.TextChanged += (s,e) => { if(hostUrl.IsKeyboardFocusWithin)editedHostAddress=true; };
        Bind("Shortcut", async () => { await Script("Create-Shortcut.ps1", "-Executable \"" + System.Reflection.Assembly.GetExecutingAssembly().Location + "\""); });
        Bind("LogFolder", () => { string folder=Path.Combine(root,".codexphone");Directory.CreateDirectory(folder);return Open(folder); });
        Bind("Guide", () => Open(Path.Combine(root,"USER_GUIDE.txt")));
        timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(5) }; timer.Tick += async (s,e) => { await Refresh(); };
        window.Loaded += async (s,e) => { await Discover(); await Refresh(); timer.Start(); };
        window.Closed += (s,e) => timer.Stop();
        window.Closing += (s,e) => { if (busy) { e.Cancel=true; MessageBox.Show("请等待当前管理操作完成。电脑任务仍会继续。", "CodexPhone"); } };
    }
    private T Find<T>(string name) { return (T)window.FindName(name); }
    private void Bind(string name, Func<Task> action) { var button=Find<Button>(name);actions.Add(button);button.Click += async (s,e) => { await Act(action); }; }
    private async Task Act(Func<Task> action)
    {
        if (busy) return; busy=true; foreach(var b in actions)b.IsEnabled=false;
        status.Text="正在处理，请稍候";
        try { await action(); status.Text="操作完成"; await Refresh(); }
        catch(Exception error) { status.Text="当前操作未完成"; summary.Text=error.Message; logs.AppendText(error.Message+Environment.NewLine); }
        finally { busy=false;foreach(var b in actions)b.IsEnabled=true; }
    }
    private Task Open(string target) { Process.Start(new ProcessStartInfo(target){UseShellExecute=true});return Task.FromResult(0); }
    private Task BeginSharedStartup()
    {
        if (startupProcess != null && !startupProcess.HasExited) { status.Text="共享连接正在启动";summary.Text="CodexPhone 正在等待 Codex 正常退出并完成重启；管理中心仍可继续使用。";return Task.FromResult(0); }
        var info=new ProcessStartInfo("powershell.exe","-NoProfile -ExecutionPolicy Bypass -File \""+Path.Combine(root,"scripts","Start-SharedCodex.ps1")+"\" -WaitForDesktopExit") { UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=root,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=Encoding.UTF8,StandardErrorEncoding=Encoding.UTF8 };
        info.EnvironmentVariables["CODEXPHONE_UTF8"]="1";
        var process=new Process{StartInfo=info,EnableRaisingEvents=true};startupProcess=process;
        DataReceivedEventHandler output=(s,e)=>{if(e.Data!=null)window.Dispatcher.BeginInvoke((Action)(()=>{logs.AppendText(e.Data+Environment.NewLine);logs.ScrollToEnd();if(e.Data.Contains("Waiting for Codex to exit")){status.Text="等待退出 Codex";summary.Text="请先完成电脑任务，再从 Codex 菜单选择退出。无需关闭管理中心；账号服务和其他设置仍可继续操作。";}}));};
        process.OutputDataReceived+=output;process.ErrorDataReceived+=output;
        process.Exited+=(s,e)=>window.Dispatcher.BeginInvoke((Action)(async()=>{var failed=process.ExitCode!=0;status.Text=failed?"共享连接未完成":"共享连接启动完成";if(failed)summary.Text="请查看诊断日志中的说明；正在运行的任务未被强制结束。";process.Dispose();if(startupProcess==process)startupProcess=null;await Refresh();}));
        process.Start();process.BeginOutputReadLine();process.BeginErrorReadLine();
        status.Text="正在启动共享连接";summary.Text="启动过程在后台进行，管理中心其他功能仍可使用。若需要退出 Codex，请先完成当前任务。";
        return Task.FromResult(0);
    }
    private Task Discover()
    {
        tailscaleIp=null;
        try {
            foreach(var adapter in NetworkInterface.GetAllNetworkInterfaces()) {
                if(adapter.OperationalStatus!=OperationalStatus.Up || (adapter.Name+adapter.Description).IndexOf("Tailscale",StringComparison.OrdinalIgnoreCase)<0)continue;
                foreach(var address in adapter.GetIPProperties().UnicastAddresses)if(address.Address.AddressFamily==System.Net.Sockets.AddressFamily.InterNetwork)tailscaleIp=address.Address.ToString();
            }
            if(tailscaleIp!=null && !restoredBinding && !editedHostAddress && !hostUrl.IsKeyboardFocusWithin)hostUrl.Text="http://"+tailscaleIp+":4318";
        } catch { }
        UpdateLoginAddress();
        return Task.FromResult(0);
    }
    private void UpdateLoginAddress()
    {
        Uri service;
        if(!Uri.TryCreate(accountsUrl.Text.Trim(),UriKind.Absolute,out service)||(service.Scheme!="http"&&service.Scheme!="https")) { phoneLoginAddress.Text="请检查账号服务地址";return; }
        if(service.IsLoopback) {
            phoneLoginAddress.Text=tailscaleIp==null?"Tailscale 未连接，请开启后点击检查":new UriBuilder(service){Host=tailscaleIp}.Uri.ToString().TrimEnd('/');
        } else phoneLoginAddress.Text=service.ToString().TrimEnd('/');
        Find<Button>("CopyLoginAddress").IsEnabled=phoneLoginAddress.Text.StartsWith("http");
    }
    private async Task<string> ProbeAccountService()
    {
        try {
            var request=(HttpWebRequest)WebRequest.Create(accountsUrl.Text.Trim().TrimEnd('/')+"/health");request.Method="GET";request.Timeout=2500;request.Proxy=null;request.AllowAutoRedirect=false;
            using(var timeout=new System.Threading.CancellationTokenSource(3000))
            using(timeout.Token.Register(request.Abort))
            using(var response=await request.GetResponseAsync())using(var reader=new StreamReader(response.GetResponseStream())) {
                var data=json.Deserialize<Dictionary<string,object>>(await reader.ReadToEndAsync());
                if(data!=null&&data.ContainsKey("product")&&Convert.ToString(data["product"])=="CodexPhone Accounts")return "账号服务在线 · 版本 "+Convert.ToString(data["version"])+"\n"+(tailscaleIp==null?"未检测到在线 Tailscale，请检查网络连接":"Tailscale 已连接 · "+tailscaleIp);
            }
        } catch { }
        return "账号服务未运行 · 点击“开始连接手机”自动启动";
    }
    private async Task BindAccount(bool register)
    {
        if (password.Password.Length < 6) throw new Exception("密码至少需要 6 个字符。");
        await Request("/api/admin/status","GET",null);
        await EnsureAccounts();
        var payload=new { accountsUrl=accountsUrl.Text.Trim(),url=hostUrl.Text.Trim(),username=username.Text.Trim(),password=password.Password,name=computerName.Text.Trim(),register=register };
        await Request("/api/admin/account","POST",payload);password.Clear();Find<TabControl>("Pages").SelectedIndex=0;
    }
    private async Task EnsureAccounts()
    {
        Uri service;
        if(!Uri.TryCreate(accountsUrl.Text.Trim(),UriKind.Absolute,out service)||(service.Scheme!="http"&&service.Scheme!="https")||(service.IsLoopback&&service.Port<1024))throw new Exception("请填写有效的账号服务地址，例如 http://127.0.0.1:4321。");
        if(service.IsLoopback)await Script("Start-AccountService.ps1","-Port "+service.Port);
        else if(!(await ProbeAccountService()).StartsWith("账号服务在线"))throw new Exception("无法访问独立账号服务。请先在服务所在电脑启动它，再检查 Tailscale 与服务地址。");
    }
    private async Task<Dictionary<string,object>> Request(string route,string method,object body)
    {
        string secretPath=Path.Combine(stateRoot,"admin-token");
        if(!File.Exists(secretPath))throw new Exception("请先启用共享连接，随后管理账号和手机权限。");
        var request=(HttpWebRequest)WebRequest.Create("http://127.0.0.1:4318"+route);request.Method=method;request.Timeout=10000;request.ReadWriteTimeout=10000;request.AllowAutoRedirect=false;request.Proxy=null;
        request.Headers["Authorization"]="Bearer "+File.ReadAllText(secretPath).Trim();
        using(var timeout=new System.Threading.CancellationTokenSource(15000))
        using(timeout.Token.Register(request.Abort)) {
        if(body!=null){byte[] bytes=Encoding.UTF8.GetBytes(json.Serialize(body));request.ContentType="application/json";request.ContentLength=bytes.Length;using(var stream=await request.GetRequestStreamAsync())await stream.WriteAsync(bytes,0,bytes.Length);}
        try { using(var response=await request.GetResponseAsync())using(var reader=new StreamReader(response.GetResponseStream()))return json.Deserialize<Dictionary<string,object>>(await reader.ReadToEndAsync()); }
        catch(WebException error){ if(error.Response!=null){using(var reader=new StreamReader(error.Response.GetResponseStream())) { var data=json.Deserialize<Dictionary<string,object>>(reader.ReadToEnd());throw new Exception(data.ContainsKey("error")?Convert.ToString(data["error"]):"电脑服务没有完成请求"); }}throw new Exception("无法连接本机共享服务。请先启用共享连接；升级旧服务须等任务结束。"); }
        }
    }
    private async Task Refresh()
    {
        if(refreshing)return;refreshing=true;
        try {
            await Discover();
            accountServiceState.Text=await ProbeAccountService();
            var data=await Request("/api/admin/status","GET",null);
            status.Text=Convert.ToString(data["status"])=="ready"?"共享连接已就绪":"正在恢复电脑连接";
            summary.Text=startupProcess!=null&&!startupProcess.HasExited
                ? "共享启动正在后台进行；管理中心仍可操作。正在运行的任务："+Convert.ToString(data["activeTasks"])+"。"
                : "正在运行的任务："+Convert.ToString(data["activeTasks"])+"。关闭管理中心不影响任务。";
            var account=data["account"] as Dictionary<string,object>;
            if(!restoredBinding && account!=null) {
                if(!accountsUrl.IsKeyboardFocusWithin)accountsUrl.Text=Convert.ToString(account["accountsUrl"]);
                if(!editedHostAddress && !hostUrl.IsKeyboardFocusWithin)hostUrl.Text=Convert.ToString(account["url"]);
                if(!computerName.IsKeyboardFocusWithin)computerName.Text=Convert.ToString(account["name"]);
                restoredBinding=true;UpdateLoginAddress();
            }
            if(account!=null){accountSummary.Text="已登录："+account["username"]+Environment.NewLine+"绑定电脑："+account["name"]+Environment.NewLine+"手机登录用 4321；任务连接用 4318。在手机登录同一账号即可连接。";if(!username.IsKeyboardFocusWithin)username.Text=Convert.ToString(account["username"]);}
            else accountSummary.Text="还没有绑定账号。启用共享连接后，到账号与电脑页面创建账号并绑定。";
            RenderDevices(data["devices"] as object[]);
        } catch(Exception error){if(!busy&&(startupProcess==null||startupProcess.HasExited)){status.Text="尚未连接管理服务";summary.Text=error.Message;}}
        finally{refreshing=false;}
    }
    private void RenderDevices(object[] devices)
    {
        deviceList.Children.Clear();
        if(devices==null||devices.Length==0){deviceList.Children.Add(new TextBlock{Text="还没有手机连接。先绑定账号，再在手机登录。",Foreground=Brushes.SlateGray});return;}
        foreach(Dictionary<string,object> device in devices)
        {
            string id=Convert.ToString(device["id"]),name=Convert.ToString(device["name"]);
            bool blocked=device.ContainsKey("blocked")&&Convert.ToBoolean(device["blocked"]);
            string permission=blocked?"已禁用":device.ContainsKey("permission")&&Convert.ToString(device["permission"])=="read"?"只读":"可控制";
            var row=new StackPanel{Margin=new Thickness(16)};
            row.Children.Add(new TextBlock{Text=name+"   "+permission,FontWeight=FontWeights.SemiBold,FontSize=16});
            row.Children.Add(new TextBlock{Text="最近访问："+(device.ContainsKey("lastSeen")?Convert.ToString(device["lastSeen"]):"未记录"),Foreground=Brushes.SlateGray,Margin=new Thickness(0,8,0,12)});
            var buttons=new WrapPanel();
            foreach(string mode in new[]{"read","control","blocked"}){
                string chosen=mode;
                var button=new Button{Content=mode=="read"?"设为只读":mode=="control"?"允许控制":"撤销 / 禁用"};
                button.Click+=async(s,e)=>{await Act(async()=>{if(chosen=="blocked"&&MessageBox.Show("将断开此手机并禁止重新登录本机。当前电脑任务不会停止。",name,MessageBoxButton.OKCancel)!=MessageBoxResult.OK)return;await Request("/api/admin/devices/"+Uri.EscapeDataString(id)+"/permission","POST",new{permission=chosen});});};
                buttons.Children.Add(button);
            }
            row.Children.Add(buttons);deviceList.Children.Add(new Border{Child=row,Background=Brushes.White,BorderBrush=new SolidColorBrush(Color.FromRgb(222,228,237)),BorderThickness=new Thickness(1),CornerRadius=new CornerRadius(8),Margin=new Thickness(0,0,0,12)});
        }
    }
    private async Task Script(string name,string args)
    {
        var info=new ProcessStartInfo("powershell.exe","-NoProfile -ExecutionPolicy Bypass -File \""+Path.Combine(root,"scripts",name)+"\" "+args){UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=root,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=Encoding.UTF8,StandardErrorEncoding=Encoding.UTF8};
        info.EnvironmentVariables["CODEXPHONE_UTF8"]="1";
        using(var process=new Process{StartInfo=info}){
            DataReceivedEventHandler received=(s,e)=>{if(e.Data!=null)window.Dispatcher.BeginInvoke((Action)(()=>{logs.AppendText(e.Data+Environment.NewLine);logs.ScrollToEnd();if(e.Data.Contains("A phone task is running"))summary.Text="任务仍在运行。请等它完成后再更新连接，现有任务不会中断。";if(e.Data.Contains("Waiting for Codex to exit"))summary.Text="请先完成任务，再从 Codex 菜单正常退出。随后会自动重新打开。";}));};
            process.OutputDataReceived+=received;process.ErrorDataReceived+=received;process.Start();process.BeginOutputReadLine();process.BeginErrorReadLine();await Task.Run((Action)process.WaitForExit);
            if(process.ExitCode!=0)throw new Exception("操作未完成。若任务正在运行，请待任务结束后再更新连接；详细原因可在诊断与帮助查看。");
        }
    }
    public static void Run(string root,string version){new DesktopManager(root,version).window.ShowDialog();}
    public static void Render(string root,string version,string file)
    {
        var manager=new DesktopManager(root,version);manager.window.ShowInTaskbar=false;manager.window.WindowStartupLocation=WindowStartupLocation.Manual;manager.window.Left=-10000;manager.window.Top=-10000;manager.window.Show();manager.window.UpdateLayout();
        manager.timer.Stop();manager.status.Text="准备连接你的手机";manager.summary.Text="首次使用：开始连接手机 → 创建账号并绑定电脑 → 手机登录。";manager.phoneLoginAddress.Text="http://100.x.x.x:4321";manager.accountServiceState.Text="账号服务与电脑连接分别检查，异常时在这里显示下一步。";manager.window.UpdateLayout();
        var bitmap=new RenderTargetBitmap((int)manager.window.ActualWidth,(int)manager.window.ActualHeight,96,96,PixelFormats.Pbgra32);bitmap.Render(manager.window);var encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(bitmap));using(var stream=File.Create(file))encoder.Save(stream);manager.window.Close();
    }
}
