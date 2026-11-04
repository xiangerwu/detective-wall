'use strict';

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  nativeImage,
  shell,
  dialog,
  ipcMain,
} = require('electron');
const {createWallServer, cliPath} = require('../server/server.js');
const {buildCliLaunch} = require('./cli-launch.js');

const APP_TITLE = 'CaseGraph 案件圖譜';
const DEFAULT_PORT = 3000;
const SETTINGS_SCHEMA_VERSION = 1;
const ICON_PATHS = Object.freeze({
  window: path.join(__dirname, '..', 'assets', 'icon', 'icon.ico'),
  tray: path.join(__dirname, '..', 'assets', 'icon', process.platform === 'win32' ? 'icon.ico' : 'icon-16.png'),
});
const SERVICE_ACTIONS = new Set(['start', 'stop', 'restart', 'useFreePort']);

const requestedUserData = process.env.CASEGRAPH_USER_DATA;
if (requestedUserData) {
  const userData = path.resolve(requestedUserData);
  fs.mkdirSync(userData, {recursive: true});
  app.setPath('userData', userData);
}

let mainWindow;
let tray;
let server;
let settings;
let settingsPath;
let caseGraphDir;
let defaultProjectFolder;
let runtimeDir;
let logDir;
let logPath;
let activeProjectFolder;
let databasePath;
let configuredPort = DEFAULT_PORT;
let effectivePort = null;
let runtimePortOverride = null;
let envPortOverride = process.env.WALL_PORT === undefined || process.env.WALL_PORT === '' ? null : Number(process.env.WALL_PORT);
let settingsNeedsRepair = false;
let serviceStatus = 'starting';
let serviceMessage = '正在啟動本機服務…';
let lastError = null;
let lastApplyError = null;
let cliOpenedSinceStart = false;
let staleClients = false;
let hideNotified = false;
let isQuitting = false;
let shutdownTask;
let serviceQueue = Promise.resolve();
let settingsRequestQueued = false;

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function writeLog(level, message, error) {
  if (!logPath) return;
  const detail = error ? `\n${error.stack || errorText(error)}` : '';
  try {
    fs.mkdirSync(logDir, {recursive: true});
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${level} ${message}${detail}\n`);
  } catch (writeError) {
    console.error(`CaseGraph log failed: ${errorText(writeError)}`);
  }
}

// Last 200 lines from the final 64 KiB only: the log is never truncated, and every state update calls this.
function readLogTail() {
  let fd;
  try {
    fd = fs.openSync(logPath, 'r');
    const size = fs.fstatSync(fd).size, length = Math.min(size, 64 * 1024), buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split(/\r?\n/);
    if (length < size) lines.shift();  // starts mid-line
    return lines.filter(Boolean).slice(-200);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Scanning PATH costs milliseconds per client and state() runs on every status change; a CLI installed while
// the app runs shows up within 30 s (opening a CLI always looks it up afresh).
let clientCache = null, clientCacheAt = 0;
function clientState() {
  if (!clientCache || Date.now() - clientCacheAt > 30000) {
    clientCache = Object.fromEntries(['claude', 'codex'].map(client => {
      const pathname = cliPath(client);
      return [client, {available: Boolean(pathname), path: pathname}];
    }));
    clientCacheAt = Date.now();
  }
  return clientCache;
}

function defaultSettings() {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    port: DEFAULT_PORT,
    activeProjectFolder: defaultProjectFolder,
    recentProjects: [{folder: defaultProjectFolder, aiWorkdir: null, lastUsedAt: new Date().toISOString()}],
  };
}

function validPort(value) {
  return Number.isInteger(value) && value >= 0 && value <= 65535;
}

function validConfiguredPort(value) {
  return Number.isInteger(value) && value >= 1024 && value <= 65535;
}

function pathKey(value) {
  return path.normalize(path.resolve(value)).replace(/[\\/]+$/, '').toLowerCase();
}

function isAbsolutePath(value) {
  return typeof value === 'string' && path.isAbsolute(value);
}

function validateRecentProjects(value) {
  if (!Array.isArray(value) || value.length > 10) throw new Error('recentProjects is invalid');
  const seen = new Set();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || !isAbsolutePath(item.folder)
      || !(item.aiWorkdir === null || isAbsolutePath(item.aiWorkdir))
      || typeof item.lastUsedAt !== 'string' || Number.isNaN(Date.parse(item.lastUsedAt))) {
      throw new Error('recentProjects is invalid');
    }
    const folder = path.resolve(item.folder);
    const key = pathKey(folder);
    if (seen.has(key)) throw new Error('recentProjects contains duplicate folders');
    seen.add(key);
    return {folder, aiWorkdir: item.aiWorkdir === null ? null : path.resolve(item.aiWorkdir), lastUsedAt: item.lastUsedAt};
  });
}

function validateStoredSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== SETTINGS_SCHEMA_VERSION
    || Object.hasOwn(value, 'legacyMigration')
    || !validConfiguredPort(value.port)
    || !isAbsolutePath(value.activeProjectFolder)) {
    throw new Error('settings schema is invalid');
  }
  const activeProjectFolder = path.resolve(value.activeProjectFolder);
  if (!fs.existsSync(activeProjectFolder) || !fs.statSync(activeProjectFolder).isDirectory()) {
    throw new Error('active project folder does not exist');
  }
  const recentProjects = validateRecentProjects(value.recentProjects);
  if (!recentProjects.some(item => pathKey(item.folder) === pathKey(activeProjectFolder))) {
    throw new Error('active project is not in recentProjects');
  }
  for (const item of recentProjects) {
    if (item.aiWorkdir && pathKey(item.aiWorkdir) === pathKey(path.join(item.folder, 'wall.db'))) {
      throw new Error('aiWorkdir cannot be wall.db');
    }
    if (item.aiWorkdir && fs.existsSync(item.aiWorkdir) && !fs.statSync(item.aiWorkdir).isDirectory()) {
      throw new Error('aiWorkdir is not a directory');
    }
  }
  return {schemaVersion: SETTINGS_SCHEMA_VERSION, port: value.port, activeProjectFolder, recentProjects};
}

function readSettings() {
  const fallback = defaultSettings();
  if (!fs.existsSync(settingsPath)) return fallback;
  try {
    return validateStoredSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
  } catch (error) {
    settingsNeedsRepair = true;
    writeLog('ERROR', '設定檔需要修復；已使用預設設定', error);
    return fallback;
  }
}

function writeSettings(value) {
  const temporaryPath = `${settingsPath}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(settingsPath), {recursive: true});
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.renameSync(temporaryPath, settingsPath);
  } catch (error) {
    try { fs.rmSync(temporaryPath, {force: true}); } catch {}
    throw error;
  }
}

