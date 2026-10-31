const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { spawn } = require('node:child_process');
const playwright = require('playwright-core');

const out = process.env.WALL_TEST_OUT || path.join(__dirname, '..', 'test-results', 'server');
fs.mkdirSync(out, {recursive: true});

function start(db) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
      cwd: path.join(__dirname, '..'), env: {...process.env, WALL_DB: db, WALL_PORT: '0'},
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
    child.once('exit', code => done(new Error('server exited before ready: ' + code)));
    timer = setTimeout(() => done(new Error('server did not start')), 30000);
  });
}

function stop(server) {
  return new Promise(resolve => {
    if (server.child.exitCode != null) { resolve(); return; }
    server.child.once('exit', resolve);
    server.child.kill();
  });
}

function request(base, pathname, method = 'GET', value, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base);
    const body = value === undefined ? '' : JSON.stringify(value);
    const req = http.request({hostname: url.hostname, port: url.port, path: url.pathname + url.search, method,
      headers: {...(value === undefined ? {} : {'content-type': 'application/json', 'content-length': Buffer.byteLength(body)}), ...headers}}, res => {
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

(async () => {
  const db = path.join(fs.mkdtempSync(path.join(out, 'db-')), 'wall.db');
  let server = await start(db);
  try {
    const seed = {cards: [{id: 'card', title: 'before'}], edges: [], bands: [], tags: []};
    let response = await request(server.url, '/api/walls/w-main', 'PUT', {id: 'w-main', name: 'Main', data: seed, version: null});
    assert.equal(response.status, 200);
    assert.equal(response.body.version, 1);
    response = await request(server.url, '/api/walls/w-main', 'PUT', {id: 'w-main', name: 'Main', data: {...seed, cards: [{id: 'card', title: 'after'}]}, version: 1});
    assert.equal(response.status, 200);
    assert.equal(response.body.version, 2);
    response = await request(server.url, '/api/walls/w-main', 'PUT', {id: 'w-main', name: 'Main', data: seed, version: 1});
    assert.equal(response.status, 409, 'stale base version is rejected');
    console.log('PASS 409 version conflict');

    response = await request(server.url, '/api/walls/%E0');
    assert.equal(response.status, 400);
    console.log('PASS malformed URL returns 400');

    const port = new URL(server.url).port;
    response = await request(server.url, '/api', 'GET', undefined, {host: 'localhost:' + port, origin: 'http://localhost:' + port});
    assert.equal(response.status, 200, 'localhost Host and Origin are accepted');
    response = await request(server.url, '/api', 'GET', undefined, {host: 'evil.example:' + port});
    assert.equal(response.status, 403, 'unexpected Host is rejected');
    response = await request(server.url, '/api', 'GET', undefined, {origin: 'http://evil.example'});
    assert.equal(response.status, 403, 'unexpected Origin is rejected');
    console.log('PASS Host and Origin checks');

    await stop(server);
    server = await start(db);
    response = await request(server.url, '/api/walls/w-main');
    assert.equal(response.status, 200);
    assert.equal(response.body.data.cards[0].title, 'after');
    console.log('PASS data survives server restart');
    await stop(server);
    server = null;
    const integrity = new DatabaseSync(db);
    const check = integrity.prepare('PRAGMA integrity_check').get().integrity_check;
    const journalMode = integrity.prepare('PRAGMA journal_mode').get().journal_mode;
    integrity.close();
    assert.equal(check, 'ok');
    console.log('PASS PRAGMA integrity_check = ok');
    assert.equal(journalMode, 'wal');
    console.log('PASS PRAGMA journal_mode = wal');

    server = await start(db);
    const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
    try {
      const page = await browser.newPage({viewport: {width: 1400, height: 900}});
      await page.goto(server.url); await page.waitForFunction(() => window.wallReady === true);
      await page.evaluate(async () => {
        data.cards[0].title = 'UI authority'; render(); await save(true);
      });
      response = await request(server.url, '/api');
      assert.equal(response.body.data.cards[0].title, 'UI authority');
      const wall = response.body.wall;
      wall.data.cards[0].title = 'API authority';
      response = await request(server.url, '/api/walls/w-main', 'PUT', {id: wall.id, name: wall.name, data: wall.data, version: wall.version});
      assert.equal(response.status, 200);
      await page.reload(); await page.waitForFunction(() => window.wallReady === true);
      assert.equal(await page.locator('.card[data-id="card"] h3').textContent(), 'API authority');
      console.log('PASS D1 UI/API authority round trip');
      await browser.close();
    } catch (error) {
      await browser.close();
      throw error;
    }
  } finally {
    if (server) await stop(server);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
