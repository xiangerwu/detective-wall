const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {serverBin} = require('./runtime.cjs');
// Standalone Rust suites manage their own servers and run separately.
const all = fs.readdirSync(__dirname).filter(name => name.endsWith('.cjs') && !name.startsWith('rust-') && !['run.cjs', 'runtime.cjs', 'wall-ready.cjs'].includes(name)).sort();
const args = process.argv.slice(2);
const selected = [];
let jobs = Math.min(4, Math.max(2, Math.floor(os.cpus().length / 2)));
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--jobs') {
    const value = args[++index];
    if (!/^\d+$/.test(value || '')) throw new Error('--jobs requires a positive integer');
    jobs = Number(value);
  } else if (arg.startsWith('--jobs=')) {
    if (!/^\d+$/.test(arg.slice(7))) throw new Error('--jobs requires a positive integer');
    jobs = Number(arg.slice(7));
  } else selected.push(arg);
}
if (!Number.isSafeInteger(jobs) || jobs < 1) throw new Error('--jobs requires a positive integer');
const suites = selected.length ? selected.map(name => name.endsWith('.cjs') ? name : name + '.cjs') : all;
if (suites.some(name => !all.includes(name))) throw new Error('Unknown suite; choose: ' + all.join(', '));
const root = path.resolve(process.env.WALL_TEST_ROOT || path.join(__dirname, '..', 'test-results'));

function startServer(db, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(serverBin, [], {
      cwd: path.join(__dirname, '..'),
      env: {...process.env, ...extraEnv, WALL_DB: db, WALL_PORT: '0'},
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', timer, settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      const match = output.match(/WALL_READY (\d+)/);
      if (match) done(null, {child, url: `http://127.0.0.1:${match[1]}`});
    });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.once('error', done);
    child.once('exit', code => done(new Error('wall server exited before ready: ' + code)));
    timer = setTimeout(() => done(new Error('wall server did not start')), 30000);
  });
}

function stopServer(child) {
  return new Promise(resolve => {
    if (child.exitCode != null) { resolve(); return; }
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    child.once('exit', done);
    child.kill();
    setTimeout(done, 5000).unref();
  });
}

function runChild(command, args, options, timeout) {
  return new Promise(resolve => {
    const child = spawn(command, args, options);
    let stdout = '', stderr = '', timedOut = false, timer;
    child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    const finish = (code, signal) => {
      clearTimeout(timer);
      resolve({code, signal, stdout, stderr, timedOut});
    };
    child.once('error', error => finish(null, error.code || 'error'));
    child.once('close', finish);
    timer = setTimeout(() => {
      if (child.exitCode !== null) return;
      timedOut = true;
      child.kill();
    }, timeout);
  });
}

async function runSuite(suite) {
  const startedAt = Date.now();
  const suiteRoot = path.join(root, suite.replace('.cjs', ''));
  fs.mkdirSync(suiteRoot, {recursive: true});
  const out = fs.mkdtempSync(path.join(suiteRoot, 'run-'));
  const temp = path.join(out, 'temp');
  fs.mkdirSync(temp, {recursive: true});
  const chatEnv = (suite === 'chat.cjs' || suite.startsWith('tour')) ? {
    WALL_CLAUDE_BIN: path.join(__dirname, 'fake-chat-cli.js'),
    WALL_CODEX_BIN: path.join(__dirname, 'fake-chat-cli.js'),
    WALL_FAKE_CLI_LOG: path.join(out, 'fake-cli.jsonl'),
    WALL_FAKE_HEARTBEAT: path.join(out, 'fake-heartbeat.log'),
    // Long enough for a fake CLI to start and for the browser to click 停止 before the timeout fires; 150 ms raced on a busy machine.
    WALL_CHAT_TIMEOUT_MS: '2000',
  } : {};
  const pickerEnv = suite === 'picker.cjs' ? {
    WALL_PICK_FOLDER_BIN: path.join(__dirname, 'fake-pick-folder.js'),
    WALL_FAKE_PICK_FOLDER_PATH: path.join(out, 'picked-folder'),
    WALL_FAKE_PICK_FOLDER_DELAY_MS: '500',
  } : {};
  const suiteEnv = {...chatEnv, ...pickerEnv};
  let server;
  let run;
  try {
    server = await startServer(path.join(temp, 'wall.db'), suiteEnv);
    run = await runChild(process.execPath, [path.join(__dirname, suite)], {
      cwd: path.join(__dirname, '..'),
      env: {...process.env, ...suiteEnv, WALL_TEST_BROWSER: process.env.WALL_TEST_BROWSER || 'chromium', WALL_TEST_OUT: out, WALL_TEST_URL: server.url, TEMP: temp, TMP: temp, TMPDIR: temp},
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }, 180000);
  } catch (error) {
    run = {code: null, signal: 'runner', stdout: '', stderr: String(error?.stack || error), timedOut: false};
  } finally {
    if (server) await stopServer(server.child);
  }
  const output = (run.stdout || '') + (run.stderr || '');
  fs.writeFileSync(path.join(out, 'execution.log'), output);
  const result = {suite, passed: run.code === 0 && !run.timedOut, exitCode: run.code,
    signal: run.signal || null, timedOut: run.timedOut, checks: (output.match(/^PASS /gm) || []).length,
    failures: (output.match(/^FAIL /gm) || []).length, durationMs: Date.now() - startedAt, artifacts: out};
  return result;
}

(async () => {
  const results = [], startedAt = Date.now();
  fs.mkdirSync(root, {recursive: true});
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= suites.length) return;
      const result = await runSuite(suites[index]);
      results[index] = result;
      console.log(JSON.stringify(result));
    }
  }
  await Promise.all(Array.from({length: Math.min(jobs, suites.length)}, worker));
  const summary = {jobs, elapsedMs: Date.now() - startedAt, suites: results};
  fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`RUN_TIME ${summary.elapsedMs} ms jobs=${jobs}`);
  process.exitCode = results.every(result => result.passed) ? 0 : 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