function ensureDirectory(value, label) {
  if (!isAbsolutePath(value)) throw new Error(`${label} 必須是絕對路徑`);
  fs.mkdirSync(value, {recursive: true});
  if (!fs.statSync(value).isDirectory()) throw new Error(`${label} 不是資料夾`);
  return path.resolve(value);
}

function recentProject(folder, value = settings) {
  return value?.recentProjects?.find(item => pathKey(item.folder) === pathKey(folder)) || null;
}

function configuredAiWorkdir(folder = activeProjectFolder, value = settings) {
  return recentProject(folder, value)?.aiWorkdir || null;
}

function effectiveAiWorkdir(folder = activeProjectFolder, value = settings) {
  return configuredAiWorkdir(folder, value) || path.join(folder, 'chat-workdir');
}

function buildSettings(port, folder, aiWorkdir) {
  const rows = (settings?.recentProjects || []).filter(item => pathKey(item.folder) !== pathKey(folder));
  rows.unshift({folder, aiWorkdir: aiWorkdir || null, lastUsedAt: new Date().toISOString()});
  return {schemaVersion: SETTINGS_SCHEMA_VERSION, port, activeProjectFolder: folder, recentProjects: rows.slice(0, 10)};
}

function validateSettingsInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('設定內容無效');
  const port = input.port;
  if (!validConfiguredPort(port)) throw new Error('請輸入 1024–65535 的整數');
  if (!isAbsolutePath(input.activeProjectFolder)) throw new Error('目前專案必須是絕對路徑');
  const folder = path.resolve(input.activeProjectFolder);
  const aiWorkdir = input.aiWorkdir === null || input.aiWorkdir === undefined ? null : path.resolve(input.aiWorkdir);
  if (aiWorkdir && !isAbsolutePath(input.aiWorkdir)) throw new Error('AI 工作資料夾必須是絕對路徑');
  if (aiWorkdir && pathKey(aiWorkdir) === pathKey(path.join(folder, 'wall.db'))) {
    throw new Error('AI 工作資料夾不能是 wall.db');
  }
  return {port, folder, aiWorkdir};
}

