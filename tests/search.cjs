const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const playwright = require('playwright-core');
const {ready} = require('./wall-ready.cjs');

const base = process.env.WALL_TEST_URL;
const request = (pathname, method = 'GET', value) => new Promise((resolve, reject) => {
  const url = new URL(pathname, base), body = value === undefined ? '' : JSON.stringify(value);
  const headers = value === undefined ? {} : {'content-type': 'application/json', 'content-length': Buffer.byteLength(body)};
  const req = http.request({hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers}, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body = text;
      try { body = JSON.parse(text); } catch {}
      resolve({status: res.statusCode, body});
    });
  });
  req.on('error', reject);
  req.end(body);
});

const first = {
  bands: [],
  tags: [{id: 'tag-one', name: 'Important match tag', color: 'slate'}],
  cards: [
    {id: 'first-card', kind: 'card', x: 80, y: 80, title: 'Title match', note: 'Note match', tags: ['tag-one'], links: []},
    {id: 'first-target', kind: 'card', x: 420, y: 80, title: 'Other card', note: '', links: []},
  ],
  edges: [{id: 'edge-first', from: 'first-card', to: 'first-target', type: 'builds', label: 'Edge match'}],
};
const second = {
  bands: [],
  tags: [],
  cards: [
    {id: 'second-card', kind: 'card', x: 120, y: 100, title: 'Needle target', note: 'A folded result', fold: true, links: []},
    {id: 'second-other', kind: 'card', x: 500, y: 100, title: '100% literal_under score', note: '', links: []},
  ],
  edges: [],
};

(async () => {
  let response = await request('/api/walls/wall-a', 'PUT', {id: 'wall-a', name: 'First Wall', data: first, version: null});
  assert.equal(response.status, 200);
  response = await request('/api/walls/wall-b', 'PUT', {id: 'wall-b', name: 'Second Wall', data: second, version: null});
  assert.equal(response.status, 200);

  const before = (await request('/api/project')).body;
  let result = (await request('/api/search?q=match')).body;
  assert.deepEqual(new Set(result.map(row => row.field)), new Set(['title', 'note', 'tag', 'edge']));
  assert.ok(result.some(row => row.wallName === 'First Wall' && row.type === 'edge' && row.cardId === 'first-card'));
  assert.ok(result.every(row => row.snippet.length <= 120));
  assert.deepEqual((await request('/api/search?q=%25')).body.map(row => row.cardId), ['second-other']);
  assert.deepEqual((await request('/api/search?q=_')).body.map(row => row.cardId), ['second-other']);
  assert.deepEqual((await request('/api/search?q=%20%20%20')).body, []);
  assert.ok((await request('/api/search?q=match&limit=2')).body.length <= 2);
  assert.deepEqual((await request('/api/project')).body.walls, before.walls);
  console.log('PASS API searches title, note, tag and edge fields across walls with literal LIKE characters, empty query and limit');

  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await ready(page);
    await page.evaluate(() => { activeTags.add('tag-one'); render(); });
    await page.fill('#wall-search', 'needle');
    await page.waitForSelector('#search-results .search-result');
    assert.match(await page.textContent('#search-results'), /Second Wall/);
    assert.match(await page.textContent('#search-results'), /Needle target/);
    console.log('PASS UI search debounce lists the matching wall and card');

    await page.locator('#search-results .search-result').first().click();
    await page.waitForFunction(() => currentWall.id === 'wall-b' && !wallBusy && selCard === 'second-card');
    assert.equal(await page.evaluate(() => activeTags.size), 0);
    assert.equal(await page.evaluate(() => byId('second-card').fold), false);
    const card = page.locator('.card[data-id="second-card"]');
    assert.equal(await card.evaluate(el => el.classList.contains('sel')), true);
    assert.equal(await card.evaluate(el => el.classList.contains('folded')), false);
    const box = await card.boundingBox();
    const viewport = await page.locator('#viewport').boundingBox();
    assert.ok(box.x >= viewport.x && box.x + box.width <= viewport.x + viewport.width
      && box.y >= viewport.y && box.y + box.height <= viewport.y + viewport.height);
    const after = (await request('/api/project')).body;
    assert.equal(after.walls.find(w => w.id === 'wall-b').data.cards.find(c => c.id === 'second-card').fold, false);
    assert.deepEqual(after.walls.find(w => w.id === 'wall-a').data, before.walls.find(w => w.id === 'wall-a').data);
    assert.deepEqual(errors, []);
    console.log('PASS clicking a cross-wall result clears the filter, unfolds and saves the card, centers and selects it');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
