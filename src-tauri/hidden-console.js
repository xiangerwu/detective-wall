'use strict';

// Preloaded (node -r) into an external CLI's Node entry on Windows.
// The desktop app has no console, so a console program that entry starts (codex.js starts codex.exe) would open
// a visible terminal window. Hidden by default, that program gets a windowless console its own children share.
const childProcess = require('node:child_process');

// Node's native spawn hook is used by both spawn() and execFile(), but is absent from @types/node.
const prototype = /** @type {typeof childProcess.ChildProcess.prototype & {spawn(options: object): unknown}} */ (childProcess.ChildProcess.prototype);
const spawn = prototype.spawn;
prototype.spawn = function (options) {
  return spawn.call(this, {...options, windowsHide: true});
};