function state() {
  const current = recentProject(activeProjectFolder);
  return {
    status: serviceStatus,
    message: serviceMessage,
    error: lastError,
    configuredPort,
    effectivePort,
    port: effectivePort ?? configuredPort,
    activeProjectFolder,
    dbPath: databasePath,
    settingsPath,
    settingsNeedsRepair,
    settings: structuredClone(settings),
    recentProjects: structuredClone(settings?.recentProjects || []),
    aiWorkdir: current?.aiWorkdir || null,
    effectiveAiWorkdir: effectiveAiWorkdir(),
    defaultProjectFolder,
    chatActive: Boolean(server?.hasActiveChats?.()),
    clients: clientState(),
    staleClients,
    lastApplyError: lastApplyError ? {...lastApplyError} : null,
    logPath,
    logs: readLogTail(),
    nodeVersion: process.versions.node,
    electronVersion: process.versions.electron || null,
  };
}

function updateTrayMenu() {
  if (!tray) return;
  const running = serviceStatus === 'running' || serviceStatus === 'starting' || serviceStatus === 'stopping';
  const clients = clientState();
  tray.setContextMenu(Menu.buildFromTemplate([
    {label: '顯示 CaseGraph', click: showWindow},
    {label: '設定…', enabled: !isQuitting, click: () => { void requestSettings(); }},
    {label: '重新啟動服務', enabled: !isQuitting, click: () => serviceAction('restart')},
    {label: running ? '停止服務' : '啟動服務', enabled: !isQuitting, click: () => serviceAction(running ? 'stop' : 'start')},
    {label: `開啟 Claude CLI${clients.claude.available ? '' : '（找不到）'}`, enabled: !isQuitting && clients.claude.available,
      click: () => { void openClient('claude').catch(() => {}); }},
    {label: `開啟 codex CLI${clients.codex.available ? '' : '（找不到）'}`, enabled: !isQuitting && clients.codex.available,
      click: () => { void openClient('codex').catch(() => {}); }},
    {label: '開啟紀錄資料夾', click: () => { void shell.openPath(logDir).catch(error => writeLog('ERROR', '無法開啟紀錄資料夾', error)); }},
    {type: 'separator'},
    {label: '結束', click: () => app.quit()},
  ]));
}

function publishState() {
  updateTrayMenu();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send('casegraph:state-changed', state()); } catch {}
}

function setState(status, message, error = null) {
  serviceStatus = status;
  serviceMessage = message;
  lastError = error ? errorText(error) : null;
  publishState();
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function notifyHidden() {
  if (hideNotified) return;
  hideNotified = true;
  try {
    if (Notification.isSupported()) {
      new Notification({title: APP_TITLE, body: 'CaseGraph 已隱藏到系統匣。'}).show();
    }
  } catch (error) {
    writeLog('ERROR', '無法顯示系統匣通知', error);
  }
}

async function loadStatusPage() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { await mainWindow.loadFile(path.join(__dirname, 'status.html')); } catch (error) {
    // ERR_ABORTED only means a newer navigation (often the next status update) replaced this one.
    if (error?.code !== 'ERR_ABORTED') writeLog('ERROR', '狀態頁載入失敗', error);
  }
}

async function closeWallServer(value) {
  if (!value) return;
  try { await value.stopChats?.(); } catch (error) { writeLog('ERROR', '停止聊天 CLI 失敗', error); }
  if (value.listening) {
    await new Promise(resolve => {
      // The wall keeps reusing its keep-alive socket, so close() alone can wait forever;
      // in-flight requests (a save) get a short grace period before the sockets are cut.
      const force = setTimeout(() => value.closeAllConnections(), 2000);
      value.close(error => {
        clearTimeout(force);
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') writeLog('ERROR', '停止服務失敗', error);
        resolve();
      });
    });
  }
  try { value.db?.close(); } catch (error) { writeLog('ERROR', '關閉 SQLite 失敗', error); }
}

function waitForListening(value) {
  return new Promise((resolve, reject) => {
    const listening = () => { cleanup(); resolve(); };
    const failed = error => { cleanup(); reject(error); };
    const cleanup = () => {
      value.off('listening', listening);
      value.off('error', failed);
    };
    value.once('listening', listening);
    value.once('error', failed);
  });
}

