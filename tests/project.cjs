const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {spawn} = require('node:child_process');
const playwright = require('playwright-core');
const {openActivity} = require('./wall-ready.cjs');

const out = process.env.WALL_TEST_OUT || path.join(__dirname, '..', 'test-results', 'project');
fs.mkdirSync(out, {recursive: true});

function start(db) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
      cwd: path.join(__dirname, '..'), env: {...process.env, WALL_DB: db, WALL_PORT: '0'}, stdio: ['ignore', 'pipe', 'pipe'],
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
    if (server.child.exitCode != null) return resolve();
    server.child.once('exit', resolve);
    server.child.kill();
  });
}

function request(base, pathname, method = 'GET', value) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base), body = value === undefined ? '' : JSON.stringify(value);
    const headers = value === undefined ? {} : {'content-type': 'application/json', 'content-length': Buffer.byteLength(body)};
    const req = http.request({hostname: url.hostname, port: url.port, path: url.pathname, method, headers}, res => {
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

const comparable = project => ({walls: project.walls, images: project.images, meta: project.meta});
const seed = {bands: [], tags: [], cards: [{id: 'card', kind: 'card', x: 100, y: 100, title: '原本', note: '', links: []}], edges: []};

(async () => {
  const db = path.join(fs.mkdtempSync(path.join(out, 'db-')), 'wall.db');
  let server = await start(db);
  try {
    const original = {format: 'detective-wall-project', formatVersion: 1, exportedAt: new Date().toISOString(),
      walls: [{id: 'w-main', name: '主牆', updated: 1700000000000, version: 1, data: seed}],
      images: [{id: 'image-1', blob: {type: 'image/png', base64: 'AA=='}, type: 'image/png', width: 1, height: 1}],
      meta: {currentWall: 'w-main', tabs: {order: ['w-main'], colors: {}}}};
    let response = await request(server.url, '/api/project', 'PUT', original);
    assert.equal(response.status, 200);
    const exported = (await request(server.url, '/api/project')).body;
    assert.deepEqual(comparable(exported), comparable(original));

    const freshDb = path.join(fs.mkdtempSync(path.join(out, 'fresh-')), 'wall.db');
    const fresh = await start(freshDb);
    try {
      response = await request(fresh.url, '/api/project', 'PUT', exported);
      assert.equal(response.status, 200);
      const restored = (await request(fresh.url, '/api/project')).body;
      assert.deepEqual(comparable(restored), comparable(exported));
    } finally { await stop(fresh); }
    console.log('PASS project export and restore preserve walls, images and meta');

    const before = (await request(server.url, '/api/project')).body;
    const missingData = structuredClone(before);
    delete missingData.walls[0].data;
    response = await request(server.url, '/api/project', 'PUT', missingData);
    assert.equal(response.status >= 400 && response.status < 500, true);
    assert.deepEqual(comparable((await request(server.url, '/api/project')).body), comparable(before));
    const duplicate = structuredClone(before);
    duplicate.walls.push(structuredClone(duplicate.walls[0]));
    response = await request(server.url, '/api/project', 'PUT', duplicate);
    assert.equal(response.status >= 400 && response.status < 500, true);
    assert.deepEqual(comparable((await request(server.url, '/api/project')).body), comparable(before));
    console.log('PASS malformed project is rejected without changing the database');

    const restore = structuredClone(exported);
    restore.exportedAt = new Date().toISOString();
    restore.walls[0].data.cards[0].title = '還原後';
    const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
    try {
      const page = await browser.newPage({viewport: {width: 1400, height: 900}});
      await page.goto(server.url); await page.waitForFunction(() => window.wallReady === true); await openActivity(page, 'files');
      assert.equal(await page.locator('#export-project').isVisible(), true);
      assert.equal(await page.locator('#import-project').isVisible(), true);
      let navigations = 0;
      page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
      await page.click('#import-project');
      await page.setInputFiles('#project-file', {name: 'project.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(restore))});
      await page.click('#import-project');
      await page.waitForFunction(() => !wallBusy && document.querySelector('.card[data-id="card"] h3')?.textContent === '還原後');
      assert.equal(navigations, 0);
      console.log('PASS UI project restore updates the visible wall without reload');
    } finally { await browser.close(); }
  } finally { if (server) await stop(server); }
})().catch(error => { console.error(error); process.exitCode = 1; });
