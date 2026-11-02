param(
  [switch]$SelfTest,
  [string]$Screenshot
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false) } catch {}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if ($null -eq ('CaseGraphNativeMethods' -as [type])) {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CaseGraphNativeMethods {
  [DllImport("shcore.dll")]
  public static extern int SetProcessDpiAwareness(int value);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr handle, int command);
}
'@
}

try { [void][CaseGraphNativeMethods]::SetProcessDpiAwareness(2) } catch { [void][CaseGraphNativeMethods]::SetProcessDPIAware() }

$script:Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$script:IconPath = Join-Path $script:Root 'assets\icon\icon.ico'
$script:NodePath = $null
$script:NodeVersion = '--'
$script:Port = 3000
$script:DbPath = Join-Path $script:Root 'data\wall.db'
$script:RuntimeDir = Join-Path $script:Root 'data\launcher'
$script:ServerLog = Join-Path $script:RuntimeDir 'server.log'
$script:PreviousLog = Join-Path $script:RuntimeDir 'server.prev.log'
$script:ServerErrorLog = Join-Path $script:RuntimeDir 'server.error.log'
$script:PreviousErrorLog = Join-Path $script:RuntimeDir 'server.prev.error.log'
$script:LauncherLog = Join-Path $script:RuntimeDir 'launcher.log'
$script:StartedProcess = $null
$script:StartedPid = 0
$script:ServiceStartedAt = $null
$script:LastHealth = $null
$script:UiState = 'stopped'
$script:UiForm = $null
$script:UiTimer = $null
$script:ProbeWorker = $null
$script:ProbeBusy = $false
$script:ProbeResult = $null
$script:NextProbeAt = [DateTime]::MinValue
$script:FastPollUntil = [DateTime]::MinValue
$script:LogExpanded = $false
$script:InstallProcess = $null
$script:OpenOnReady = $false
$script:FirstTrayNotice = $false
$script:Exiting = $false
$script:Mutex = $null
$script:ShowEvent = $null
$script:Tooltip = $null
$script:Ui = @{}

$script:StateInfo = @{
  running = [ordered]@{Label='執行中'; Detail='服務已回應，案件圖譜可以開啟。'; Source='本啟動器'; Primary='重啟服務'; Summary='最後一行：GET /api/health 200'}
  external = [ordered]@{Label='執行中（外部啟動）'; Detail='偵測到既有服務，啟動器只負責監看。'; Source='外部啟動'; Primary='重新接管'; Summary='最後一行：外部程序已回應'}
  stopped = [ordered]@{Label='已停止'; Detail='服務尚未啟動；資料與設定會保留。'; Source='待機'; Primary='啟動服務'; Summary='最後一行：服務已停止'}
  error = [ordered]@{Label='錯誤'; Detail='服務未能完成啟動，請查看展開的紀錄。'; Source='需要處理'; Primary='重試啟動'; Summary='最後一行：埠 3000 已被占用'}
  port = [ordered]@{Label='埠被占用'; Detail='埠已被其他程序使用，服務尚未啟動。'; Source='需要處理'; Primary='重試啟動'; Summary='最後一行：埠被占用'}
  installing = [ordered]@{Label='啟動中'; Detail='正在檢查 Node.js 與安裝套件。'; Source='首次啟動'; Primary='準備中'; Summary='npm ci 正在安裝套件…'}
  starting = [ordered]@{Label='啟動中'; Detail='正在啟動本機服務，請稍候。'; Source='本地程序'; Primary='啟動中'; Summary='等待 /api/health 回應'}
}

function Ensure-Directory([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { New-Item -ItemType Directory -Path $Path -Force | Out-Null }
}

function Find-CommandPath([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $command) { return $null }
  if ($command.Source) { return [IO.Path]::GetFullPath($command.Source) }
  return $command.Definition
}

function Resolve-Config {
  $script:NodePath = Find-CommandPath 'node.exe'
  if ($null -eq $script:NodePath) { $script:NodePath = Find-CommandPath 'node' }
  if ($script:NodePath) {
    try { $script:NodeVersion = (& $script:NodePath --version | Select-Object -First 1).Trim() } catch { $script:NodeVersion = '--' }
  }
  $portText = [Environment]::GetEnvironmentVariable('WALL_PORT', 'Process')
  if ([string]::IsNullOrWhiteSpace($portText)) { $script:Port = 3000 }
  else {
    $parsedPort = 0
    if (-not [int]::TryParse($portText, [ref]$parsedPort) -or $parsedPort -lt 1 -or $parsedPort -gt 65535) { $script:Port = 3000 }
    else { $script:Port = $parsedPort }
  }
  $db = [Environment]::GetEnvironmentVariable('WALL_DB', 'Process')
  if ([string]::IsNullOrWhiteSpace($db)) { $db = Join-Path $script:Root 'data\wall.db' }
  $script:DbPath = [IO.Path]::GetFullPath($db)
}

function Test-NodeVersion {
  if (-not $script:NodePath) { return $false }
  $match = [regex]::Match($script:NodeVersion, '^v(\d+)')
  return $match.Success -and ([int]$match.Groups[1].Value -ge 24)
}

function Write-LauncherLog([string]$Message) {
  Ensure-Directory $script:RuntimeDir
  Add-Content -LiteralPath $script:LauncherLog -Value ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $Message) -Encoding UTF8
}

function Rotate-ServerLog {
  Ensure-Directory $script:RuntimeDir
  if (Test-Path -LiteralPath $script:PreviousLog -PathType Leaf) { Remove-Item -LiteralPath $script:PreviousLog -Force }
  if (Test-Path -LiteralPath $script:ServerLog -PathType Leaf) { Move-Item -LiteralPath $script:ServerLog -Destination $script:PreviousLog -Force }
  if (Test-Path -LiteralPath $script:PreviousErrorLog -PathType Leaf) { Remove-Item -LiteralPath $script:PreviousErrorLog -Force }
  if (Test-Path -LiteralPath $script:ServerErrorLog -PathType Leaf) { Move-Item -LiteralPath $script:ServerErrorLog -Destination $script:PreviousErrorLog -Force }
}

function Get-ServerCommandLine {
  return ('/d /c ""{0}" server\server.js >> "{1}" 2>&1"' -f $script:NodePath, $script:ServerLog)
}

function Start-NodeProcess {
  Ensure-Directory $script:RuntimeDir
  $oldPort = $env:WALL_PORT; $oldDb = $env:WALL_DB
  try {
    $env:WALL_PORT = [string]$script:Port; $env:WALL_DB = [string]$script:DbPath
    return (Start-Process -FilePath $script:NodePath -ArgumentList @('server\server.js') -WorkingDirectory $script:Root -WindowStyle Hidden -RedirectStandardOutput $script:ServerLog -RedirectStandardError $script:ServerErrorLog -PassThru)
  } finally {
    if ($null -eq $oldPort) { Remove-Item Env:WALL_PORT -ErrorAction SilentlyContinue } else { $env:WALL_PORT = $oldPort }
    if ($null -eq $oldDb) { Remove-Item Env:WALL_DB -ErrorAction SilentlyContinue } else { $env:WALL_DB = $oldDb }
  }
}

function Start-CommandProcess([string]$CommandLine, [string]$WorkingDirectory) {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $env:ComSpec
  $info.Arguments = $CommandLine
  $info.WorkingDirectory = $WorkingDirectory
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.EnvironmentVariables['WALL_PORT'] = [string]$script:Port
  $info.EnvironmentVariables['WALL_DB'] = [string]$script:DbPath
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $info
  if (-not $process.Start()) { throw '無法啟動程序' }
  return $process
}

function Start-WallProcess {
  if ($script:StartedProcess -and -not $script:StartedProcess.HasExited) { return $script:StartedProcess }
  Rotate-ServerLog
  Write-LauncherLog ('start requested, port {0}' -f $script:Port)
  $script:StartedProcess = Start-NodeProcess
  $script:StartedPid = $script:StartedProcess.Id
  $script:ServiceStartedAt = Get-Date
  return $script:StartedProcess
}

