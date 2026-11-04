'use strict';

// Preloaded (node -r) into a CLI's Node entry when the app runs inside Electron on Windows.
// Electron has no console, so a console program that entry starts (codex.js starts codex.exe) would open
// a visible terminal window. Hidden by default, that program gets a windowless console its own children share.
const childProcess = require('node:child_process');

const spawn = childProcess.ChildProcess.prototype.spawn;
childProcess.ChildProcess.prototype.spawn = function (options) {
  return spawn.call(this, {...options, windowsHide: true});
};
