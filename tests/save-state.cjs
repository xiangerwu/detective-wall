const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const playwright = require('playwright-core');

const out = process.env.WALL_TEST_OUT || path.join(__dirname, '..', 'test-results', 'save-state');
fs.mkdirSync(out, {recursive: true});

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

async function updateWall(base, title) {
  const response = await request(base, '/api/walls/w-main');
  const data = structuredClone(response.body.data);
  data.cards[0].title = title;
  const result = await request(base, '/api/walls/w-main', 'PUT', {
    id: response.body.id, name: response.body.name, data, version: response.body.version,
  });
  assert.equal(result.status, 200);
  return result.body;
}

const browserName = process.env.WALL_TEST_BROWSER || 'firefox';
(async () => {
  const browser = await playwright[browserName].launch();
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    const base = process.env.WALL_TEST_URL;
    await page.goto(base); await page.waitForFunction(() => window.wallReady === true);

    await page.evaluate(async () => { data.cards[0].title = '已編輯'; render(); await save(true); });
    await page.waitForFunction(() => document.querySelector('#save-state').textContent.startsWith('已保存'));
    console.log('PASS save-state shows 已保存 after a confirmed edit');

    await page.evaluate(() => {
      window.__realWallFetch = window.fetch;
      window.fetch = () => Promise.reject(new Error('forced service failure'));
    });
    await page.evaluate(async () => { data.cards[0].title = '離線修改'; render(); await save(true); });
    await page.waitForFunction(() => document.querySelector('#storage-warning').textContent.includes('本機服務無法連線')
      && document.querySelector('#save-state').textContent === '未保存的變更');
    assert.equal(await page.locator('#storage-retry').textContent(), '重試');
    console.log('PASS failed fetch shows unreachable warning and unsaved state');

    await page.evaluate(() => { window.fetch = (...args) => window.__realWallFetch(...args); });
    await page.click('#storage-retry');
    await page.waitForFunction(() => document.querySelector('#save-state').textContent.startsWith('已保存'));
    assert.equal((await request(base, '/api/walls/w-main')).body.data.cards[0].title, '離線修改');
    console.log('PASS retry restores the pending edit and confirms the save');

    await updateWall(base, 'API 最新版');
    await page.evaluate(async () => { data.cards[0].title = '我的衝突修改'; render(); await save(true); });
    await page.waitForFunction(() => document.querySelector('#storage-warning').textContent.includes('這面牆已在其他分頁或由 API 修改。'));
    assert.equal(await page.locator('#storage-latest').isVisible(), true);
    assert.equal(await page.locator('#storage-keep').isVisible(), true);
    console.log('PASS version conflict shows the recoverable conflict controls');

    await page.click('#storage-latest');
    await page.waitForFunction(() => !wallBusy && data.cards[0].title === 'API 最新版');
    console.log('PASS 載入最新版 discards local changes and shows the API version');

    const beforeKeep = (await request(base, '/api/walls/w-main')).body;
    await page.evaluate(() => { data.cards[0].title = '我的保留修改'; render(); });
    await updateWall(base, '外部第二次修改');
    await page.evaluate(async () => { await save(true); });
    await page.waitForFunction(() => document.querySelector('#storage-warning').textContent.includes('這面牆已在其他分頁或由 API 修改。'));
    await page.click('#storage-keep');
    await page.waitForFunction(() => !wallBusy && document.querySelector('#save-state').textContent.startsWith('已保存'));
    const held = (await request(base, '/api/walls/w-main')).body;
    assert.equal(held.data.cards[0].title, '我的保留修改');
    const backups = (await request(base, '/api/walls/w-main/backups')).body;
    assert.ok(backups.length >= 1);
    const overwritten = (await request(base, '/api/backups/' + backups[0].id)).body;
    assert.equal(overwritten.data.cards[0].title, '外部第二次修改');
    assert.ok(held.version > beforeKeep.version);
    console.log('PASS 保留我的修改 backs up the overwritten version and updates the server');

    await page.evaluate(async () => { data.cards[0].title = '後續保存'; render(); await save(true); });
    await page.waitForFunction(() => document.querySelector('#save-state').textContent.startsWith('已保存'));
    assert.equal((await request(base, '/api/walls/w-main')).body.data.cards[0].title, '後續保存');
    console.log('PASS later saves succeed after conflict recovery');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
