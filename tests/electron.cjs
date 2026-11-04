const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');
const {Client} = require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport} = require('@modelcontextprotocol/sdk/client/stdio.js');

const root = path.join(__dirname, '..');
const tempRoot = process.env.WALL_TEST_OUT || os.tmpdir();
const electronPath = require('electron');

function newUserData(label) {
  fs.mkdirSync(tempRoot, {recursive: true});
  return fs.mkdtempSync(path.join(tempRoot, `electron-${label}-`));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function request(port, pathname, method = 'GET', value) {
  return new Promise((resolve, reject) => {
    const body = value === undefined ? '' : JSON.stringify(value);
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: value === undefined ? {} : {'content-type': 'application/json', 'content-length': Buffer.byteLength(body)},
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let bodyValue = text;
        try { bodyValue = JSON.parse(text); } catch {}
        resolve({status: res.statusCode, body: bodyValue});
      });
    });
    req.setTimeout(3000, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

async function launch(userData, wallPort = '0') {
  return electron.launch({
    executablePath: electronPath,
    args: ['.'],
    cwd: root,
    env: {...process.env, CASEGRAPH_USER_DATA: userData, WALL_PORT: String(wallPort)},
    timeout: 30000,
  });
}

async function firstWindow(application) {
  const page = await application.firstWindow({timeout: 30000});
  page.setDefaultTimeout(30000);
  return page;
}

async function waitForWall(page) {
  await page.locator('#wall-tabs').waitFor({state: 'attached', timeout: 30000});
  await page.waitForFunction(() => document.querySelector('#wall-tabs') !== null);
}

async function getState(page) {
  return page.evaluate(() => window.caseGraph.getState());
}

async function waitForExit(child, timeout = 10000) {
  if (child.exitCode !== null) return {code: child.exitCode, signal: child.signalCode};
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Electron process did not exit')), timeout);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({code, signal});
    });
  });
}

async function closeApp(application) {
  // process() throws once Playwright has disposed an application that already closed.
  try { if (!application || application.process().exitCode !== null) return; } catch { return; }
  const closed = application.waitForEvent('close', {timeout: 15000}).catch(() => {});
  try { await application.evaluate(({app}) => app.quit()); } catch {}
  await closed;
}

async function putWall(port) {
  const response = await request(port, '/api/walls/electron-test', 'PUT', {
    id: 'electron-test', name: 'Electron test wall', version: null,
    data: {bands: [], tags: [], cards: [], edges: []},
  });
  assert.equal(response.status, 200);
}

