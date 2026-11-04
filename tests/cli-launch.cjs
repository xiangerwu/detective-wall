// The terminal launch must deliver every argument intact through powershell.exe 5.1 and an npm-style .cmd shim.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {buildCliLaunch} = require('../electron/cli-launch.js');
const {mcpTomlArgs} = require('../server/server.js');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'casegraph-cli-launch-'));
const dbPath = path.join(temp, "專案 folder's", 'wall.db');
const cwd = path.join(temp, "AI workdir's");
const runtimeDir = path.join(temp, "runtime folder's");
const cliLog = path.join(temp, 'cli.json');
const fakeCli = path.join(__dirname, 'fake-cli-argv.cmd');
const port = 43127;
fs.mkdirSync(cwd, {recursive: true});

const saved = new Map(['WALL_CLAUDE_BIN', 'WALL_CODEX_BIN', 'PATH'].map(key => [key, process.env[key]]));
process.env.WALL_CLAUDE_BIN = fakeCli;
process.env.WALL_CODEX_BIN = fakeCli;

// Runs the generated script the way the terminal would, minus -NoExit so it returns.
function runScript(spec) {
  fs.rmSync(cliLog, {force: true});
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', spec.scriptPath],
    {cwd: spec.cwd, env: {...process.env, CASEGRAPH_FAKE_CLI_LOG: cliLog}, windowsHide: true, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(fs.readFileSync(cliLog, 'utf8'));
}

function assertTerminal(spec) {
  assert.ok(['wt.exe', 'powershell.exe'].includes(path.basename(spec.file).toLowerCase()));
  assert.deepEqual(spec.args.slice(-6), ['-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', spec.scriptPath]);
  if (path.basename(spec.file).toLowerCase() === 'wt.exe') assert.equal(spec.args[spec.args.indexOf('-d') + 1], path.resolve(cwd));
  assert.equal(spec.cwd, path.resolve(cwd));
}

try {
  const claude = buildCliLaunch('claude', dbPath, port, cwd, runtimeDir);
  assertTerminal(claude);
  const configPath = path.join(runtimeDir, 'claude-mcp.json');
  const mcp = JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers['detective-wall'];
  assert.equal(mcp.command, process.execPath);
  assert.match(mcp.args[0], /server[\\/]mcp\.js$/);
  assert.deepEqual(mcp.env, {WALL_DB: dbPath, WALL_PORT: String(port)});
  if (process.platform === 'win32') {
    const received = runScript(claude);
    assert.deepEqual(received.argv, ['--mcp-config', configPath]);
    assert.equal(received.cwd, path.resolve(cwd));
  }
  console.log('PASS Claude opens with an all-walls MCP config file, in the AI workdir');

  const codex = buildCliLaunch('codex', dbPath, port, cwd, runtimeDir);
  assertTerminal(codex);
  if (process.platform === 'win32') {
    const received = runScript(codex);
    assert.deepEqual(received.argv, ['--disable', 'shell_tool', '--ignore-user-config', '--skip-git-repo-check', ...mcpTomlArgs(dbPath, port)]);
    assert.equal(received.cwd, path.resolve(cwd));
  }
  console.log('PASS codex receives its TOML MCP arguments intact through powershell.exe and a .cmd shim');

  process.env.WALL_CLAUDE_BIN = path.join(temp, 'missing claude.exe');
  process.env.PATH = '';
  assert.deepEqual(buildCliLaunch('claude', dbPath, port, cwd, runtimeDir), {error: '找不到 claude 指令'});
  console.log('PASS a missing CLI is reported without opening a terminal');
} finally {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(temp, {recursive: true, force: true});
}