function Stop-ProcessTree([int]$ProcessId) {
  if ($ProcessId -le 0) { return }
  $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
  $killer = Start-Process -FilePath $taskkill -ArgumentList @('/PID', [string]$ProcessId, '/T', '/F') -WindowStyle Hidden -Wait -PassThru
  if ($killer.ExitCode -ne 0) {
    Write-LauncherLog ('taskkill returned {0} for verified PID {1}; using direct process stop' -f $killer.ExitCode, $ProcessId)
    $candidate = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($candidate) { Stop-Process -Id $ProcessId -Force -ErrorAction Stop }
  }
}

function Stop-OwnService {
  $processId = $script:StartedPid
  $stoppingProcess = $script:StartedProcess
  if ($processId -gt 0 -and $script:StartedProcess -and -not $script:StartedProcess.HasExited) {
    Stop-ProcessTree $processId
    try { $script:StartedProcess.WaitForExit(5000) | Out-Null } catch {}
  }
  if ($stoppingProcess) { try { $stoppingProcess.Close() } catch {} }
  Start-Sleep -Milliseconds 150
  $script:StartedProcess = $null
  $script:StartedPid = 0
  $script:ServiceStartedAt = $null
}

function Stop-VerifiedExternalService([object]$Health) {
  if ($null -eq $Health -or $Health.app -ne 'casegraph' -or [int]$Health.pid -le 0) { throw '外部服務健康資料無效，未停止任何程序' }
  Stop-ProcessTree ([int]$Health.pid)
}

function Read-WebResponse([object]$Response) {
  $reader = New-Object IO.StreamReader($Response.GetResponseStream())
  try { return $reader.ReadToEnd() } finally { $reader.Dispose(); $Response.Dispose() }
}

function Get-HealthSnapshot([int]$PortNumber) {
  $request = [Net.HttpWebRequest]::Create(('http://127.0.0.1:{0}/api/health' -f $PortNumber))
  $request.Method = 'GET'
  $request.Timeout = 1000
  $request.ReadWriteTimeout = 1000
  $response = $null
  try {
    $response = $request.GetResponse()
    $text = Read-WebResponse $response
    $value = $null
    try { $value = $text | ConvertFrom-Json } catch {}
    if ($value -and $value.app -eq 'casegraph') { return [pscustomobject]@{Kind='healthy'; Health=$value; Error=$null} }
    return [pscustomobject]@{Kind='foreign'; Health=$value; Error='回應不是 CaseGraph'}
  } catch [Net.WebException] {
    if ($_.Exception.Response) {
      try { $text = Read-WebResponse $_.Exception.Response } catch { $text = '' }
      $value = $null
      try { $value = $text | ConvertFrom-Json } catch {}
      return [pscustomobject]@{Kind='foreign'; Health=$value; Error=('HTTP ' + [int]$_.Exception.Response.StatusCode)}
    }
    return [pscustomobject]@{Kind='offline'; Health=$null; Error=$_.Exception.Message}
  } catch {
    return [pscustomobject]@{Kind='offline'; Health=$null; Error=$_.Exception.Message}
  }
}

function Wait-ForHealth([int]$TimeoutSeconds) {
  $end = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $probe = Get-HealthSnapshot $script:Port
    if ($probe.Kind -eq 'healthy') { $script:LastHealth = $probe.Health; return $probe.Health }
    if ($probe.Kind -eq 'foreign') { throw '埠回應但不是 CaseGraph' }
    Start-Sleep -Milliseconds 150
  } while ((Get-Date) -lt $end)
  throw '服務未在期限內回應 /api/health'
}

function Get-FreePort {
  $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { return $listener.LocalEndpoint.Port } finally { $listener.Stop() }
}

function New-McpConfig([object]$Health) {
  $envValues = [ordered]@{WALL_DB=[string]$Health.db; WALL_PORT=[string]$Health.port}
  $server = [ordered]@{command=$script:NodePath; args=@((Join-Path $script:Root 'server\mcp.js')); env=$envValues}
  $config = [ordered]@{mcpServers=[ordered]@{'detective-wall'=$server}}
  return ($config | ConvertTo-Json -Compress -Depth 8)
}

function Write-Pass([string]$Message) { Write-Output ('PASS ' + $Message) }

function Invoke-SelfTest {
  $testOutput = [Environment]::GetEnvironmentVariable('WALL_TEST_OUT', 'Process')
  if ($testOutput) { $script:RuntimeDir = Join-Path $testOutput 'temp\launcher-selftest' }
  else { $script:RuntimeDir = Join-Path ([IO.Path]::GetTempPath()) ('casegraph-launcher-' + [guid]::NewGuid().ToString('N')) }
  $script:ServerLog = Join-Path $script:RuntimeDir 'server.log'
  $script:PreviousLog = Join-Path $script:RuntimeDir 'server.prev.log'
  $script:ServerErrorLog = Join-Path $script:RuntimeDir 'server.error.log'
  $script:PreviousErrorLog = Join-Path $script:RuntimeDir 'server.prev.error.log'
  $script:LauncherLog = Join-Path $script:RuntimeDir 'launcher.log'
  Ensure-Directory $script:RuntimeDir
  Resolve-Config
  if (-not (Test-NodeVersion)) { throw ('找不到 Node.js 24 以上，目前為 ' + $script:NodeVersion) }
  if (-not (Test-Path -LiteralPath (Join-Path $script:Root 'node_modules') -PathType Container)) { throw '找不到 node_modules；SelfTest 不會自動下載套件' }
  $script:Port = Get-FreePort
  $script:DbPath = Join-Path $script:RuntimeDir 'selftest.db'
  Write-Pass ('Node.js ' + $script:NodeVersion)
  try {
    [void](Start-WallProcess)
    Write-Pass '啟動服務'
    $health = Wait-ForHealth 30
    if ($health.app -ne 'casegraph' -or [int]$health.pid -ne $script:StartedPid) { throw '健康資料未指向啟動器程序' }
    Write-Pass '服務健康'
    Stop-OwnService
    [void](Start-WallProcess)
    Write-Pass '重啟服務'
    $health = Wait-ForHealth 30
    if ([int]$health.pid -ne $script:StartedPid) { throw '重啟後 PID 不一致' }
    Write-Pass '重啟後健康'
    Stop-OwnService
    Write-Pass '停止服務'
    $stopped = Get-HealthSnapshot $script:Port
    if ($stopped.Kind -ne 'offline') { throw '停止後 /api/health 仍有回應' }
    Write-Pass '確認已停止'
    $configText = New-McpConfig $health
    $config = $configText | ConvertFrom-Json
    $mcp = $config.mcpServers.'detective-wall'
    $expectedMcpPath = Join-Path $script:Root 'server\mcp.js'
    $mcpValid = ($mcp.command -eq $script:NodePath) -and ($mcp.args[0] -eq $expectedMcpPath) -and ($mcp.env.WALL_DB -eq $health.db) -and ([string]$mcp.env.WALL_PORT -eq [string]$health.port)
    if (-not $mcpValid) { throw 'Claude MCP 設定內容不符' }
    [IO.File]::WriteAllText((Join-Path $script:RuntimeDir 'claude-mcp.json'), $configText, (New-Object Text.UTF8Encoding($false)))
    Write-Pass 'Claude MCP JSON 已產生並驗證'
  } finally {
    if ($script:StartedProcess -and -not $script:StartedProcess.HasExited) { Stop-OwnService }
  }
}

function Get-LogTail {
  $parts = @()
  if (Test-Path -LiteralPath $script:ServerLog -PathType Leaf) { try { $parts += Get-Content -LiteralPath $script:ServerLog -Tail 200 } catch {} }
  if (Test-Path -LiteralPath $script:ServerErrorLog -PathType Leaf) { try { $parts += Get-Content -LiteralPath $script:ServerErrorLog -Tail 200 } catch {} }
  return ($parts -join "`r`n")
}

