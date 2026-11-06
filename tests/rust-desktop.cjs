// Windows Tauri/WebView2 integration. Start a private CDP endpoint for this test process only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright-core');

assert.equal(process.platform, 'win32', 'this suite exercises the Windows release');
const root = path.resolve(__dirname, '..');
const executable = process.env.CASEGRAPH_TEST_DESKTOP || path.join(root, 'src-tauri', 'target', 'release', 'casegraph.exe');
assert.ok(fs.existsSync(executable), 'build the Tauri release executable first');
const out = path.resolve(process.env.WALL_TEST_OUT || path.join(root, 'test-results', 'rust-desktop'));
fs.mkdirSync(out, {recursive: true});
const run = fs.mkdtempSync(path.join(out, 'run-'));
const userData = path.join(run, 'user-data');
const profile = path.join(run, 'webview-profile');
const executionLog = path.join(run, 'execution.log');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pass = text => { console.log('PASS ' + text); fs.appendFileSync(executionLog, 'PASS ' + text + '\n'); };
let child, browser, page, blocker;
const pageErrors = [];

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

function httpJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({hostname:'127.0.0.1',port,path:pathname}, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.once('end', () => { try { resolve({status:res.statusCode,body:JSON.parse(text)}); } catch (error) {reject(error);} });
      res.once('error', reject);
    });
    req.setTimeout(3000, () => req.destroy(new Error('HTTP timeout')));
    req.once('error', reject);
  });
}

async function until(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) {
      if (/not allowed by ACL/.test(error.message)) throw error;
      lastError = error;
    }
    await sleep(80);
  }
  throw new Error(`Timed out: ${label}${lastError ? '\n' + lastError.message : ''}`);
}

async function launch() {
  const debuggingPort = await freePort();
  child = spawn(executable, [], {cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,
    CASEGRAPH_USER_DATA:userData,WALL_PORT:'0',WEBVIEW2_USER_DATA_FOLDER:profile,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${debuggingPort}`,
    WALL_CLAUDE_BIN:path.join(run,'missing-claude.exe'),WALL_CODEX_BIN:path.join(run,'missing-codex.exe')}});
  child.stdout.on('data', chunk => fs.appendFileSync(path.join(run,'process.log'),chunk));
  child.stderr.on('data', chunk => fs.appendFileSync(path.join(run,'process.log'),chunk));
  let spawnError;
  child.once('error', error => { spawnError = error; });
  await until(async () => {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error('desktop exited: ' + child.exitCode);
    return (await httpJson(debuggingPort,'/json/version')).body.webSocketDebuggerUrl;
  },'private WebView2 debugging endpoint');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debuggingPort}`,{timeout:15000});
  page = await until(() => browser.contexts().flatMap(context => context.pages()).find(candidate => /127\.0\.0\.1|tauri\.localhost/.test(candidate.url())),'application page');
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => {pageErrors.push(error.message); fs.appendFileSync(path.join(run,'page-errors.log'),error.stack + '\n');});
  page.on('console', message => {if (message.type()==='error') fs.appendFileSync(path.join(run,'console-errors.log'),message.text() + '\n');});
  await wallReady();
}

async function wallReady() {
  await page.waitForFunction(() => window.wallReady === true && Boolean(window.caseGraph));
  return until(async () => {
    const state = await page.evaluate(() => window.caseGraph.getState());
    return state.status === 'running' ? state : null;
  },'running bridge');
}

async function transition(action, input, check, label) {
  // Restarting the service navigates the WebView; do not await an IPC promise in the old document.
  await page.evaluate(({action,input}) => {
    const pending = action === 'settings' ? window.caseGraph.saveSettings(input) : window.caseGraph.service(action);
    pending.catch(error => { window.__lastTransitionError = String(error); });
  },{action,input}).catch(error => {if (!/Execution context was destroyed|navigation/.test(error.message)) throw error;});
  return until(async () => {
    const state = await page.evaluate(() => window.caseGraph.getState());
    return check(state) ? state : null;
  },label);
}

