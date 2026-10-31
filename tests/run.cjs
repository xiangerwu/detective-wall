const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const all = fs.readdirSync(__dirname).filter(name => name.endsWith('.cjs') && !['run.cjs', 'wall-ready.cjs'].includes(name)).sort();
const selected = process.argv.slice(2);
const suites = selected.length ? selected.map(name => name.endsWith('.cjs') ? name : name + '.cjs') : all;
if (suites.some(name => !all.includes(name))) throw new Error('Unknown suite; choose: ' + all.join(', '));
const root = path.resolve(process.env.WALL_TEST_ROOT || path.join(__dirname, '..', 'test-results'));

function startServer(db, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
      cwd: path.join(__dirname, '..'),
      env: {...process.env, ...extraEnv, WALL_DB: db, WALL_PORT: '0'},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', timer;
    const done = (error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value); };
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/WALL_READY (\d+)/);
      if (match) done(null, {child, url: `http://127.0.0.1:${match[1]}`});
    });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', done);
    child.once('exit', code => done(new Error('wall server exited before ready: ' + code)));
    timer = setTimeout(() => done(new Error('wall server did not start')), 30000);
  });
}

// Each suite's temp DB and Firefox profiles are scratch: cleared before a run so no old wall.db leaks in,
// and after a passing run so repeated runs do not pile up tens of MB each. A failing run keeps them for debugging.
function clearScratch(out) {
  if (!fs.existsSync(out)) return;
  for (const name of fs.readdirSync(out)) {
    if (name === 'temp' || name.startsWith('wall-ffprof-')) fs.rmSync(path.join(out, name), {recursive: true, force: true});
  }
}

function stopServer(child) {
  return new Promise(resolve => {
    if (child.exitCode != null) { resolve(); return; }
    child.once('exit', resolve);
    child.kill();
  });
}

(async () => {
  const results = [];
  fs.mkdirSync(root, {recursive: true});
  for (const suite of suites) {
    const out = path.join(root, suite.replace('.cjs', ''));
    const temp = path.join(out, 'temp');
    clearScratch(out);
    fs.mkdirSync(temp, {recursive: true});
    const chatEnv = suites.includes('chat.cjs') ? {
      WALL_CLAUDE_BIN: path.join(__dirname, 'fake-chat-cli.js'),
      WALL_CODEX_BIN: path.join(__dirname, 'fake-chat-cli.js'),
      WALL_FAKE_CLI_LOG: path.join(out, 'fake-cli.jsonl'),
      WALL_FAKE_HEARTBEAT: path.join(out, 'fake-heartbeat.log'),
      // Long enough for a fake CLI to start and for Firefox to click 停止 before the timeout fires; 150 ms raced on a busy machine.
      WALL_CHAT_TIMEOUT_MS: '2000',
    } : {};
    const pickerEnv = suites.includes('picker.cjs') ? {
      WALL_PICK_FOLDER_BIN: path.join(__dirname, 'fake-pick-folder.js'),
      WALL_FAKE_PICK_FOLDER_PATH: path.join(out, 'picked-folder'),
      WALL_FAKE_PICK_FOLDER_DELAY_MS: '500',
    } : {};
    const suiteEnv = {...chatEnv, ...pickerEnv};
    const server = await startServer(path.join(temp, 'wall.db'), suiteEnv);
    const run = spawnSync(process.execPath, [path.join(__dirname, suite)], {
      encoding: 'utf8', timeout: 180000,
      env: {...process.env, ...suiteEnv, WALL_TEST_OUT: out, WALL_TEST_URL: server.url, TEMP: temp, TMP: temp, TMPDIR: temp},
    });
    await stopServer(server.child);
    const output = (run.stdout || '') + (run.stderr || '') + (run.error ? '\n' + run.error.message : '');
    fs.writeFileSync(path.join(out, 'execution.log'), output);
    const result = {suite, passed: run.status === 0, exitCode: run.status,
      checks: (output.match(/^PASS /gm) || []).length, failures: (output.match(/^FAIL /gm) || []).length};
    if (result.passed) clearScratch(out);
    results.push(result);
    console.log(JSON.stringify(result));
  }
  fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(results, null, 2));
  process.exitCode = results.every(result => result.passed) ? 0 : 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