function startPort(override) {
  if (override !== null && override !== undefined) {
    if (!validPort(override)) throw new Error('port must be an integer from 0 to 65535');
    return override;
  }
  if (envPortOverride !== null) {
    const port = envPortOverride;
    if (!validPort(port)) throw new Error('WALL_PORT must be an integer from 0 to 65535');
    return port;
  }
  return configuredPort;
}

async function performStop({showStatus = true} = {}) {
  const value = server;
  server = null;
  effectivePort = null;
  if (!value) {
    setState('stopped', '服務已停止');
    return state();
  }
  setState('stopping', '正在停止本機服務…');
  await closeWallServer(value);
  writeLog('INFO', '服務已停止');
  setState('stopped', '服務已停止');
  if (showStatus && !isQuitting) await loadStatusPage();
  return state();
}

async function performStart({showStatus = true, touchSettings = true} = {}) {
  if (server?.listening) return state();
  let port;
  try { port = startPort(runtimePortOverride); } catch (error) {
    const message = `服務啟動失敗：${errorText(error)}`;
    writeLog('ERROR', message, error);
    setState('error', message, error);
    await loadStatusPage();
    return state();
  }
  databasePath = path.join(activeProjectFolder, 'wall.db');
  setState('starting', `${settingsNeedsRepair ? '設定檔需要修復；' : ''}正在啟動本機服務（埠 ${port}）…`);
  if (showStatus) await loadStatusPage();
  let candidate;
  try {
    fs.mkdirSync(activeProjectFolder, {recursive: true});
    const options = {dbPath: databasePath, port};
    const aiWorkdir = configuredAiWorkdir();
    if (aiWorkdir) options.chatWorkDir = aiWorkdir;
    candidate = createWallServer(options);
    await waitForListening(candidate);
  } catch (error) {
    await closeWallServer(candidate);
    const occupied = error?.code === 'EADDRINUSE';
    const message = occupied ? `埠 ${port} 已被占用` : `服務啟動失敗：${errorText(error)}`;
    writeLog('ERROR', message, error);
    setState(occupied ? 'port-occupied' : 'error', message, error);
    await loadStatusPage();
    return state();
  }
  server = candidate;
  effectivePort = candidate.address().port;
  cliOpenedSinceStart = false;
  if (touchSettings && !settingsNeedsRepair) {
    const current = recentProject(activeProjectFolder);
    settings = buildSettings(configuredPort, activeProjectFolder, current?.aiWorkdir || null);
    try { writeSettings(settings); } catch (error) { writeLog('ERROR', '最近專案時間無法保存', error); }
  }
  writeLog('INFO', `服務已啟動，埠 ${effectivePort}，DB ${databasePath}`);
  setState('running', `服務已就緒，埠 ${effectivePort}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { await mainWindow.loadURL(`http://127.0.0.1:${effectivePort}/`); } catch (error) {
      writeLog('ERROR', '牆面載入失敗', error);
    }
  }
  return state();
}

function queueService(task) {
  const next = serviceQueue.then(task, task);
  serviceQueue = next.catch(() => {});
  return next;
}

function serviceAction(action) {
  if (!SERVICE_ACTIONS.has(action)) throw new Error('invalid service action');
  return queueService(async () => {
    if (action === 'start') return performStart();
    if (action === 'stop') {
      runtimePortOverride = null;
      return performStop();
    }
    if (action === 'restart') {
      runtimePortOverride = null;
      await performStop();
      return performStart();
    }
    runtimePortOverride = 0;
    await performStop();
    return performStart();
  });
}

async function ensureServiceRunning() {
  if (server?.listening) return state();
  if (serviceStatus === 'port-occupied') runtimePortOverride = 0;
  const result = await performStart({showStatus: false, touchSettings: false});
  if (result.status !== 'running') throw new Error(result.message || '服務無法啟動');
  return result;
}

function spawnClientTerminal(spec) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // Called through the module object so the Electron test can record the terminal launch instead of opening one.
      child = childProcess.spawn(spec.file, spec.args, {cwd: spec.cwd, detached: true, stdio: 'ignore', windowsHide: false});
    } catch (error) {
      reject(error);
      return;
    }
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function openClient(client) {
  if (client !== 'claude' && client !== 'codex') throw new Error('client must be claude or codex');
  return queueService(async () => {
    try {
      await ensureServiceRunning();
      const spec = buildCliLaunch(client, databasePath, effectivePort, effectiveAiWorkdir(), runtimeDir);
      if (spec.error) throw new Error(spec.error);
      await spawnClientTerminal(spec);
      cliOpenedSinceStart = true;
      staleClients = false;
      writeLog('INFO', `已開啟 ${client} CLI，埠 ${effectivePort}，工作目錄 ${spec.cwd}`);
      publishState();
      return state();
    } catch (error) {
      writeLog('ERROR', `${client} CLI 啟動失敗`, error);
      publishState();
      throw error;
    }
  });
}