async function closeApp() {
  if (!child) return;
  if (page && !page.isClosed()) {
    try {
      await transition('stop',null,state => state.status === 'stopped','stop before closing');
    } catch (error) { fs.appendFileSync(executionLog,'Cleanup stop: ' + error.message + '\n'); }
  }
  // CDP disconnect does not grant an application quit command or alter the product's IPC surface.
  if (browser) await browser.close().catch(() => {});
  browser = null;
  page = null;
  if (child.exitCode === null) {
    const pid = child.pid;
    await new Promise((resolve, reject) => {
      const killer = spawn('taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
      killer.once('error',reject);
      killer.once('close',resolve);
    });
    await until(() => child.exitCode !== null,'owned desktop process exit',5000);
  }
  child = null;
}

(async () => {
  try {
    await launch();
    let state = await wallReady();
    assert.equal(path.resolve(state.dbPath),path.join(userData,'CaseGraph','projects','default','wall.db'));
    assert.equal(state.nodeVersion,null);
    assert.equal(state.electronVersion,null);
    assert.equal((await httpJson(state.effectivePort,'/api/health')).body.app,'casegraph');
    assert.ok(await page.evaluate(() => typeof window.require === 'undefined' && !!window.__TAURI__ && Object.isFrozen(window.caseGraph)));
    assert.ok(await page.locator('.card').count() > 0);
    pass('real Tauri WebView2 loads the existing wall with a working restricted native bridge and isolated SQLite path');

    const cardId = await page.evaluate(() => {const id=data.cards[0].id;openPanel(id);return id;});
    const title = 'Rust 桌面相容測試';
    await page.locator('#f-title').fill(title);
    await page.locator('#f-note').fill('既有白板介面，Rust SQLite 保存。');
    await page.locator('#f-close').click();
    await page.evaluate(async () => {await save(true);await store.flushWrites();});
    await page.reload();
    await wallReady();
    assert.equal(await page.evaluate(id => data.cards.find(card => card.id === id)?.title,cardId),title);
    pass('editing through the existing card UI persists through a WebView reload');

    await page.locator('#activity-toggle').click();
    await page.locator('#activity-launcher-settings').click();
    await page.locator('#launcher-settings-dialog[open]').waitFor();
    assert.equal(await page.locator('#launcher-port').inputValue(),String(state.configuredPort));
    const saved = fs.readFileSync(state.settingsPath,'utf8');
    await page.locator('#launcher-port').fill('80');
    await page.locator('#launcher-apply').click();
    assert.equal(await page.locator('#launcher-port-error').textContent(),'請輸入 1024–65535 的整數');
    assert.equal(fs.readFileSync(state.settingsPath,'utf8'),saved);
    await page.locator('#launcher-cancel').click();
    const invalid = await page.evaluate(async () => {
      const attempts = [() => window.caseGraph.service('delete'),() => window.caseGraph.openClient('bad'),
        () => window.caseGraph.pickDirectory('bad'),() => window.caseGraph.saveSettings({port:80,activeProjectFolder:'relative'})];
      return Promise.all(attempts.map(async action => {try {await action();return false;}catch {return true;}}));
    });
    assert.deepEqual(invalid,[true,true,true,true]);
    pass('launcher settings remain usable and invalid native commands/settings are rejected without changing files');

    const originalProject = path.resolve(state.activeProjectFolder);
    const project = path.join(run,"新專案 folder's");
    const aiWorkdir = path.join(run,'AI 工作資料夾');
    const nextPort = await freePort();
    const oldPort = state.effectivePort;
    state = await transition('settings',{port:nextPort,activeProjectFolder:project,aiWorkdir},
      state => state.status==='running' && state.effectivePort===nextPort && path.resolve(state.activeProjectFolder)===project,'project/port apply');
    await wallReady();
    assert.equal(state.configuredPort,nextPort);
    assert.equal(path.resolve(state.aiWorkdir),aiWorkdir);
    assert.equal(path.resolve(state.dbPath),path.join(project,'wall.db'));
    await assert.rejects(() => httpJson(oldPort,'/api/health'));
    assert.equal((await httpJson(nextPort,'/api/health')).body.db,state.dbPath);
    assert.ok(state.recentProjects.some(row => path.resolve(row.folder)===originalProject));
    pass('saveSettings switches the project, AI workdir and HTTP port, and retires the old listener');

    blocker = http.createServer((_req,res) => res.end('owned test blocker'));
    await new Promise((resolve,reject) => {blocker.once('error',reject);blocker.listen(0,'127.0.0.1',resolve);});
    const occupiedPort = blocker.address().port;
    const stableSettings = fs.readFileSync(state.settingsPath,'utf8');
    state = await transition('settings',{port:occupiedPort,activeProjectFolder:project,aiWorkdir},
      state => state.status==='running' && state.effectivePort===nextPort && Boolean(state.lastApplyError),'occupied-port rollback');
    await wallReady();
    assert.equal(fs.readFileSync(state.settingsPath,'utf8'),stableSettings);
    assert.equal((await httpJson(nextPort,'/api/health')).status,200);
    assert.equal(blocker.listening,true);
    await page.evaluate(() => window.caseGraph.clearApplyError());
    await new Promise(resolve => blocker.close(resolve));
    blocker = null;
    pass('an occupied port rolls back to the working project/service without changing saved settings or stopping its owner');

    const stopped = await transition('stop',null,state => state.status==='stopped','service stop');
    assert.equal(stopped.effectivePort,null);
    await page.waitForURL(/status\.html/);
    await assert.rejects(() => httpJson(nextPort,'/api/health'));
    state = await transition('start',null,state => state.status==='running','service start from status page');
    await wallReady();
    assert.equal(state.effectivePort,nextPort);
    const logCount = state.logs.length;
    await transition('restart',null,state => state.status==='running' && state.logs.length > logCount,'service restart');
    await wallReady();
    pass('status-page bridge can stop, start and restart the Rust service');

    state = await transition('settings',{port:nextPort,activeProjectFolder:originalProject,aiWorkdir:null},
      state => state.status==='running' && path.resolve(state.activeProjectFolder)===originalProject,'return to original project');
    await wallReady();
    assert.equal(await page.evaluate(id => data.cards.find(card => card.id===id)?.title,cardId),title);
    await page.locator('#zoom-fit').click();
    await page.screenshot({path:path.join(run,'tauri-wall.png')});
    await closeApp();
    await launch();
    state = await wallReady();
    assert.equal(path.resolve(state.activeProjectFolder),originalProject);
    assert.equal(state.configuredPort,nextPort);
    assert.equal(await page.evaluate(id => data.cards.find(card => card.id===id)?.title,cardId),title);
    await page.locator('#zoom-fit').click();
    await page.screenshot({path:path.join(run,'tauri-restarted.png')});
    pass('project settings and edited wall survive an actual desktop process restart');
    assert.deepEqual(pageErrors,[]);
    pass('the real WebView completed the tested flows without JavaScript page errors');
  } finally {
    if (page && !page.isClosed()) await page.screenshot({path:path.join(run,'final-state.png')}).catch(() => {});
    await closeApp();
    if (blocker) await new Promise(resolve => blocker.close(resolve));
  }
  console.log('Artifacts: ' + run);
})().catch(error => {
  console.error(error);
  fs.appendFileSync(executionLog,'FAIL ' + error.stack + '\n');
  process.exitCode = 1;
});