function Format-Uptime([object]$Health) {
  if ($null -eq $Health -or -not $Health.startedAt) { return '--:--:--' }
  try {
    $elapsed = (Get-Date) - [DateTime]::Parse([string]$Health.startedAt)
    if ($elapsed.TotalSeconds -lt 0) { $elapsed = [TimeSpan]::Zero }
    return ('{0:00}:{1:00}:{2:00}' -f [int]$elapsed.TotalHours, $elapsed.Minutes, $elapsed.Seconds)
  } catch { return '--:--:--' }
}

function Get-LastLogLine {
  $tail = Get-LogTail
  if ([string]::IsNullOrWhiteSpace($tail)) { return '最後一行：尚無紀錄' }
  $lines = $tail -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  if ($lines.Count -eq 0) { return '最後一行：尚無紀錄' }
  return ('最後一行：' + $lines[$lines.Count - 1].Trim())
}

function Set-FactValue([string]$Name, [string]$Value) {
  if ($script:Ui.ContainsKey($Name)) { $script:Ui[$Name].Text = $Value }
}

function Set-VisualState([string]$State, [object]$Health, [string]$DetailOverride) {
  if (-not $script:StateInfo.ContainsKey($State)) { $State = 'stopped' }
  $previousState = $script:UiState
  $script:UiState = $State
  $info = $script:StateInfo[$State]
  $script:Ui.status.Text = $info.Label
  $script:Ui.detail.Text = if ($DetailOverride) { $DetailOverride } else { $info.Detail }
  $script:Ui.source.Text = $info.Source
  $script:Ui.primary.Text = ([char]0x25B6).ToString() + '  ' + $info.Primary
  $script:Ui.summary.Text = if ($State -eq 'running' -and $Health) { '最後一行：GET /api/health 200' } elseif ($State -eq 'error' -or $State -eq 'port' -or $State -eq 'stopped' -or $State -eq 'installing') { $info.Summary } else { Get-LastLogLine }
  $script:Ui.logBody.Text = Get-LogTail
  if ([string]::IsNullOrWhiteSpace($script:Ui.logBody.Text)) { $script:Ui.logBody.Text = $info.Summary }
  $script:Ui.logBody.SelectionStart = 0; $script:Ui.logBody.SelectionLength = 0
  $script:Ui.install.Visible = $State -eq 'installing'
  if ($State -eq 'error' -or $State -eq 'port') { $script:LogExpanded = $true }
  elseif ($previousState -ne $State) { $script:LogExpanded = $false }
  $expandedLog = [bool]$script:LogExpanded
  $script:Ui.logBody.Visible = $expandedLog
  $script:Ui.logPanel.Height = if ($expandedLog) { 125 } else { 31 }
  $script:Ui.logPanel.Top = if ($expandedLog) { 208 } else { 302 }
  $script:Ui.chevron.Text = '›'
  $script:Ui.uptime.Text = if ($State -eq 'running' -or $State -eq 'external') { Format-Uptime $Health } else { if ($State -eq 'installing') { '準備中' } else { '--:--:--' } }
  $script:Ui.node.Text = if ($State -eq 'installing') { '檢查中…' } else { $script:NodeVersion }
  $db = if ($Health -and $Health.db) { [string]$Health.db } else { $script:DbPath }
  $port = if ($Health -and $Health.port) { [string]$Health.port } else { [string]$script:Port }
  $url = 'http://127.0.0.1:' + $port + '/'
  Set-FactValue 'url' $url; Set-FactValue 'port' $port; Set-FactValue 'db' $db
  $color = [Drawing.Color]::FromArgb(36, 133, 86); $soft = [Drawing.Color]::FromArgb(233, 246, 239); $border = [Drawing.Color]::FromArgb(167, 214, 187)
  if ($State -eq 'stopped' -or $State -eq 'starting' -or $State -eq 'installing') { $color = [Drawing.Color]::FromArgb(103, 122, 133); $soft = [Drawing.Color]::FromArgb(240, 243, 245); $border = [Drawing.Color]::FromArgb(197, 208, 214) }
  if ($State -eq 'installing') { $color = [Drawing.Color]::FromArgb(155, 116, 25); $soft = [Drawing.Color]::FromArgb(251, 244, 222); $border = [Drawing.Color]::FromArgb(224, 202, 130) }
  if ($State -eq 'error' -or $State -eq 'port') { $color = [Drawing.Color]::FromArgb(168, 54, 61); $soft = [Drawing.Color]::FromArgb(255, 240, 240); $border = [Drawing.Color]::FromArgb(230, 180, 184) }
  $script:Ui.badge.BackColor = $soft; $script:Ui.badge.BorderStyle = [Windows.Forms.BorderStyle]::FixedSingle; $script:Ui.badge.ForeColor = $color
  $script:Ui.dot.BackColor = $color; $script:Ui.dotPanel.BackColor = $color
  $script:Ui.stop.Enabled = $true
  $script:Ui.primary.Enabled = $State -ne 'installing' -and $State -ne 'starting'
  $script:Ui.logPanel.BorderStyle = [Windows.Forms.BorderStyle]::FixedSingle
  if ($State -eq 'error' -or $State -eq 'port') { $script:Ui.logPanel.BackColor = [Drawing.Color]::FromArgb(255, 250, 250) }
  else { $script:Ui.logPanel.BackColor = [Drawing.Color]::FromArgb(248, 250, 251) }
  Update-TrayText
}

function Toggle-Log {
  if (-not $script:Ui.ContainsKey('logPanel')) { return }
  $script:LogExpanded = -not [bool]$script:LogExpanded
  $script:Ui.logBody.Visible = $script:LogExpanded
  $script:Ui.logPanel.Height = if ($script:LogExpanded) { 125 } else { 31 }
  $script:Ui.logPanel.Top = if ($script:LogExpanded) { 208 } else { 302 }
}

function New-UiLabel([string]$Text, [int]$X, [int]$Y, [int]$Width, [int]$Height, [int]$Size = 9) {
  $label = New-Object Windows.Forms.Label
  $label.Text = $Text; $label.Location = New-Object Drawing.Point($X, $Y); $label.Size = New-Object Drawing.Size($Width, $Height)
  $label.Font = New-Object Drawing.Font('Microsoft JhengHei UI', $Size)
  $label.AutoEllipsis = $true; $label.UseCompatibleTextRendering = $false
  return $label
}

function New-NavButton([Windows.Forms.Control]$Parent, [string]$Text, [int]$Y, [string]$Kind = 'normal') {
  $button = New-Object Windows.Forms.Button
  $button.Text = $Text; $button.Location = New-Object Drawing.Point(10, $Y); $button.Size = New-Object Drawing.Size(162, 30)
  $button.Font = New-Object Drawing.Font('Microsoft JhengHei UI', 9)
  $button.TextAlign = [Drawing.ContentAlignment]::MiddleLeft; $button.Padding = New-Object Windows.Forms.Padding(8, 0, 4, 0)
  $button.FlatStyle = [Windows.Forms.FlatStyle]::Flat; $button.FlatAppearance.BorderSize = 1; $button.TabStop = $false
  $button.UseVisualStyleBackColor = $false; $button.Cursor = [Windows.Forms.Cursors]::Default
  $button.FlatAppearance.MouseOverBackColor = [Drawing.Color]::FromArgb(234, 240, 244)
  if ($Kind -eq 'primary') { $button.BackColor = [Drawing.Color]::FromArgb(47, 111, 159); $button.ForeColor = [Drawing.Color]::White; $button.FlatAppearance.BorderColor = [Drawing.Color]::FromArgb(36, 91, 133) }
  elseif ($Kind -eq 'stop') { $button.BackColor = [Drawing.Color]::FromArgb(247, 249, 250); $button.ForeColor = [Drawing.Color]::FromArgb(146, 59, 67); $button.FlatAppearance.BorderColor = [Drawing.Color]::FromArgb(247, 249, 250) }
  else { $button.BackColor = [Drawing.Color]::FromArgb(247, 249, 250); $button.ForeColor = [Drawing.Color]::FromArgb(38, 54, 64); $button.FlatAppearance.BorderColor = [Drawing.Color]::FromArgb(247, 249, 250) }
  [void]$Parent.Controls.Add($button)
  return $button
}

