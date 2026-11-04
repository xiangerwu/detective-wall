// Smoke test of the packaged Windows app in dist/win-unpacked (build it with `npm run dist`); skipped when absent.
// It checks what only packaging can break: code inside app.asar run by the Electron-as-Node helpers, and data paths.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {_electron: electron} = require('playwright-core');
const {Client} = require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport} = require('@modelcontextprotocol/sdk/client/stdio.js');

const root = path.join(__dirname, '..');
const exe = path.join(root, 'dist', 'win-unpacked', 'CaseGraph.exe');
if (!fs.existsSync(exe)) {
  console.log('SKIP packaged app not built (npm run dist)');
  process.exit(0);
}
const resources = path.join(path.dirname(exe), 'resources');
const tempRoot = process.env.WALL_TEST_ROOT || process.env.WALL_TEST_OUT || os.tmpdir();

function request(port, pathname, method = 'GET', value) {
  return new Promise((resolve, reject) => {
    const body = value === undefined ? '' : JSON.stringify(value);
    const req = http.request({hostname: '127.0.0.1', port, path: pathname, method,
      headers: value === undefined ? {} : {'content-type': 'application/json', 'content-length': Buffer.byteLength(body)}}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({status: res.statusCode, body: text ? JSON.parse(text) : null});
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

(async () => {
  fs.mkdirSync(tempRoot, {recursive: true});
  const userData = fs.mkdtempSync(path.join(tempRoot, 'packaged-'));
  const cliLog = path.join(userData, 'fake-cli.jsonl');
  const application = await electron.launch({executablePath: exe, env: {...process.env, CASEGRAPH_USER_DATA: userData,
    WALL_PORT: '0', WALL_CLAUDE_BIN: path.join(__dirname, 'fake-chat-cli.js'), WALL_FAKE_CLI_LOG: cliLog}, timeout: 30000});
  let port;
  try {
    const page = await application.firstWindow({timeout: 30000});
    await page.locator('#wall-tabs').waitFor({state: 'attached', timeout: 30000});
    const state = await page.evaluate(() => window.caseGraph.getState());
    port = state.effectivePort;
    assert.notEqual(port, 3000);
    assert.equal((await request(port, '/api/health')).status, 200);
    assert.ok(path.resolve(state.dbPath).startsWith(path.resolve(userData)), 'the DB lives in user data');
    assert.ok(!path.resolve(state.dbPath).startsWith(resources), 'nothing writable inside the install folder');
    const runtime = await application.evaluate(() => ({node: process.versions.node, sqlite: typeof process.getBuiltinModule('node:sqlite').DatabaseSync}));
    assert.match(runtime.node, /^24\./);
    assert.equal(runtime.sqlite, 'function');
    console.log('PASS packaged app loads the wall from a user-data DB with Node 24 and DatabaseSync');

    // Opening a CLI writes the MCP config; record the terminal launch instead of opening a window.
    await application.evaluate(() => {
      const childProcess = process.getBuiltinModule('node:child_process');
      const {EventEmitter} = process.getBuiltinModule('node:events');
      childProcess.spawn = () => { const child = new EventEmitter(); child.unref = () => {}; process.nextTick(() => child.emit('spawn')); return child; };
    });
    await page.evaluate(() => window.caseGraph.openClient('claude'));
    const mcp = JSON.parse(fs.readFileSync(path.join(userData, 'CaseGraph', 'runtime', 'claude-mcp.json'), 'utf8')).mcpServers['detective-wall'];
    assert.equal(path.resolve(mcp.command), path.resolve(exe));
    assert.ok(mcp.args[0].includes('app.asar'), 'mcp.js runs from inside app.asar');
    const client = new Client({name: 'casegraph-packaged-test', version: '1.0.0'});
    await client.connect(new StdioClientTransport({command: mcp.command, args: mcp.args, env: {...process.env, ...mcp.env}, stderr: 'pipe'}));
    try {
      const listed = await client.callTool({name: 'list_boards'});
      const data = listed.structuredContent || JSON.parse(listed.content[0].text);
      assert.ok(data.boards.length > 0);
    } finally {
      await client.close();
    }
    console.log('PASS the MCP server inside app.asar answers through the packaged executable');

    const reply = await request(port, '/api/chat/w-main', 'POST', {client: 'claude', message: 'hi'});
    assert.equal(reply.status, 200);
    const record = fs.readFileSync(cliLog, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line)).at(-1);
    assert.equal(record.execArgv[0], '-r');
    assert.ok(record.execArgv[1].includes('app.asar') && record.execArgv[1].endsWith('hidden-console.js'));
    console.log('PASS in-app chat runs the CLI with the hidden-console preload from app.asar');
  } finally {
    const closed = application.waitForEvent('close', {timeout: 15000}).catch(() => {});
    try { await application.evaluate(({app}) => app.quit()); } catch {}
    await closed;
  }
  await assert.rejects(() => request(port, '/api/health'));
  console.log('PASS quitting the packaged app stops the service');
})().catch(error => { console.error('FAIL', error); process.exitCode = 1; });
