const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const playwright = require('playwright-core');
const {ready} = require('./wall-ready.cjs');
const {openActivity} = require('./wall-ready.cjs');

const base = process.env.WALL_TEST_URL;
const temp = process.env.TEMP || path.join(__dirname, '..', 'test-results', 'sources');
const existing = path.join(temp, 'existing-source.txt');
const missing = path.join(temp, 'missing-source.txt');
fs.writeFileSync(existing, 'source test');
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
const idle = page => page.waitForFunction(() => !wallBusy && !store.hasPendingWrites());
const downloadJson = async (page, selector) => {
  const waiting = page.waitForEvent('download');
  await page.click(selector);
  const download = await waiting;
  const target = path.join(temp, download.suggestedFilename());
  await download.saveAs(target);
  return JSON.parse(fs.readFileSync(target, 'utf8'));
};

(async () => {
  const check = await request('/api/sources/check', 'POST', {hrefs: [existing, missing, 'https://example.com/paper.pdf', '\\\\203.0.113.1\\share\\a.pdf', 'file://203.0.113.1/share/a.pdf']});
  assert.equal(check.status, 200);
  assert.deepEqual(check.body.results, [
    {href: existing, status: 'ok'},
    {href: missing, status: 'missing'},
    {href: 'https://example.com/paper.pdf', status: 'unchecked'},
    {href: '\\\\203.0.113.1\\share\\a.pdf', status: 'unchecked'},
    {href: 'file://203.0.113.1/share/a.pdf', status: 'unchecked'},
  ]);
  console.log('PASS source checks distinguish existing, missing and URL sources');

  const links = [
    {label: 'Local', href: existing, locator: 'p. 12'},
    {label: 'Web', href: 'https://example.com/paper.pdf', locator: '§3.2', quote: 'quote with | pipe'},
    {label: 'Missing', href: missing},
  ];
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await ready(page);
    await openActivity(page, 'files');
    await page.evaluate(id => openPanel(id), 'mine');
    await page.fill('#f-links', [
      `${links[0].label} | ${links[0].href} | ${links[0].locator}`,
      `${links[1].label} | ${links[1].href} | ${links[1].locator} | ${links[1].quote}`,
      `${links[2].label} | ${links[2].href}`,
    ].join('\n'));
    await idle(page);
    assert.deepEqual(await page.evaluate(() => structuredClone(byId('mine').links)), links);
    assert.match(await page.locator('.card[data-id="mine"] .links').textContent(), /Local · p\. 12/);
    assert.match(await page.locator('.card[data-id="mine"] .links').textContent(), /Web · §3\.2/);
    await page.waitForFunction(() => [...document.querySelectorAll('.card[data-id="mine"] .links a')]
      .some(a => a.textContent.startsWith('Missing') && a.title === '找不到來源檔案'));
    console.log('PASS panel round-trip keeps optional locator, pipe-containing quote and missing-source warning');

    await page.reload();
    await ready(page);
    assert.deepEqual(await page.evaluate(() => structuredClone(byId('mine').links)), links);
    await page.evaluate(id => openPanel(id), 'mine');
    assert.match(await page.inputValue('#f-links'), /quote with \| pipe/);

    const exported = await downloadJson(page, '#export');
    assert.deepEqual(exported.cards.find(c => c.id === 'mine').links, links);
    const canvas = await downloadJson(page, '#export-canvas');
    const canvasCard = canvas.nodes.find(node => node.id === 'mine');
    assert.deepEqual(canvasCard.detective.links, links);
    assert.match(canvasCard.text, /quote with \| pipe/);
    await page.click('#add-wall');
    await idle(page);
    await page.setInputFiles('#import-file', {name: 'sources.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported))});
    await page.waitForSelector('#importer[open]');
    await page.click('#im-replace'); await page.click('#im-replace');
    await idle(page);
    assert.deepEqual(await page.evaluate(() => structuredClone(byId('mine').links)), links);
    await page.setInputFiles('#import-file', {name: 'sources.canvas', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(canvas))});
    await page.waitForSelector('#importer[open]');
    await page.click('#im-replace'); await page.click('#im-replace');
    await idle(page);
    assert.deepEqual(await page.evaluate(() => structuredClone(byId('mine').links)), links);
    console.log('PASS single-wall JSON export and import preserves all source fields');

    const currentId = await page.evaluate(() => currentWall.id);
    const project = await downloadJson(page, '#export-project');
    assert.deepEqual(project.walls.find(w => w.id === currentId).data.cards.find(c => c.id === 'mine').links, links);
    await page.evaluate(() => { byId('mine').links[0].locator = 'changed'; render(); save(true); });
    await idle(page);
    await page.click('#import-project');
    await page.setInputFiles('#project-file', {name: 'project.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project))});
    await page.click('#import-project');
    await page.waitForFunction(() => !wallBusy && data.cards.find(c => c.id === 'mine')?.links?.[0]?.locator === 'p. 12');
    assert.deepEqual(await page.evaluate(() => structuredClone(byId('mine').links)), links);
    assert.deepEqual((await request('/api/project')).body.walls.find(w => w.id === currentId).data.cards.find(c => c.id === 'mine').links, links);
    assert.deepEqual(errors, []);
    console.log('PASS project export and restore preserves source fields');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