function restorePreviousSettings(previous) {
  settings = previous.settings;
  settingsNeedsRepair = previous.settingsNeedsRepair;
  activeProjectFolder = previous.activeProjectFolder;
  databasePath = previous.databasePath;
  configuredPort = previous.configuredPort;
  runtimePortOverride = previous.runtimePortOverride;
  envPortOverride = previous.envPortOverride;
}

async function applySettings(input) {
  const next = validateSettingsInput(input);
  const currentAiWorkdir = configuredAiWorkdir();
  const projectChanged = pathKey(next.folder) !== pathKey(activeProjectFolder);
  const changed = projectChanged || next.port !== configuredPort || pathKey(next.aiWorkdir || '') !== pathKey(currentAiWorkdir || '');
  if (!changed && !settingsNeedsRepair) {
    lastApplyError = null;
    publishState();
    return state();
  }

  const previous = {
    settings: structuredClone(settings),
    settingsNeedsRepair,
    activeProjectFolder,
    databasePath,
    configuredPort,
    runtimePortOverride,
    envPortOverride,
    running: Boolean(server?.listening),
    cliOpenedSinceStart,
    staleClients,
  };
  const restartHadCli = changed && previous.running && previous.cliOpenedSinceStart;
  const nextSettings = buildSettings(next.port, next.folder, next.aiWorkdir);

  try {
    if (changed && server?.listening) await performStop({showStatus: false});
    next.folder = ensureDirectory(next.folder, '目前專案');
    if (next.aiWorkdir) next.aiWorkdir = ensureDirectory(next.aiWorkdir, 'AI 工作資料夾');
    settings = nextSettings;
    settingsNeedsRepair = false;
    activeProjectFolder = next.folder;
    // WALL_PORT holds for every restart until the user picks a port in settings.
    if (next.port !== configuredPort) envPortOverride = null;
    configuredPort = next.port;
    databasePath = path.join(activeProjectFolder, 'wall.db');
    runtimePortOverride = null;
    if (changed || !server?.listening) {
      const result = await performStart({showStatus: false, touchSettings: false});
      if (result.status !== 'running') throw new Error(result.message || '服務無法啟動');
      if (restartHadCli) staleClients = true;
    }
    writeSettings(settings);
    lastApplyError = null;
    publishState();
    return state();
  } catch (error) {
    const failedMessage = errorText(error);
    lastApplyError = {message: failedMessage, at: new Date().toISOString()};
    writeLog('ERROR', `設定套用失敗：${failedMessage}`, error);
    if (server?.listening && changed) {
      await performStop({showStatus: false});
    }
    restorePreviousSettings(previous);
    if (previous.running && !server?.listening) {
      const restored = await performStart({showStatus: false, touchSettings: false});
      if (restored.status !== 'running') writeLog('ERROR', '設定失敗後無法恢復原服務', restored.error || restored.message);
    }
    cliOpenedSinceStart = previous.cliOpenedSinceStart;
    staleClients = previous.staleClients;
    publishState();
    throw new Error(`設定套用失敗：${failedMessage}`);
  }
}

function openSettingsInRenderer() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send('casegraph:open-settings'); } catch {}
}

async function requestSettings() {
  if (settingsRequestQueued) return state();
  settingsRequestQueued = true;
  try {
    return await queueService(async () => {
      if (!server?.listening) {
        try { await ensureServiceRunning(); } catch { return state(); }
      }
      const wallUrl = `http://127.0.0.1:${effectivePort}/`;
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.getURL() !== wallUrl) {
        await mainWindow.loadURL(wallUrl);
      }
      showWindow();
      openSettingsInRenderer();
      return state();
    });
  } finally {
    settingsRequestQueued = false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: APP_TITLE,
    icon: ICON_PATHS.window,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow.on('close', event => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
    notifyHidden();
  });
  // Card source links open in the system browser; the app window only ever shows the local wall or the status page,
  // because both get the preload bridge.
  const openOutside = url => { if (/^https?:/i.test(url)) void shell.openExternal(url).catch(error => writeLog('ERROR', '無法開啟連結', error)); };
  mainWindow.webContents.setWindowOpenHandler(({url}) => { openOutside(url); return {action: 'deny'}; });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (effectivePort && url.startsWith(`http://127.0.0.1:${effectivePort}/`)) return;
    event.preventDefault();
    openOutside(url);
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.once('ready-to-show', () => { if (!isQuitting) mainWindow.show(); });
  void loadStatusPage();
}