function Add-Fact([Windows.Forms.Control]$Parent, [string]$Name, [string]$Caption, [int]$X, [int]$Y, [int]$Width) {
  $panel = New-Object Windows.Forms.Panel
  $panel.Location = New-Object Drawing.Point($X, $Y); $panel.Size = New-Object Drawing.Size($Width, 39); $panel.BorderStyle = [Windows.Forms.BorderStyle]::FixedSingle; $panel.ForeColor = [Drawing.Color]::FromArgb(183, 197, 206); $panel.BackColor = [Drawing.Color]::FromArgb(247, 249, 250)
  [void]$Parent.Controls.Add($panel)
  $captionLabel = New-UiLabel $Caption 8 4 ($Width - 16) 13 7
  $captionLabel.ForeColor = [Drawing.Color]::FromArgb(97, 116, 129)
  [void]$panel.Controls.Add($captionLabel)
  $valueLabel = New-UiLabel '' 8 18 ($Width - 16) 15 8
  $valueLabel.ForeColor = [Drawing.Color]::FromArgb(38, 54, 64)
  [void]$panel.Controls.Add($valueLabel)
  $script:Ui[$Name] = $valueLabel
}

function New-LauncherForm([string]$InitialState = 'stopped', [switch]$ScreenshotMode) {
  $form = New-Object Windows.Forms.Form
  $form.Text = 'CaseGraph 啟動器'; $form.FormBorderStyle = [Windows.Forms.FormBorderStyle]::None; $form.ClientSize = New-Object Drawing.Size(640, 420)
  $form.StartPosition = [Windows.Forms.FormStartPosition]::CenterScreen; $form.AutoScaleMode = [Windows.Forms.AutoScaleMode]::Dpi; $form.AutoScaleDimensions = New-Object Drawing.SizeF(96, 96)
  $form.Font = New-Object Drawing.Font('Microsoft JhengHei UI', 9); $form.BackColor = [Drawing.Color]::White; $form.ShowInTaskbar = -not $ScreenshotMode
  if (Test-Path -LiteralPath $script:IconPath -PathType Leaf) { try { $form.Icon = New-Object Drawing.Icon($script:IconPath) } catch {} }
  $titleBar = New-Object Windows.Forms.Panel; $titleBar.Location = New-Object Drawing.Point(0, 0); $titleBar.Size = New-Object Drawing.Size(640, 32); $titleBar.BackColor = [Drawing.Color]::FromArgb(38, 50, 59)
  [void]$form.Controls.Add($titleBar)
  $titleIcon = New-Object Windows.Forms.PictureBox; $titleIcon.Location = New-Object Drawing.Point(9, 6); $titleIcon.Size = New-Object Drawing.Size(19, 19); $titleIcon.SizeMode = [Windows.Forms.PictureBoxSizeMode]::Zoom
  if (Test-Path -LiteralPath (Join-Path $script:Root 'assets\icon\icon-32.png')) { $titleIcon.Image = [Drawing.Image]::FromFile((Join-Path $script:Root 'assets\icon\icon-32.png')) }
  [void]$titleBar.Controls.Add($titleIcon)
  $titleLabel = New-UiLabel 'CaseGraph 啟動器' 36 7 220 18 9; $titleLabel.ForeColor = [Drawing.Color]::FromArgb(233, 240, 244); $titleLabel.Font = New-Object Drawing.Font('Microsoft JhengHei UI', 9, [Drawing.FontStyle]::Bold); [void]$titleBar.Controls.Add($titleLabel)
  $minButton = New-UiLabel '—' 575 5 22 21 10; $minButton.AutoEllipsis = $false; $minButton.TextAlign = [Drawing.ContentAlignment]::MiddleCenter; $minButton.ForeColor = [Drawing.Color]::FromArgb(187, 202, 210); [void]$titleBar.Controls.Add($minButton)
  $closeButton = New-UiLabel '×' 604 4 25 22 12; $closeButton.AutoEllipsis = $false; $closeButton.TextAlign = [Drawing.ContentAlignment]::MiddleCenter; $closeButton.ForeColor = [Drawing.Color]::FromArgb(255, 208, 211); [void]$titleBar.Controls.Add($closeButton)
  $shell = New-Object Windows.Forms.Panel; $shell.Location = New-Object Drawing.Point(0, 32); $shell.Size = New-Object Drawing.Size(640, 363); [void]$form.Controls.Add($shell)
  $sidebar = New-Object Windows.Forms.Panel; $sidebar.Location = New-Object Drawing.Point(0, 0); $sidebar.Size = New-Object Drawing.Size(182, 363); $sidebar.BackColor = [Drawing.Color]::FromArgb(247, 249, 250); $sidebar.ForeColor = [Drawing.Color]::FromArgb(183, 197, 206); $sidebar.BorderStyle = [Windows.Forms.BorderStyle]::FixedSingle; [void]$shell.Controls.Add($sidebar)
  $sideIcon = New-Object Windows.Forms.PictureBox; $sideIcon.Location = New-Object Drawing.Point(15, 13); $sideIcon.Size = New-Object Drawing.Size(34, 34); $sideIcon.SizeMode = [Windows.Forms.PictureBoxSizeMode]::Zoom
  if (Test-Path -LiteralPath (Join-Path $script:Root 'assets\icon\icon-32.png')) { $sideIcon.Image = [Drawing.Image]::FromFile((Join-Path $script:Root 'assets\icon\icon-32.png')) }; [void]$sidebar.Controls.Add($sideIcon)
  $brand = New-UiLabel 'CaseGraph' 58 11 110 22 10; $brand.Font = New-Object Drawing.Font('Microsoft JhengHei UI', 10, [Drawing.FontStyle]::Bold); $brand.ForeColor = [Drawing.Color]::FromArgb(24, 39, 51); [void]$sidebar.Controls.Add($brand)
  $brandSub = New-UiLabel '案件圖譜控制台' 58 33 110 15 7; $brandSub.ForeColor = [Drawing.Color]::FromArgb(97, 116, 129); [void]$sidebar.Controls.Add($brandSub)
  $line = New-Object Windows.Forms.Label; $line.Location = New-Object Drawing.Point(10, 59); $line.Size = New-Object Drawing.Size(162, 1); $line.BackColor = [Drawing.Color]::FromArgb(214, 224, 230); [void]$sidebar.Controls.Add($line)
  $serviceLabel = New-UiLabel '服務' 18 73 120 14 7; $serviceLabel.ForeColor = [Drawing.Color]::FromArgb(120, 144, 157); [void]$sidebar.Controls.Add($serviceLabel)
  $primary = New-NavButton $sidebar (([char]0x25B6).ToString() + '  重啟服務') 91 'primary'
  $stop = New-NavButton $sidebar (([char]0x25A0).ToString() + '  停止服務') 124 'stop'
  $openWeb = New-NavButton $sidebar (([char]0x2197).ToString() + '  開啟網頁') 157
  $toolLabel = New-UiLabel '工具' 18 196 120 14 7; $toolLabel.ForeColor = [Drawing.Color]::FromArgb(120, 144, 157); [void]$sidebar.Controls.Add($toolLabel)
  $claude = New-NavButton $sidebar (([char]0x2318).ToString() + '  開啟 Claude CLI') 214
  $codex = New-NavButton $sidebar (([char]0x2318).ToString() + '  開啟 codex CLI') 247
  $openLog = New-NavButton $sidebar (([char]0x2261).ToString() + '  開啟紀錄') 280
  $footerLine = New-Object Windows.Forms.Label; $footerLine.Location = New-Object Drawing.Point(10, 319); $footerLine.Size = New-Object Drawing.Size(162, 1); $footerLine.BackColor = [Drawing.Color]::FromArgb(214, 224, 230); [void]$sidebar.Controls.Add($footerLine)
  $startMenu = New-NavButton $sidebar (([char]0x229E).ToString() + '  加入開始功能表') 329
  $workspace = New-Object Windows.Forms.Panel; $workspace.Location = New-Object Drawing.Point(182, 0); $workspace.Size = New-Object Drawing.Size(458, 363); $workspace.BackColor = [Drawing.Color]::White; [void]$shell.Controls.Add($workspace)
  $overline = New-UiLabel 'CASEGRAPH SERVICE / LOCALHOST' 17 15 260 14 7; $overline.ForeColor = [Drawing.Color]::FromArgb(97, 116, 129); [void]$workspace.Controls.Add($overline)
  $status = New-UiLabel '已停止' 17 29 300 30 16; $status.Font = New-Object Drawing.Font('Microsoft JhengHei UI', 16, [Drawing.FontStyle]::Bold); [void]$workspace.Controls.Add($status)
  $detail = New-UiLabel '' 17 58 330 17 8; $detail.ForeColor = [Drawing.Color]::FromArgb(97, 116, 129); [void]$workspace.Controls.Add($detail)
  $headLine = New-Object Windows.Forms.Label; $headLine.Location = New-Object Drawing.Point(17, 87); $headLine.Size = New-Object Drawing.Size(423, 1); $headLine.BackColor = [Drawing.Color]::FromArgb(214, 224, 230); [void]$workspace.Controls.Add($headLine)
  $badge = New-Object Windows.Forms.Panel; $badge.Location = New-Object Drawing.Point(339, 16); $badge.Size = New-Object Drawing.Size(100, 30); $badge.ForeColor = [Drawing.Color]::FromArgb(167, 214, 187); $badge.BackColor = [Drawing.Color]::FromArgb(240, 243, 245); [void]$workspace.Controls.Add($badge)
  $dotPanel = New-Object Windows.Forms.Panel; $dotPanel.Location = New-Object Drawing.Point(8, 11); $dotPanel.Size = New-Object Drawing.Size(9, 9); $dotPanel.BackColor = [Drawing.Color]::FromArgb(154, 170, 180); [void]$badge.Controls.Add($dotPanel)
  $source = New-UiLabel '待機' 23 7 74 16 7; $source.AutoEllipsis = $false; $source.TextAlign = [Drawing.ContentAlignment]::MiddleLeft; $source.ForeColor = [Drawing.Color]::FromArgb(103, 122, 133); [void]$badge.Controls.Add($source)
  Add-Fact $workspace 'url' '服務 URL' 17 98 172; Add-Fact $workspace 'port' '埠' 195 98 119; Add-Fact $workspace 'uptime' '執行時間' 320 98 119
  Add-Fact $workspace 'db' '資料庫路徑' 17 143 172; Add-Fact $workspace 'node' 'Node.js' 195 143 119; Add-Fact $workspace 'sourceFact' '檢查來源' 320 143 119
  $install = New-Object Windows.Forms.Panel; $install.Location = New-Object Drawing.Point(17, 188); $install.Size = New-Object Drawing.Size(423, 39); $install.BackColor = [Drawing.Color]::FromArgb(251, 244, 222); $install.BorderStyle = [Windows.Forms.BorderStyle]::FixedSingle; $install.Visible = $false; [void]$workspace.Controls.Add($install)
  $installLabel = New-UiLabel '首次啟動：正在安裝套件' 10 6 220 16 8; $installLabel.ForeColor = [Drawing.Color]::FromArgb(128, 97, 21); [void]$install.Controls.Add($installLabel)
  $installPercent = New-UiLabel 'npm ci · 執行中' 280 6 130 16 7; $installPercent.TextAlign = [Drawing.ContentAlignment]::MiddleRight; $installPercent.ForeColor = [Drawing.Color]::FromArgb(128, 97, 21); [void]$install.Controls.Add($installPercent)
  $progressBack = New-Object Windows.Forms.Panel; $progressBack.Location = New-Object Drawing.Point(10, 27); $progressBack.Size = New-Object Drawing.Size(401, 5); $progressBack.BackColor = [Drawing.Color]::FromArgb(234, 217, 164); [void]$install.Controls.Add($progressBack)
  $progress = New-Object Windows.Forms.Panel; $progress.Location = New-Object Drawing.Point(0, 0); $progress.Size = New-Object Drawing.Size(232, 5); $progress.BackColor = [Drawing.Color]::FromArgb(180, 134, 30); [void]$progressBack.Controls.Add($progress)
  $logPanel = New-Object Windows.Forms.Panel; $logPanel.Location = New-Object Drawing.Point(17, 302); $logPanel.Size = New-Object Drawing.Size(423, 31); $logPanel.ForeColor = [Drawing.Color]::FromArgb(183, 197, 206); $logPanel.BackColor = [Drawing.Color]::FromArgb(248, 250, 251); $logPanel.BorderStyle = [Windows.Forms.BorderStyle]::FixedSingle; [void]$workspace.Controls.Add($logPanel)
  $chevron = New-UiLabel '›' 9 6 14 18 10; $chevron.ForeColor = [Drawing.Color]::FromArgb(47, 111, 159); [void]$logPanel.Controls.Add($chevron)
  $logTitle = New-UiLabel '服務紀錄' 26 7 100 16 8; $logTitle.Font = New-Object Drawing.Font('Microsoft JhengHei UI', 8, [Drawing.FontStyle]::Bold); $logTitle.ForeColor = [Drawing.Color]::FromArgb(24, 39, 51); [void]$logPanel.Controls.Add($logTitle)
  $summary = New-UiLabel '' 150 7 263 16 7; $summary.TextAlign = [Drawing.ContentAlignment]::MiddleRight; $summary.ForeColor = [Drawing.Color]::FromArgb(97, 116, 129); [void]$logPanel.Controls.Add($summary)
  $logBody = New-Object Windows.Forms.TextBox; $logBody.Location = New-Object Drawing.Point(9, 31); $logBody.Size = New-Object Drawing.Size(405, 85); $logBody.Multiline = $true; $logBody.ReadOnly = $true; $logBody.WordWrap = $false; $logBody.ScrollBars = [Windows.Forms.ScrollBars]::Vertical; $logBody.BorderStyle = [Windows.Forms.BorderStyle]::None; $logBody.BackColor = [Drawing.Color]::FromArgb(251, 252, 253); $logBody.ForeColor = [Drawing.Color]::FromArgb(149, 61, 69); $logBody.Font = New-Object Drawing.Font('Consolas', 8); $logBody.Visible = $false; [void]$logPanel.Controls.Add($logBody)
  $footerText = New-UiLabel '關閉視窗會隱藏至系統匣 · 結束會停止服務' 17 340 310 15 7; $footerText.ForeColor = [Drawing.Color]::FromArgb(124, 143, 155); [void]$workspace.Controls.Add($footerText)
  $versionText = New-UiLabel 'v0.1 launcher' 345 340 95 15 7; $versionText.TextAlign = [Drawing.ContentAlignment]::MiddleRight; $versionText.ForeColor = [Drawing.Color]::FromArgb(124, 143, 155); [void]$workspace.Controls.Add($versionText)
  $tray = New-Object Windows.Forms.Panel; $tray.Location = New-Object Drawing.Point(0, 395); $tray.Size = New-Object Drawing.Size(640, 25); $tray.BackColor = [Drawing.Color]::FromArgb(229, 237, 242); $tray.BorderStyle = [Windows.Forms.BorderStyle]::FixedSingle; [void]$form.Controls.Add($tray)
  $trayIcon = New-Object Windows.Forms.PictureBox; $trayIcon.Location = New-Object Drawing.Point(10, 5); $trayIcon.Size = New-Object Drawing.Size(15, 15); $trayIcon.SizeMode = [Windows.Forms.PictureBoxSizeMode]::Zoom; if (Test-Path -LiteralPath (Join-Path $script:Root 'assets\icon\icon-16.png')) { $trayIcon.Image = [Drawing.Image]::FromFile((Join-Path $script:Root 'assets\icon\icon-16.png')) }; [void]$tray.Controls.Add($trayIcon)
  $trayText = New-UiLabel 'CaseGraph 服務' 30 4 140 16 7; $trayText.ForeColor = [Drawing.Color]::FromArgb(113, 133, 144); [void]$tray.Controls.Add($trayText)
  $trayClock = New-UiLabel (Get-Date -Format 'HH:mm') 575 4 55 16 7; $trayClock.TextAlign = [Drawing.ContentAlignment]::MiddleRight; $trayClock.ForeColor = [Drawing.Color]::FromArgb(113, 133, 144); [void]$tray.Controls.Add($trayClock)
  $factUi = @{}
  foreach ($factName in @('url', 'port', 'uptime', 'db', 'node', 'sourceFact')) { $factUi[$factName] = $script:Ui[$factName] }
  $script:Ui = @{form=$form; titleBar=$titleBar; status=$status; detail=$detail; badge=$badge; dot=$dotPanel; dotPanel=$dotPanel; source=$source; primary=$primary; stop=$stop; openWeb=$openWeb; claude=$claude; codex=$codex; openLog=$openLog; startMenu=$startMenu; install=$install; installPercent=$installPercent; logPanel=$logPanel; logBody=$logBody; chevron=$chevron; summary=$summary; trayText=$trayText; trayClock=$trayClock}
  foreach ($factName in $factUi.Keys) { $script:Ui[$factName] = $factUi[$factName] }
  Set-FactValue 'sourceFact' '健康端點'
  $script:Tooltip = New-Object Windows.Forms.ToolTip
  $script:Tooltip.AutoPopDelay = 5000; $script:Tooltip.InitialDelay = 300; $script:Tooltip.ReshowDelay = 100
  $script:Ui.claude.Enabled = $null -ne (Find-CommandPath 'claude'); $script:Ui.codex.Enabled = $null -ne (Find-CommandPath 'codex')
  if (-not $script:Ui.claude.Enabled) { $script:Tooltip.SetToolTip($script:Ui.claude, '找不到 claude 指令') }
  if (-not $script:Ui.codex.Enabled) { $script:Tooltip.SetToolTip($script:Ui.codex, '找不到 codex 指令') }
  Set-VisualState $InitialState $null $null
  $drag = @{Active=$false; Offset=New-Object Drawing.Point(0, 0)}
  $titleBar.Add_MouseDown({ if ($_.Button -eq [Windows.Forms.MouseButtons]::Left) { $drag.Active = $true; $drag.Offset = New-Object Drawing.Point($_.X, $_.Y) } })
  $titleBar.Add_MouseMove({ if ($drag.Active) { $point = $form.PointToScreen((New-Object Drawing.Point($_.X, $_.Y))); $form.Location = New-Object Drawing.Point(($point.X - $drag.Offset.X), ($point.Y - $drag.Offset.Y)) } })
  $titleBar.Add_MouseUp({ $drag.Active = $false })
  $titleLabel.Add_MouseDown({ if ($_.Button -eq [Windows.Forms.MouseButtons]::Left) { $drag.Active = $true; $drag.Offset = New-Object Drawing.Point($_.X + 36, $_.Y + 7) } })
  $titleLabel.Add_MouseMove({ if ($drag.Active) { $point = $form.PointToScreen((New-Object Drawing.Point($_.X + 36, $_.Y + 7))); $form.Location = New-Object Drawing.Point(($point.X - $drag.Offset.X), ($point.Y - $drag.Offset.Y)) } })
  $titleLabel.Add_MouseUp({ $drag.Active = $false })
  $closeButton.Add_Click({ Hide-ToTray })
  $minButton.Add_Click({ Hide-ToTray })
  $primary.Add_Click({ Invoke-PrimaryAction })
  $stop.Add_Click({ Invoke-StopAction })
  $openWeb.Add_Click({ Open-WebPage })
  $claude.Add_Click({ Open-Client 'claude' })
  $codex.Add_Click({ Open-Client 'codex' })
  $openLog.Add_Click({ Open-Log })
  $startMenu.Add_Click({ Toggle-StartMenuShortcut })
  $logPanel.Add_Click({ Toggle-Log }); $chevron.Add_Click({ Toggle-Log }); $logTitle.Add_Click({ Toggle-Log }); $summary.Add_Click({ Toggle-Log })
  if (-not $ScreenshotMode) {
    $form.Add_FormClosing({ param($sender, $eventArgs) if (-not $script:Exiting) { $eventArgs.Cancel = $true; Hide-ToTray } })
    $form.Add_Shown({ $form.Activate() })
  }
  return $form
}

