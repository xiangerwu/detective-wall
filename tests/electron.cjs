const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');
const {Client} = require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport} = require('@modelcontextprotocol/sdk/client/stdio.js');
const {createWallServer} = require('../server/server.js');

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

async function launch(userData, wallPort = '0', extraEnv = {}) {
  return electron.launch({
    executablePath: electronPath,
    args: ['.'],
    cwd: root,
    env: {...process.env, ...extraEnv, CASEGRAPH_USER_DATA: userData, WALL_PORT: String(wallPort)},
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

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function seedProject(folder, wallId, title) {
  fs.mkdirSync(folder, {recursive: true});
  const value = createWallServer({dbPath: path.join(folder, 'wall.db'), port: 0});
  await new Promise((resolve, reject) => {
    value.once('error', reject);
    value.once('listening', resolve);
  });
  try {
    const response = await request(value.address().port, `/api/walls/${wallId}`, 'PUT', {
      id: wallId, name: title, version: null, data: {bands: [], tags: [], cards: [{id: `${wallId}-card`, title}], edges: []},
    });
    assert.equal(response.status, 200);
  } finally {
    await value.stopChats();
    await new Promise(resolve => value.close(() => { value.db.close(); resolve(); }));
  }
}

async function openSettings(page) {
  await page.locator('#launcher-settings').click();
  await page.locator('#launcher-settings-dialog[open]').waitFor();
}

async function testMenuIconsAndSettingsInput() {
  const userData = newUserData('settings-ui');
  const application = await launch(userData);
  try {
    const page = await firstWindow(application);
    await waitForWall(page);
    assert.equal(await application.evaluate(({Menu}) => Menu.getApplicationMenu()), null);
    assert.equal(await page.locator('#launcher-settings').isHidden(), false);

    await openSettings(page);
    const input = page.locator('#launcher-port');
    await input.fill('12345');
    await input.press('Control+A');
    await input.press('Control+C');
    await input.press('Backspace');
    assert.equal(await input.inputValue(), '');
    await input.press('Control+V');
    assert.equal(await input.inputValue(), '12345');
    await input.press('Control+Z');
    assert.equal(await input.inputValue(), '');
    console.log('PASS application menu is removed and Chromium input editing still supports Ctrl+A/C/V/Z');
  } finally {
    await closeApp(application);
  }
}

async function testSettingsPortAndValidation() {
  const userData = newUserData('settings-port');
  const application = await launch(userData);
  try {
    const page = await firstWindow(application);
    await waitForWall(page);
    const before = await getState(page);
    const oldPort = before.effectivePort;
    const nextPort = await freePort();
    await openSettings(page);
    await page.locator('#launcher-port').fill(String(nextPort));
    await page.locator('#launcher-apply').click();
    await waitForWall(page);
    const after = await getState(page);
    assert.equal(after.configuredPort, nextPort);
    assert.equal(after.effectivePort, nextPort);
    assert.equal((await request(nextPort, '/api/health')).status, 200);
    await assert.rejects(() => request(oldPort, '/api/health'));
    const settingsPath = path.join(userData, 'CaseGraph', 'settings.json');
    const saved = fs.readFileSync(settingsPath, 'utf8');
    assert.equal(JSON.parse(saved).port, nextPort);

    for (const invalid of ['80', '70000', '']) {
      await openSettings(page);
      await page.locator('#launcher-port').fill(invalid);
      await page.locator('#launcher-apply').click();
      assert.equal(await page.locator('#launcher-port-error').textContent(), '請輸入 1024–65535 的整數');
      assert.equal(fs.readFileSync(settingsPath, 'utf8'), saved);
      await page.locator('#launcher-cancel').click();
    }
    console.log('PASS port changes restart the service and invalid ports stay in the modal without rewriting settings');
  } finally {
    await closeApp(application);
  }
}

async function testProjectSwitchAndPersistence() {
  const userData = newUserData('settings-project');
  const projectA = path.join(userData, 'projects', 'project-a');
  const projectB = path.join(userData, 'projects', 'project-b');
  await seedProject(projectA, 'wall-a', 'Project A');
  await seedProject(projectB, 'wall-b', 'Project B');
  const port = await freePort();
  const settingsPath = path.join(userData, 'CaseGraph', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), {recursive: true});
  fs.writeFileSync(settingsPath, JSON.stringify({schemaVersion: 1, port, activeProjectFolder: projectA,
    recentProjects: [{folder: projectA, aiWorkdir: null, lastUsedAt: new Date().toISOString()}]}, null, 2));
  const application = await launch(userData);
  try {
    let page = await firstWindow(application);
    await waitForWall(page);
    assert.equal(path.resolve((await getState(page)).activeProjectFolder), path.resolve(projectA));
    await application.evaluate(({dialog}, folder) => {
      dialog.showOpenDialog = async () => ({canceled: false, filePaths: [folder]});
    }, projectB);
    await openSettings(page);
    await page.locator('#launcher-project-pick').click();
    assert.equal(path.resolve(await page.locator('#launcher-project-folder').textContent()), path.resolve(projectB));
    await page.locator('#launcher-apply').click();
    await waitForWall(page);
    let value = await getState(page);
    assert.equal(path.resolve(value.activeProjectFolder), path.resolve(projectB));
    assert.equal(path.resolve(value.dbPath), path.join(path.resolve(projectB), 'wall.db'));
    assert.equal(path.resolve((await request(value.effectivePort, '/api/health')).body.db), path.resolve(value.dbPath));
    assert.equal((await request(value.effectivePort, '/api')).body.name, 'Project B');
    assert.deepEqual(new Set(value.recentProjects.map(item => item.folder.toLowerCase())), new Set([projectA.toLowerCase(), projectB.toLowerCase()]));
    console.log('PASS switching projects changes DB and wall content while keeping both recent projects');

    const closed = application.waitForEvent('close', {timeout: 15000});
    await application.evaluate(({app}) => app.quit());
    await closed;
    const restarted = await launch(userData);
    try {
      page = await firstWindow(restarted);
      await waitForWall(page);
      value = await getState(page);
      assert.equal(path.resolve(value.activeProjectFolder), path.resolve(projectB));
      assert.equal((await request(value.effectivePort, '/api')).body.name, 'Project B');
      console.log('PASS the selected project remains active after restarting the app');
    } finally {
      await closeApp(restarted);
    }
  } finally {
    await closeApp(application);
  }
}

async function testAiWorkdir() {
  const userData = newUserData('settings-ai');
  const aiFolder = path.join(userData, 'ai-a');
  const logPath = path.join(userData, 'fake-cli.jsonl');
  const application = await launch(userData, '0', {
    WALL_CLAUDE_BIN: path.join(__dirname, 'fake-chat-cli.js'),
    WALL_FAKE_CLI_LOG: logPath,
    WALL_CHAT_TIMEOUT_MS: '2000',
  });
  try {
    const page = await firstWindow(application);
    await waitForWall(page);
    const initial = await getState(page);
    const sourceFolders = [path.join(userData, 'authorized-source')];
    await request(initial.effectivePort, '/api/meta/sourceFolders', 'PUT', {value: sourceFolders});
    await application.evaluate(({dialog}, folder) => {
      dialog.showOpenDialog = async () => ({canceled: false, filePaths: [folder]});
    }, aiFolder);
    await openSettings(page);
    await page.locator('#launcher-ai-pick').click();
    await page.locator('#launcher-apply').click();
    await waitForWall(page);
    let value = await getState(page);
    assert.notEqual(value.effectivePort, 3000, 'a settings restart must keep WALL_PORT, never fall back to the live port');
    assert.equal(path.resolve(value.aiWorkdir), path.resolve(aiFolder));
    let response = await request(value.effectivePort, '/api/chat/w-main', 'POST', {client: 'claude', message: 'cwd-a'});
    assert.equal(response.status, 200);
    let records = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(path.resolve(records.at(-1).cwd), path.resolve(aiFolder));
    assert.deepEqual((await request(value.effectivePort, '/api/meta/sourceFolders')).body.value, sourceFolders);

    await openSettings(page);
    await page.locator('#launcher-ai-clear').click();
    await page.locator('#launcher-apply').click();
    await waitForWall(page);
    value = await getState(page);
    assert.equal(value.aiWorkdir, null);
    response = await request(value.effectivePort, '/api/chat/w-main', 'POST', {client: 'claude', message: 'cwd-default'});
    assert.equal(response.status, 200);
    records = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(path.resolve(records.at(-1).cwd), path.join(path.dirname(value.dbPath), 'chat-workdir'));
    assert.deepEqual((await request(value.effectivePort, '/api/meta/sourceFolders')).body.value, sourceFolders);
    console.log('PASS AI workdir changes the fake CLI cwd, clearing restores the project fallback, and sourceFolders stay unchanged');
  } finally {
    await closeApp(application);
  }
}

async function testBrokenSettingsRepair() {
  const blocker = http.createServer((_req, res) => { res.writeHead(200); res.end('occupier'); });
  await new Promise((resolve, reject) => { blocker.once('error', reject); blocker.listen(0, '127.0.0.1', resolve); });
  const occupiedPort = blocker.address().port;
  const userData = newUserData('settings-repair');
  const settingsPath = path.join(userData, 'CaseGraph', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), {recursive: true});
  fs.writeFileSync(settingsPath, '{bad json');
  const application = await launch(userData, occupiedPort);
  try {
    const page = await firstWindow(application);
    await page.locator('#status').waitFor();
    await page.locator('#open-settings').waitFor({state: 'visible'});
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), '{bad json');
    await page.locator('#open-settings').click();
    await waitForWall(page);
    await page.locator('#launcher-settings-dialog[open]').waitFor();
    assert.match(await page.locator('#launcher-settings-message').textContent(), /設定檔需要修復/);
    const nextPort = await freePort();
    await page.locator('#launcher-port').fill(String(nextPort));
    await page.locator('#launcher-apply').click();
    await waitForWall(page);
    const repaired = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(repaired.port, nextPort);
    assert.equal(Object.hasOwn(repaired, 'legacyMigration'), false);
    assert.equal((await getState(page)).settingsNeedsRepair, false);
    console.log('PASS a broken settings file stays untouched until Apply, then is atomically replaced by valid E2 settings');
  } finally {
    await closeApp(application);
    await new Promise(resolve => blocker.close(resolve));
  }
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

    // A connection that never goes idle (here: a half-sent request) used to keep server.close() waiting forever.
    const busySocket = net.connect(value.effectivePort, '127.0.0.1');
    await new Promise((resolve, reject) => { busySocket.once('connect', resolve); busySocket.once('error', reject); });
    busySocket.on('error', () => {});
    busySocket.write('GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n');
    const closed = application.waitForEvent('close', {timeout: 15000});
    await application.evaluate(({app}) => app.quit());
    await closed;
    busySocket.destroy();
    await assert.rejects(() => request(value.effectivePort, '/api/health'));
    console.log('PASS app.quit closes the HTTP listener even while a connection is still busy');
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
  fs.mkdirSync(project, {recursive: true});
  fs.mkdirSync(path.dirname(settingsPath), {recursive: true});
  fs.writeFileSync(settingsPath, JSON.stringify({schemaVersion: 1, port: occupiedPort, activeProjectFolder: project,
    recentProjects: [{folder: project, aiWorkdir: null, lastUsedAt: new Date().toISOString()}]}, null, 2));
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
  await testMenuIconsAndSettingsInput();
  await testSettingsPortAndValidation();
  await testProjectSwitchAndPersistence();
  await testAiWorkdir();
  await testBrokenSettingsRepair();
})().catch(error => {
  console.error(`FAIL Electron suite: ${error.stack || error}`);
  process.exitCode = 1;
});