function createTray() {
  const image = nativeImage.createFromPath(ICON_PATHS.tray);
  tray = new Tray(image);
  tray.setToolTip(APP_TITLE);
  tray.on('double-click', showWindow);
  updateTrayMenu();
}

function validSender(event) {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) throw new Error('invalid IPC sender');
}

function registerIpc() {
  ipcMain.handle('casegraph:get-state', (event, ...args) => {
    validSender(event);
    if (args.length) throw new Error('getState takes no arguments');
    return state();
  });
  ipcMain.handle('casegraph:service', (event, action) => {
    validSender(event);
    if (typeof action !== 'string' || !SERVICE_ACTIONS.has(action)) throw new Error('invalid service action');
    return serviceAction(action);
  });
  ipcMain.handle('casegraph:save-settings', (event, input) => {
    validSender(event);
    return queueService(() => applySettings(input));
  });
  ipcMain.handle('casegraph:open-client', (event, client) => {
    validSender(event);
    if (client !== 'claude' && client !== 'codex') throw new Error('client must be claude or codex');
    return openClient(client);
  });
  ipcMain.handle('casegraph:clear-apply-error', event => {
    validSender(event);
    lastApplyError = null;
    publishState();
    return state();
  });
  ipcMain.handle('casegraph:pick-directory', async (event, kind) => {
    validSender(event);
    if (kind !== 'project' && kind !== 'aiWorkdir') throw new Error('invalid directory kind');
    const current = kind === 'project' ? activeProjectFolder : effectiveAiWorkdir();
    const result = await dialog.showOpenDialog(mainWindow, {
      title: kind === 'project' ? '選擇 CaseGraph 專案資料夾' : '選擇 AI 工作資料夾',
      defaultPath: current,
      properties: ['openDirectory', 'createDirectory'],
    });
    return {canceled: result.canceled, path: result.canceled ? null : result.filePaths[0] || null};
  });
  ipcMain.handle('casegraph:open-log-folder', event => {
    validSender(event);
    return shell.openPath(logDir);
  });
  ipcMain.handle('casegraph:open-settings', event => {
    validSender(event);
    return requestSettings();
  });
}

function shutdown() {
  if (shutdownTask) return shutdownTask;
  shutdownTask = (async () => {
    writeLog('INFO', '開始結束 CaseGraph');
    try { await queueService(performStop); } finally {
      tray?.destroy();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
      writeLog('INFO', 'CaseGraph 已完成服務與資料庫關閉');
      app.exit(0);
    }
  })();
  return shutdownTask;
}

function main() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => showWindow());
  app.on('before-quit', event => {
    if (isQuitting) return;
    event.preventDefault();
    isQuitting = true;
    void shutdown();
  });
  app.whenReady().then(() => {
    // Must equal package.json build.appId: the installer's shortcuts carry it, and Windows matches the taskbar icon by it.
    app.setAppUserModelId('tw.casegraph.app');
    Menu.setApplicationMenu(null);
    caseGraphDir = path.join(app.getPath('userData'), 'CaseGraph');
    settingsPath = path.join(caseGraphDir, 'settings.json');
    defaultProjectFolder = path.join(caseGraphDir, 'projects', 'default');
    runtimeDir = path.join(caseGraphDir, 'runtime');
    logDir = path.join(caseGraphDir, 'logs');
    logPath = path.join(logDir, 'main.log');
    fs.mkdirSync(caseGraphDir, {recursive: true});
    settings = readSettings();
    configuredPort = settings.port;
    activeProjectFolder = settings.activeProjectFolder;
    databasePath = path.join(activeProjectFolder, 'wall.db');
    writeLog('INFO', `Electron 啟動，Node ${process.versions.node}`);
    if (settingsNeedsRepair) writeLog('ERROR', '設定檔需要修復');
    registerIpc();
    createWindow();
    createTray();
    void queueService(performStart);
  }).catch(error => {
    console.error(`CaseGraph startup failed: ${errorText(error)}`);
    app.quit();
  });
}

main();