function Update-TrayText {
  if ($script:Ui.ContainsKey('trayText')) { $script:Ui.trayText.Text = 'CaseGraph 服務'; $script:Ui.trayClock.Text = Get-Date -Format 'HH:mm' }
}

function Restore-LauncherWindow {
  if ($null -eq $script:UiForm) { return }
  $script:UiForm.Show(); $script:UiForm.WindowState = [Windows.Forms.FormWindowState]::Normal; [void][CaseGraphNativeMethods]::SetForegroundWindow($script:UiForm.Handle)
}

function Hide-ToTray {
  if ($null -eq $script:UiForm) { return }
  $script:UiForm.Hide()
  if ($script:NotifyIcon -and -not $script:FirstTrayNotice) { $script:FirstTrayNotice = $true; $script:NotifyIcon.ShowBalloonTip(3000, 'CaseGraph', '啟動器已縮到系統匣。右鍵圖示可顯示視窗或結束服務。', [Windows.Forms.ToolTipIcon]::Info) }
}

function Start-HealthProbe {
  if ($script:ProbeBusy) { return }
  $worker = New-Object ComponentModel.BackgroundWorker
  $script:ProbeWorker = $worker; $script:ProbeBusy = $true; $port = $script:Port
  $worker.add_DoWork({ param($sender, $eventArgs) $eventArgs.Result = Get-HealthSnapshot ([int]$eventArgs.Argument) })
  $worker.add_RunWorkerCompleted({ param($sender, $eventArgs) $script:ProbeBusy = $false; if ($null -eq $eventArgs.Error) { $script:ProbeResult = $eventArgs.Result }; $sender.Dispose() })
  $worker.RunWorkerAsync($port)
}