async function testLifecycleAndRuntime() {
  const userData = newUserData('lifecycle');
  const settingsPath = path.join(userData, 'CaseGraph', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), {recursive: true});
  fs.writeFileSync(settingsPath, '{bad json');
  const application = await launch(userData);
  let page;
  try {
    page = await firstWindow(application);
    await waitForWall(page);
    // The window title follows the page, which leads with the current wall's name.
    assert.match(await page.title(), /CaseGraph 案件圖譜$/);
    const value = await getState(page);
    assert.equal(value.settingsNeedsRepair, true);
    assert.match(value.dbPath, /CaseGraph[\\/]projects[\\/]default[\\/]wall\.db$/);
    assert.equal(path.resolve(value.activeProjectFolder), path.resolve(path.dirname(value.dbPath)));
    assert.notEqual(value.effectivePort, 0);
    const health = await request(value.effectivePort, '/api/health');
    assert.equal(health.status, 200);
    assert.equal(path.resolve(health.body.db), path.resolve(value.dbPath));
    assert.equal(health.body.port, value.effectivePort);

    // Playwright evaluates in the main process without `require`; Node 24 exposes built-ins this way.
    const runtime = await application.evaluate(() => {
      const {DatabaseSync} = process.getBuiltinModule('node:sqlite');
      return {node: process.versions.node, sqlite: typeof DatabaseSync === 'function'};
    });
    assert.match(runtime.node, /^24\./);
    assert.equal(runtime.sqlite, true);
    console.log('PASS Electron loads the wall, uses a temp project DB, and exposes Node 24 with DatabaseSync');

    await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].close());
    await sleep(150);
    assert.equal(await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].isVisible()), false);
    assert.equal((await request(value.effectivePort, '/api/health')).status, 200);
    await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].show());
    assert.equal(await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].isVisible()), true);
    console.log('PASS closing the window hides it while the server stays reachable and the window can be restored');

    // Record external opens instead of launching the real system browser.
    await application.evaluate(({shell}) => { globalThis.openedOutside = []; shell.openExternal = async url => { globalThis.openedOutside.push(url); }; });
    const wallUrl = page.url();
    await page.evaluate(() => { window.open('https://example.com/paper.pdf', '_blank'); });
    await page.evaluate(() => { location.href = 'http://127.0.0.1:9/elsewhere'; }).catch(() => {});
    await sleep(500);
    assert.equal(await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().length), 1);
    assert.equal(page.url(), wallUrl);
    assert.deepEqual(await application.evaluate(() => globalThis.openedOutside), ['https://example.com/paper.pdf', 'http://127.0.0.1:9/elsewhere']);
    console.log('PASS links never open app windows or navigate the wall away');

    await putWall(value.effectivePort);
    const config = await application.evaluate(({app}, input) => {
      const appRequire = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/');
      const {mcpConfig} = appRequire('./server/server.js');
      return JSON.parse(mcpConfig(input.dbPath, input.port, input.wallId));
    }, {dbPath: value.dbPath, port: value.effectivePort, wallId: 'electron-test'});
    const spec = config.mcpServers['detective-wall'];
    assert.equal(spec.env.ELECTRON_RUN_AS_NODE, '1');
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      env: {...process.env, ...spec.env},
      stderr: 'pipe',
    });
    const client = new Client({name: 'detective-wall-electron-test', version: '1.0.0'});
    await client.connect(transport);
    const listed = await client.callTool({name: 'list_boards'});
    const data = listed.structuredContent || JSON.parse(listed.content[0].text);
    assert.ok(data.boards.some(board => board.wallId === 'electron-test'));
    await client.close();
    console.log('PASS Electron MCP config injects ELECTRON_RUN_AS_NODE and lists the temp DB wall');

    const closed = application.waitForEvent('close', {timeout: 15000});
    await application.evaluate(({app}) => app.quit());
    await closed;
    await assert.rejects(() => request(value.effectivePort, '/api/health'));
    console.log('PASS app.quit closes the HTTP listener');
  } finally {
    await closeApp(application);
  }
}

async function testSingleInstance() {
  const userData = newUserData('single');
  const first = await launch(userData);
  try {
    const page = await firstWindow(first);
    await waitForWall(page);
    await first.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].hide());
    const second = spawn(electronPath, ['.'], {
      cwd: root,
      env: {...process.env, CASEGRAPH_USER_DATA: userData, WALL_PORT: '0'},
      stdio: 'ignore',
      windowsHide: true,
    });
    const result = await waitForExit(second);
    assert.equal(result.code, 0);
    assert.equal(first.windows().length, 1);
    assert.equal(await first.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].isVisible()), true);
    console.log('PASS the second instance exits and the first instance keeps one restored window');
  } finally {
    await closeApp(first);
  }
}

async function testOccupiedPort() {
  const blocker = http.createServer((_req, res) => { res.writeHead(200); res.end('occupier'); });
  await new Promise((resolve, reject) => { blocker.once('error', reject); blocker.listen(0, '127.0.0.1', resolve); });
  const occupiedPort = blocker.address().port;
  const userData = newUserData('port');
  const project = path.join(userData, 'CaseGraph', 'projects', 'occupied');
  const settingsPath = path.join(userData, 'CaseGraph', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), {recursive: true});
  fs.writeFileSync(settingsPath, JSON.stringify({schemaVersion: 1, port: occupiedPort, activeProjectFolder: project}, null, 2));
  const application = await launch(userData, occupiedPort);
  try {
    const page = await firstWindow(application);
    await page.waitForFunction(port => document.querySelector('#status')?.textContent.includes(`埠 ${port} 已被占用`), occupiedPort);
    assert.equal((await getState(page)).status, 'port-occupied');
    await page.locator('#use-free-port').click();
    await waitForWall(page);
    const value = await getState(page);
    assert.notEqual(value.effectivePort, occupiedPort);
    assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).port, occupiedPort);
    const occupant = await request(occupiedPort, '/still-occupied');
    assert.equal(occupant.body, 'occupier');
    console.log('PASS an occupied port is shown, use-free-port starts the wall without rewriting settings or stopping the occupier');
  } finally {
    await closeApp(application);
    await new Promise(resolve => blocker.close(resolve));
  }
}

(async () => {
  await testLifecycleAndRuntime();
  await testSingleInstance();
  await testOccupiedPort();
})().catch(error => {
  console.error(`FAIL Electron suite: ${error.stack || error}`);
  process.exitCode = 1;
});
