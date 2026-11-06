param([Parameter(Mandatory=$true)][string]$InstallDir, [switch]$Stop)
$ErrorActionPreference = 'Stop'
try {
    $targetExe = [IO.Path]::GetFullPath((Join-Path $InstallDir 'casegraph-mcp.exe'))
    $found = $false
    foreach ($mcpProcess in @(Get-Process -Name 'casegraph-mcp' -ErrorAction SilentlyContinue)) {
        try {
            if ($mcpProcess.HasExited) { continue }
            # Pin the process handle before inspecting its image and terminating it.
            # Never terminate by name or reuse a PID observed by another command.
            $null = $mcpProcess.Handle
            if (![string]::Equals($mcpProcess.MainModule.FileName, $targetExe, [StringComparison]::OrdinalIgnoreCase)) { continue }
            $found = $true
            if ($Stop) {
                $mcpProcess.Kill()
                if (!$mcpProcess.WaitForExit(5000)) { throw 'MCP did not exit within 5 seconds.' }
            }
        } catch {
            if (!$mcpProcess.HasExited) { throw }
        } finally {
            $mcpProcess.Dispose()
        }
    }
    if ($found -and !$Stop) { exit 2 }
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