function Set-FastPolling([bool]$OpenWhenReady) {
  $script:FastPollUntil = (Get-Date).AddSeconds(30); $script:NextProbeAt = [DateTime]::MinValue; $script:OpenOnReady = $OpenWhenReady
}

function Apply-ProbeResult([object]$Probe) {
  if ($null -eq $Probe) { return }
  if ($Probe.Kind -eq 'healthy') {
    $script:LastHealth = $Probe.Health
    $own = $script:StartedPid -gt 0 -and [int]$Probe.Health.pid -eq $script:StartedPid -and $script:StartedProcess -and -not $script:StartedProcess.HasExited
    $state = if ($own) { 'running' } else { 'external' }
    Set-VisualState $state $Probe.Health $null
    $script:FastPollUntil = [DateTime]::MinValue
    if ($script:OpenOnReady) { $script:OpenOnReady = $false; Start-Process ('http://127.0.0.1:{0}/' -f $Probe.Health.port) | Out-Null }
    return
  }
  if ($Probe.Kind -eq 'foreign') { Set-VisualState 'port' $null '埠有回應，但回報的應用程式不是 CaseGraph。'; return }
  if ($script:StartedProcess -and -not $script:StartedProcess.HasExited) {
    Set-VisualState 'starting' $null $null
    if ((Get-Date) -gt $script:FastPollUntil) { Set-VisualState 'error' $null '服務未能在 30 秒內回應，請查看展開的紀錄。' }
  } elseif ($script:UiState -eq 'starting') { Set-VisualState 'stopped' $null $null }
}

