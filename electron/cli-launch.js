'use strict';

// Opens Claude/codex in a new terminal window wired to the running service, replacing the old launcher's buttons.
const fs = require('node:fs');
const path = require('node:path');
const {cliCommand, cliPath, mcpConfig, mcpTomlArgs, resolveCli} = require('../server/server.js');

const psLiteral = value => `'${String(value).replaceAll("'", "''")}'`;
// powershell.exe (5.1) mangles native arguments that contain double quotes (codex's TOML values), so the script
// stops PowerShell parsing with --% and hands over a command line quoted for the Windows parser.
// ponytail: --% still expands %NAME% for existing environment variables; a path containing such text would change.
const windowsArg = value => /[\s"]/.test(value) || value === ''
  ? `"${String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
  : String(value);

function terminal(scriptPath, cwd, title) {
  const powershellArgs = ['-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];
  const windowsTerminal = resolveCli('wt.exe');
  if (windowsTerminal) return {file: windowsTerminal, args: ['new-tab', '--title', title, '-d', cwd, 'powershell.exe', ...powershellArgs]};
  const powershell = resolveCli('powershell.exe');
  return powershell ? {file: powershell, args: powershellArgs} : null;
}

// Returns {file, args, cwd, scriptPath} for a detached spawn, or {error} when the CLI or a terminal is missing.
function buildCliLaunch(client, dbPath, port, cwd, runtimeDir) {
  const command = cliPath(client);
  if (!command) return {error: `找不到 ${cliCommand(client)} 指令`};
  fs.mkdirSync(runtimeDir, {recursive: true});
  let args;
  if (client === 'claude') {
    const configPath = path.join(runtimeDir, 'claude-mcp.json');
    fs.writeFileSync(configPath, mcpConfig(dbPath, port));
    args = ['--mcp-config', configPath];
  } else {
    args = ['--disable', 'shell_tool', '--ignore-user-config', '--skip-git-repo-check', ...mcpTomlArgs(dbPath, port)];
  }
  const scriptPath = path.join(runtimeDir, `open-${client}.ps1`);
  // The BOM matters: powershell.exe 5.1 reads BOM-less scripts in the ANSI code page and garbles non-ASCII paths.
  fs.writeFileSync(scriptPath, `﻿& ${psLiteral(command)} --% ${args.map(windowsArg).join(' ')}\r\n`);
  const workingDirectory = path.resolve(cwd);
  const shell = terminal(scriptPath, workingDirectory, `CaseGraph ${client}`);
  if (!shell) return {error: '找不到可用的終端機'};
  return {...shell, cwd: workingDirectory, scriptPath};
}

module.exports = {buildCliLaunch};
