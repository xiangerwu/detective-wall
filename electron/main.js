'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  nativeImage,
  shell,
  ipcMain,
} = require('electron');
const {createWallServer} = require('../server/server.js');

const APP_TITLE = 'CaseGraph 案件圖譜';
const DEFAULT_PORT = 3000;
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
let logDir;
let logPath;
let activeProjectFolder;
let databasePath;
let configuredPort = DEFAULT_PORT;
let effectivePort = null;
let runtimePortOverride = null;
let settingsNeedsRepair = false;
let serviceStatus = 'starting';
let serviceMessage = '正在啟動本機服務…';
let lastError = null;
let hideNotified = false;
let isQuitting = false;
let shutdownTask;
let serviceQueue = Promise.resolve();

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

function readLogTail() {
  try {
    return fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).slice(-200);
  } catch {
    return [];
  }
}

function defaultSettings() {
  return {schemaVersion: 1, port: DEFAULT_PORT, activeProjectFolder: defaultProjectFolder};
}

function validPort(value) {
  return Number.isInteger(value) && value >= 0 && value <= 65535;
}

function readSettings() {
  const fallback = defaultSettings();
  if (!fs.existsSync(settingsPath)) return fallback;
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || (parsed.schemaVersion !== undefined && parsed.schemaVersion !== 1)
      || !validPort(parsed.port)
      || typeof parsed.activeProjectFolder !== 'string'
      || !path.isAbsolute(parsed.activeProjectFolder)) {
      throw new Error('settings schema is invalid');
    }
    return {schemaVersion: 1, port: parsed.port, activeProjectFolder: path.resolve(parsed.activeProjectFolder)};
  } catch (error) {
    settingsNeedsRepair = true;
    writeLog('ERROR', '設定檔需要修復；已使用預設設定', error);
    return fallback;
  }
}

function state() {
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
    logPath,
    logs: readLogTail(),
    nodeVersion: process.versions.node,
    electronVersion: process.versions.electron || null,
  };
}

function updateTrayMenu() {
  if (!tray) return;
  const running = serviceStatus === 'running' || serviceStatus === 'starting' || serviceStatus === 'stopping';
  tray.setContextMenu(Menu.buildFromTemplate([
    {label: '顯示 CaseGraph', click: showWindow},
    {label: '重新啟動服務', enabled: !isQuitting, click: () => serviceAction('restart')},
    {label: running ? '停止服務' : '啟動服務', enabled: !isQuitting, click: () => serviceAction(running ? 'stop' : 'start')},
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
    writeLog('ERROR', '狀態頁載入失敗', error);
  }
}

async function closeWallServer(value) {
  if (!value) return;
  try { await value.stopChats?.(); } catch (error) { writeLog('ERROR', '停止聊天 CLI 失敗', error); }
  if (value.listening) {
    await new Promise(resolve => value.close(error => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') writeLog('ERROR', '停止服務失敗', error);
      resolve();
    }));
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
  if (process.env.WALL_PORT !== undefined && process.env.WALL_PORT !== '') {
    const port = Number(process.env.WALL_PORT);
    if (!validPort(port)) throw new Error('WALL_PORT must be an integer from 0 to 65535');
    return port;
  }
  return configuredPort;
}

async function performStop() {
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
  if (!isQuitting) await loadStatusPage();
  return state();
}

async function performStart() {
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
  await loadStatusPage();
  let candidate;
  try {
    fs.mkdirSync(activeProjectFolder, {recursive: true});
    candidate = createWallServer({dbPath: databasePath, port});
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

function createWindow() {
  mainWindow = new BrowserWindow({
    title: APP_TITLE,
    icon: path.join(__dirname, '..', 'assets', 'icon', 'icon.ico'),
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
  const image = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon', 'icon-16.png'));
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
    caseGraphDir = path.join(app.getPath('userData'), 'CaseGraph');
    settingsPath = path.join(caseGraphDir, 'settings.json');
    defaultProjectFolder = path.join(caseGraphDir, 'projects', 'default');
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