function Update-ProcessExit {
  if ($script:StartedProcess -and $script:StartedProcess.HasExited -and ($script:UiState -eq 'starting' -or $script:UiState -eq 'running')) {
    $exitCode = $script:StartedProcess.ExitCode
    try { $script:StartedProcess.Close() } catch {}
    $script:StartedProcess = $null; $script:StartedPid = 0
    if ($exitCode -ne 0) { Set-VisualState 'error' $null '服務程序已結束，請查看展開的紀錄。' }
    else { Set-VisualState 'stopped' $null $null }
  }
}

function Invoke-PrimaryAction {
  if ($script:UiState -eq 'running' -or $script:UiState -eq 'external') { Restart-UiService } else { Start-UiService }
}

function Confirm-External([string]$Action) {
  $choice = [Windows.Forms.MessageBox]::Show($script:UiForm, ('目前服務是由其他程序啟動。要{0}它嗎？' -f $Action), 'CaseGraph', [Windows.Forms.MessageBoxButtons]::YesNo, [Windows.Forms.MessageBoxIcon]::Warning)
  return $choice -eq [Windows.Forms.DialogResult]::Yes
}

function Start-UiService {
  Resolve-Config
  if (-not (Test-NodeVersion)) { Set-VisualState 'error' $null ('找不到 Node.js 24 以上。請從 https://nodejs.org/ 下載。'); return }
  if (-not (Test-Path -LiteralPath (Join-Path $script:Root 'node_modules') -PathType Container)) { Start-Install; return }
  $probe = Get-HealthSnapshot $script:Port
  if ($probe.Kind -eq 'healthy') { Set-VisualState 'external' $probe.Health $null; $script:LastHealth = $probe.Health; return }
  if ($probe.Kind -eq 'foreign') { Set-VisualState 'port' $null $probe.Error; return }
  try { [void](Start-WallProcess); Set-VisualState 'starting' $null $null; Set-FastPolling $true } catch { Write-LauncherLog $_.Exception.Message; Set-VisualState 'error' $null $_.Exception.Message }
}

function Restart-UiService {
  $probe = Get-HealthSnapshot $script:Port
  if ($probe.Kind -eq 'foreign') { Set-VisualState 'port' $null $probe.Error; return }
  if ($probe.Kind -eq 'healthy' -and ([int]$probe.Health.pid -ne $script:StartedPid)) {
    if (-not (Confirm-External '停止並重新啟動')) { return }
    Stop-VerifiedExternalService $probe.Health
  } elseif ($script:StartedPid -gt 0) { Stop-OwnService }
  Start-UiService
}

function Invoke-StopAction {
  $probe = Get-HealthSnapshot $script:Port
  if ($probe.Kind -eq 'healthy') {
    if ([int]$probe.Health.pid -eq $script:StartedPid -and $script:StartedProcess) { Stop-OwnService }
    elseif (Confirm-External '停止') { Stop-VerifiedExternalService $probe.Health }
    else { return }
  } else { Stop-OwnService }
  Set-VisualState 'stopped' $null $null
}

function Start-Install {
  Set-VisualState 'installing' $null $null
  Rotate-ServerLog; Write-LauncherLog 'npm ci installing packages'
  $info = New-Object Diagnostics.ProcessStartInfo; $info.FileName = $env:ComSpec; $info.Arguments = ('/d /c "npm ci >> "{0}" 2>&1"' -f $script:ServerLog); $info.WorkingDirectory = $script:Root; $info.UseShellExecute = $false; $info.CreateNoWindow = $true
  $installProcess = New-Object Diagnostics.Process; $installProcess.StartInfo = $info; [void]$installProcess.Start()
  $script:InstallProcess = $installProcess
}

function Update-Install {
  if ($script:InstallProcess -and $script:InstallProcess.HasExited) {
    if ($script:InstallProcess.ExitCode -eq 0) { $script:InstallProcess = $null; Start-UiService }
    else { $script:InstallProcess = $null; Set-VisualState 'error' $null '套件安裝失敗，請查看展開的紀錄。' }
  }
}

function Open-WebPage {
  $port = if ($script:LastHealth) { $script:LastHealth.port } else { $script:Port }
  Start-Process ('http://127.0.0.1:{0}/' -f $port) | Out-Null
}

function Escape-PowerShellLiteral([string]$Value) { return "'" + ($Value -replace "'", "''") + "'" }

function Get-ClientPath([string]$Client) {
  $variable = if ($Client -eq 'claude') { 'WALL_CLAUDE_BIN' } else { 'WALL_CODEX_BIN' }
  $override = [Environment]::GetEnvironmentVariable($variable, 'Process')
  if ($override) { return $override }
  return $Client
}

function New-ClientCommand([string]$Client, [object]$Health) {
  $root = Escape-PowerShellLiteral $script:Root
  $command = Escape-PowerShellLiteral (Get-ClientPath $Client)
  if ($Client -eq 'claude') {
    $config = Escape-PowerShellLiteral (New-McpConfig $Health)
    return ('Set-Location -LiteralPath {0}; & {1} --mcp-config {2}' -f $root, $command, $config)
  }
  $node = ConvertTo-Json ([string]$script:NodePath) -Compress
  $mcp = ConvertTo-Json (Join-Path $script:Root 'server\mcp.js') -Compress
  $db = ConvertTo-Json ([string]$Health.db) -Compress
  $port = ConvertTo-Json ([string]$Health.port) -Compress
  $envTable = '{WALL_DB=' + $db + ',WALL_PORT=' + $port + '}'
  $args = @('--disable', 'shell_tool', '--ignore-user-config', '--skip-git-repo-check', '-c', ('mcp_servers.detective-wall.command=' + $node), '-c', ('mcp_servers.detective-wall.args=[' + $mcp + ']'), '-c', ('mcp_servers.detective-wall.env=' + $envTable))
  $parts = @('Set-Location -LiteralPath ' + $root + '; & ' + $command)
  foreach ($arg in $args) { $parts += (Escape-PowerShellLiteral $arg) }
  return ($parts -join ' ')
}

function Start-TerminalCommand([string]$Title, [string]$CommandText) {
  $arguments = @('-NoProfile', '-NoExit', '-Command', $CommandText)
  $wt = Find-CommandPath 'wt.exe'
  if ($wt) { Start-Process -FilePath $wt -ArgumentList (@('new-tab', '--title', $Title, '-d', $script:Root, 'powershell.exe') + $arguments) | Out-Null }
  else { Start-Process -FilePath (Find-CommandPath 'powershell.exe') -WorkingDirectory $script:Root -ArgumentList $arguments | Out-Null }
}

function Ensure-ServiceForClient {
  $probe = Get-HealthSnapshot $script:Port
  if ($probe.Kind -eq 'healthy') { $script:LastHealth = $probe.Health; return $true }
  if ($probe.Kind -eq 'foreign') { Set-VisualState 'port' $null $probe.Error; return $false }
  $choice = [Windows.Forms.MessageBox]::Show($script:UiForm, '服務尚未執行，要先啟動服務嗎？', 'CaseGraph', [Windows.Forms.MessageBoxButtons]::YesNo, [Windows.Forms.MessageBoxIcon]::Question)
  if ($choice -eq [Windows.Forms.DialogResult]::Yes) { Start-UiService }
  return $false
}

function Open-Client([string]$Client) {
  if (-not (Ensure-ServiceForClient)) { return }
  $health = $script:LastHealth
  if ($null -eq $health) { return }
  Start-TerminalCommand ('CaseGraph ' + $Client) (New-ClientCommand $Client $health)
}

