const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {spawn} = require('node:child_process');
const playwright = require('playwright-core');
const {openActivity} = require('./wall-ready.cjs');

const out = process.env.WALL_TEST_OUT;
const base = process.env.WALL_TEST_URL;
const fakePicker = path.join(__dirname, 'fake-pick-folder.js');

function request(serverBase, pathname, method = 'GET', value, origin) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, serverBase), body = value === undefined ? '' : JSON.stringify(value);
    const headers = {};
    if (value !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }
    if (origin) headers.origin = origin;
    const req = http.request({hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = text;
        try { parsed = JSON.parse(text); } catch {}
        resolve({status: res.statusCode, body: parsed});
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function startServer(dbPath, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
      cwd: path.join(__dirname, '..'),
      env: {...process.env, ...env, WALL_DB: dbPath, WALL_PORT: '0'},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', timer;
    const done = (error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value); };
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/WALL_READY (\d+)/);
      if (match) done(null, {child, url: 'http://127.0.0.1:' + match[1]});
    });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', done);
    child.once('exit', code => done(new Error('wall server exited before ready: ' + code)));
    timer = setTimeout(() => done(new Error('wall server did not start')), 30000);
  });
}

function stopServer(server) {
  return new Promise(resolve => {
    if (server.child.exitCode != null) return resolve();
    server.child.once('exit', resolve);
    server.child.kill();
  });
}

async function withServer(name, env, action) {
  const server = await startServer(path.join(out, `${name}-${Date.now()}-${process.pid}`, 'wall.db'), env);
  try { return await action(server); } finally { await stopServer(server); }
}

(async () => {
  const selectedPath = process.env.WALL_FAKE_PICK_FOLDER_PATH;
  assert.ok(selectedPath);

  let response = await request(base, '/api/pick-folder', 'POST');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {path: selectedPath});
  console.log('PASS picker endpoint returns the selected UTF-8 path from the fake picker');

  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    await page.goto(base);
    await page.waitForFunction(() => window.wallReady === true);
    await openActivity(page, 'sources');
    await page.click('#source-folders-browse');
    await page.waitForFunction(() => {
      const button = document.querySelector('#source-folders-browse');
      return button?.disabled && button.textContent.includes('等待選擇');
    });
    await page.waitForFunction(pathValue => [...document.querySelectorAll('#source-folder-list .source-folder-row')]
      .some(row => row.dataset.path === pathValue), selectedPath);
    assert.equal(await page.locator('#source-folder-list .source-folder-row').count(), 1);
    assert.deepEqual((await request(base, '/api/meta/sourceFolders')).body.value, [selectedPath]);
    console.log('PASS 瀏覽… waits, disables controls, adds the path, and saves through the existing flow');
  } finally {
    await browser.close();
  }

  await withServer('cancel', {WALL_PICK_FOLDER_BIN: fakePicker, WALL_FAKE_PICK_FOLDER_MODE: 'cancel'}, async server => {
    response = await request(server.url, '/api/pick-folder', 'POST');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {cancelled: true});
    console.log('PASS picker cancellation returns cancelled without a path');
  });

  await withServer('busy', {
    WALL_PICK_FOLDER_BIN: fakePicker,
    WALL_FAKE_PICK_FOLDER_MODE: 'busy',
    WALL_FAKE_PICK_FOLDER_DELAY_MS: '500',
    WALL_FAKE_PICK_FOLDER_PATH: selectedPath,
  }, async server => {
    const first = request(server.url, '/api/pick-folder', 'POST');
    await sleep(80);
    response = await request(server.url, '/api/pick-folder', 'POST');
    assert.equal(response.status, 409);
    assert.match(response.body.error, /資料夾選擇/);
    assert.deepEqual((await first).body, {path: selectedPath});
    console.log('PASS a second picker request is rejected while the first is busy');
  });

  await withServer('missing', {WALL_PICK_FOLDER_BIN: path.join(out, 'missing-picker.exe')}, async server => {
    response = await request(server.url, '/api/pick-folder', 'POST');
    assert.equal(response.status, 501);
    assert.match(response.body.error, /WALL_PICK_FOLDER_BIN|找不到/);
    console.log('PASS a missing picker reports a recognizable 501 error');
  });

  response = await request(base, '/api/pick-folder', 'POST', undefined, 'http://attacker.example');
  assert.equal(response.status, 403);
  console.log('PASS picker endpoint enforces the existing same-origin check');
})().catch(error => { console.error(error); process.exitCode = 1; });