function Get-ShortcutPath { return (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\CaseGraph 案件圖譜.lnk') }

function Toggle-StartMenuShortcut {
  $shortcut = Get-ShortcutPath
  if (Test-Path -LiteralPath $shortcut -PathType Leaf) { Remove-Item -LiteralPath $shortcut -Force; Set-VisualState $script:UiState $script:LastHealth '已從開始功能表移除。'; return }
  $folder = Split-Path -Parent $shortcut; Ensure-Directory $folder
  $shell = New-Object -ComObject WScript.Shell; $link = $shell.CreateShortcut($shortcut)
  $link.TargetPath = (Find-CommandPath 'powershell.exe'); $link.Arguments = ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -STA -File "{0}"' -f $PSCommandPath); $link.WorkingDirectory = $script:Root; $link.IconLocation = $script:IconPath + ',0'; $link.Description = 'CaseGraph 案件圖譜啟動器'; $link.Save()
  Set-VisualState $script:UiState $script:LastHealth '已加入開始功能表。'
}

function Open-Log { Ensure-Directory $script:RuntimeDir; if (-not (Test-Path -LiteralPath $script:ServerLog)) { Write-LauncherLog 'launcher log opened' }; Start-Process notepad.exe -ArgumentList @($script:ServerLog) | Out-Null }

function New-NotifyIcon {
  $menu = New-Object Windows.Forms.ContextMenuStrip
  $show = $menu.Items.Add('顯示視窗'); $restart = $menu.Items.Add('重啟服務'); $stop = $menu.Items.Add('停止服務'); $web = $menu.Items.Add('開啟網頁'); $claude = $menu.Items.Add('開啟 Claude CLI'); $codex = $menu.Items.Add('開啟 codex CLI'); $log = $menu.Items.Add('開啟紀錄'); $shortcut = $menu.Items.Add('加入開始功能表'); [void]$menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator)); $exit = $menu.Items.Add('結束')
  $show.Add_Click({ Restore-LauncherWindow }); $restart.Add_Click({ Restart-UiService }); $stop.Add_Click({ Invoke-StopAction }); $web.Add_Click({ Open-WebPage }); $claude.Add_Click({ Open-Client 'claude' }); $codex.Add_Click({ Open-Client 'codex' }); $log.Add_Click({ Open-Log }); $shortcut.Add_Click({ Toggle-StartMenuShortcut }); $exit.Add_Click({ Exit-Launcher })
  $notify = New-Object Windows.Forms.NotifyIcon; $notify.Text = 'CaseGraph 服務'; if (Test-Path -LiteralPath $script:IconPath) { $notify.Icon = New-Object Drawing.Icon($script:IconPath) }; $notify.ContextMenuStrip = $menu; $notify.Visible = $true; $notify.Add_DoubleClick({ Restore-LauncherWindow }); return $notify
}

function Exit-Launcher {
  if ($script:Exiting) { return }; $script:Exiting = $true
  if ($script:InstallProcess -and -not $script:InstallProcess.HasExited) { Stop-ProcessTree $script:InstallProcess.Id; try { $script:InstallProcess.Close() } catch {} }
  if ($script:StartedProcess -and -not $script:StartedProcess.HasExited) { Stop-OwnService }
  if ($script:UiTimer) { $script:UiTimer.Stop() }; if ($script:NotifyIcon) { $script:NotifyIcon.Visible = $false; $script:NotifyIcon.Dispose() }
  if ($script:ShowEvent) { $script:ShowEvent.Dispose() }; if ($script:Mutex) { $script:Mutex.ReleaseMutex(); $script:Mutex.Dispose() }
  [Windows.Forms.Application]::ExitThread()
}

function Acquire-SingleInstance {
  $created = $false
  $script:Mutex = New-Object Threading.Mutex($false, 'Local\CaseGraph-Launcher', [ref]$created)
  if ($created) { $script:ShowEvent = New-Object Threading.EventWaitHandle($false, [Threading.EventResetMode]::AutoReset, 'Local\CaseGraph-Launcher-Show'); return $true }
  try { $event = [Threading.EventWaitHandle]::OpenExisting('Local\CaseGraph-Launcher-Show'); $event.Set(); $event.Dispose() } catch {}
  $script:Mutex.Dispose(); $script:Mutex = $null; return $false
}

function Invoke-Screenshot([string]$OutputDirectory) {
  Ensure-Directory $OutputDirectory
  [Windows.Forms.Application]::EnableVisualStyles(); [Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false)
  Resolve-Config
  $script:DbPath = 'data/wall.db'
  $states = @('running', 'stopped', 'error', 'installing')
  foreach ($state in $states) {
    $form = New-LauncherForm $state -ScreenshotMode
    if ($state -eq 'running') { $health = [pscustomobject]@{db='data/wall.db'; port=3000; startedAt=(Get-Date).AddSeconds(-(2 * 3600 + 14 * 60 + 39)).ToString('o')}; Set-VisualState 'running' $health $null }
    if ($state -eq 'error') { $script:Ui.logBody.Text = "[16:42:18] ERROR listen EADDRINUSE: address already in use`r`n[16:42:18] server stopped before ready`r`n[16:42:17] start requested by launcher" }
    if ($state -eq 'stopped') { $script:Ui.logBody.Text = "[16:39:51] service stopped by user`r`n[16:39:51] launcher remains in tray" }
    if ($state -eq 'installing') { $script:Ui.logBody.Text = "[16:42:20] checking Node.js >= 24…`r`n[16:42:21] Node.js v24.11.1 found`r`n[16:42:22] npm ci installing packages…" }
    $script:Ui.logBody.SelectionStart = 0; $script:Ui.logBody.SelectionLength = 0
    if ($state -eq 'installing') { $script:Ui.installPercent.Text = 'npm ci · 58%' }
    $form.Show(); $form.Refresh(); [Windows.Forms.Application]::DoEvents(); $script:Ui.logBody.SelectionStart = 0; $script:Ui.logBody.SelectionLength = 0; [void]$form.Focus(); Start-Sleep -Milliseconds 100
    $bitmap = New-Object Drawing.Bitmap -ArgumentList @($form.ClientSize.Width, $form.ClientSize.Height); $rectangle = New-Object Drawing.Rectangle -ArgumentList @(0, 0, $form.ClientSize.Width, $form.ClientSize.Height); $form.DrawToBitmap($bitmap, $rectangle); $bitmap.Save((Join-Path $OutputDirectory ('mock-2-' + $state + '.png')), [Drawing.Imaging.ImageFormat]::Png); $bitmap.Dispose(); $form.Close(); $form.Dispose()
  }
}

function Start-Launcher {
  if (-not (Acquire-SingleInstance)) { return }
  [Windows.Forms.Application]::EnableVisualStyles(); [Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false)
  Ensure-Directory $script:RuntimeDir; Resolve-Config
  if (-not (Test-NodeVersion)) { $initial = 'error' } elseif (-not (Test-Path -LiteralPath (Join-Path $script:Root 'node_modules') -PathType Container)) { $initial = 'installing' } else { $initial = 'stopped' }
  $script:UiForm = New-LauncherForm $initial
  $script:NotifyIcon = New-NotifyIcon
  $script:UiTimer = New-Object Windows.Forms.Timer; $script:UiTimer.Interval = 250
  $script:UiTimer.Add_Tick({
    if ($script:ShowEvent -and $script:ShowEvent.WaitOne(0)) { Restore-LauncherWindow }
    Update-Install; Update-ProcessExit
    $interval = if ((Get-Date) -lt $script:FastPollUntil) { 500 } elseif ($script:UiForm.Visible) { 3000 } else { 10000 }
    if ((Get-Date) -ge $script:NextProbeAt -and -not $script:ProbeBusy) { $script:NextProbeAt = (Get-Date).AddMilliseconds($interval); Start-HealthProbe }
    if ($script:ProbeResult) { $result = $script:ProbeResult; $script:ProbeResult = $null; Apply-ProbeResult $result }
  })
  $script:UiTimer.Start(); $script:UiForm.Show(); Set-FastPolling $false; [Windows.Forms.Application]::DoEvents()
  if ($initial -eq 'installing') { Start-Install } elseif ($initial -eq 'stopped') { Start-UiService } else { Set-VisualState 'error' $null '找不到 Node.js 24 以上。請從 https://nodejs.org/ 下載。' }
  [Windows.Forms.Application]::Run()
}

try {
  if ($SelfTest) { Invoke-SelfTest; exit 0 }
  if ($Screenshot) { Invoke-Screenshot $Screenshot; exit 0 }
  Start-Launcher
} catch {
  Write-Error $_
  if ($SelfTest) { exit 1 }
}
