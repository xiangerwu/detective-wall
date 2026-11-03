const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require('playwright-core');
const {ready, reload, artifacts} = require('./wall-ready.cjs');

const base = process.env.WALL_TEST_URL;
const out = artifacts('p14b2');

(async () => {
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base); await ready(page);
    await page.evaluate(async () => {
      data = {bands: [{id: 'b2-band', title: 'P14-B2', y: 0}], tags: [], cards: [
        {id: 'b2-source', kind: 'card', x: 360, y: 160, title: '源頭資料', note: '紙張線索', links: [], level: 'source'},
        {id: 'b2-key', kind: 'card', x: 680, y: 150, title: '重點判斷', note: '紙張重點', links: [], level: 'key'},
        {id: 'b2-candidate', kind: 'card', x: 320, y: 430, title: '待確認來源', note: '沒有入線但有指出去的線', links: []},
        {id: 'b2-target', kind: 'note', x: 950, y: 470, title: '待驗證', note: '', links: []},
      ], edges: [{id: 'b2-edge-1', from: 'b2-source', to: 'b2-key', type: 'builds'},
        {id: 'b2-edge-2', from: 'b2-candidate', to: 'b2-target', type: 'question'}]};
      selCard = selEdge = drag = tempLine = null;
      setCardStyle('paper'); setTheme('whiteboard'); render(); fitView(true); await save(true);
    });

    assert.equal(await page.locator('#add-image').getAttribute('title'), '上傳圖片並建立拍立得照片');
    assert.ok(await page.locator('.card-paper').count() >= 4);
    assert.match(await page.locator('.card-paper').first().evaluate(el => getComputedStyle(el).backgroundImage), /paper-grain\.png/);
    assert.equal(await page.locator('.anchor-badge.anchor-source').count(), 1);
    assert.equal(await page.locator('.anchor-badge.anchor-key').count(), 1);
    console.log('PASS B2-1 paper grain, layered shadows, and anchor badges render');

    await page.evaluate(() => openPanel('b2-key'));
    await page.check('#f-curl');
    await page.waitForFunction(() => byId('b2-key').curl === true && document.querySelector('.card[data-id="b2-key"]').classList.contains('curl'));
    assert.equal(await page.locator('#f-level button[data-level="key"]').getAttribute('aria-checked'), 'true');
    await page.evaluate(() => closePanel());
    await reload(page);
    assert.deepEqual(await page.evaluate(() => ({level: byId('b2-key').level, curl: byId('b2-key').curl})), {level: 'key', curl: true});
    console.log('PASS B2-1 curl editor control and reload persistence');

    await page.click('#add-image');
    await page.setInputFiles('#image-file', {name: 'evidence.jpg', mimeType: 'image/jpeg', buffer: fs.readFileSync(path.join(__dirname, '..', 'assets', 'cork.jpg'))});
    await page.waitForFunction(() => data.cards.some(card => card.image) && document.querySelector('.card.photo-card .card-image'));
    const photoId = await page.evaluate(() => data.cards.find(card => card.image).id);
    await page.evaluate(async id => { const card = byId(id); card.x = 700; card.y = 500; render(); await save(true); }, photoId);
    const photoClass = page.locator(`.card[data-id="${photoId}"]`);
    assert.equal(await photoClass.locator('.card-image').count(), 1);
    assert.match(await photoClass.evaluate(el => getComputedStyle(el).backgroundColor), /rgb\(255/);
    const angle = await photoClass.evaluate(el => getComputedStyle(el).transform);
    await page.screenshot({path: path.join(out, 'polaroid.png')});
    await reload(page);
    assert.equal(await page.locator(`.card[data-id="${photoId}"]`).evaluate(el => getComputedStyle(el).transform), angle);
    await page.evaluate(id => openPanel(id), photoId);
    await page.fill('#f-note', '這張照片的文字說明');
    await page.waitForFunction(id => !document.querySelector(`.card[data-id="${id}"]`)?.classList.contains('photo-card'), photoId);
    console.log('PASS B2-2 image upload, stable polaroid angle, and note fallback');

    const canvasFields = await page.evaluate(() => {
      const card = byId('b2-key'), snapshot = structuredClone(data), canvas = toCanvas(snapshot);
      const node = canvas.nodes.find(value => value.id === card.id);
      const roundTrip = fromCanvas(canvas).cards.find(value => value.id === card.id);
      const normalized = normalize({cards: [{id: 'normal-level', kind: 'card', title: '匯入', note: '', links: [], level: 'source', curl: true}], edges: []});
      return {canvas: {level: node.detective.level, curl: node.detective.curl}, roundTrip: {level: roundTrip.level, curl: roundTrip.curl}, normalized: normalized.cards[0]};
    });
    assert.equal(canvasFields.canvas.level, 'key');
    assert.equal(canvasFields.canvas.curl, true);
    assert.deepEqual(canvasFields.roundTrip, {level: 'key', curl: true});
    assert.equal(canvasFields.normalized.level, 'source');
    assert.equal(canvasFields.normalized.curl, true);
    const importRows = await page.evaluate(() => {
      openImporter('level-curl.json', {cards: [{id: 'b2-key', kind: 'card', x: 430, y: 150, title: '重點判斷', note: '紙張重點', links: [], level: 'source', curl: false}], edges: []});
      return [...document.querySelectorAll('.im-row small')].map(row => row.textContent);
    });
    assert.ok(importRows.some(text => text.includes('等級')));
    assert.ok(importRows.some(text => text.includes('翻角')));
    await page.click('#im-cancel');
    await page.evaluate(() => closePanel());
    console.log('PASS B2-1 normalize, Canvas round trip, and import diff fields');

    // The anchor list starts folded, opens from its title and remembers that across reloads.
    await page.evaluate(() => { setRailState('full'); render(); });
    assert.equal(await page.getAttribute('#rail-anchor-list-title', 'aria-expanded'), 'false');
    assert.equal(await page.locator('#rail-anchor-filters, #rail-anchor-content [data-anchor-card]').count(), 0, 'folded anchor list hides its filters and cards');
    await page.click('#rail-anchor-list-title');
    assert.equal(await page.getAttribute('#rail-anchor-list-title', 'aria-expanded'), 'true');
    await page.reload(); await ready(page);
    await page.evaluate(() => { setRailState('full'); render(); });
    assert.equal(await page.getAttribute('#rail-anchor-list-title', 'aria-expanded'), 'true', 'anchor list open state survives reload');
    console.log('PASS B2-3 anchor list folds by default and remembers when opened');
    const sourceFilter = page.locator('#rail-anchor-filters button[data-level="source"]');
    await sourceFilter.click();
    await page.waitForFunction(() => anchorFilter === 'source');
    const dimmed = await page.evaluate(() => ({source: byId('b2-source').level, key: document.querySelector('.card[data-id="b2-key"]').classList.contains('dim'), candidate: document.querySelector('.card[data-id="b2-candidate"]').classList.contains('dim')}));
    assert.equal(dimmed.source, 'source');
    assert.equal(dimmed.key, true);
    assert.equal(dimmed.candidate, true);
    assert.equal(await page.locator('#rail-anchor-list h3').filter({hasText: '可能是源頭'}).count(), 0);
    await page.locator('#rail-anchor-list [data-anchor-card="b2-key"]').click();
    assert.equal(await page.evaluate(() => selCard), 'b2-key');
    await page.evaluate(() => { anchorFilter = ''; selCard = 'b2-source'; render(); });
    await page.focus('#viewport'); await page.keyboard.press(']');
    assert.equal(await page.evaluate(() => selCard), 'b2-key');
    await page.keyboard.press('[');
    assert.equal(await page.evaluate(() => selCard), 'b2-source');
    await page.evaluate(() => fitView(true));
    await page.screenshot({path: path.join(out, 'anchor-nav.png')});
    console.log('PASS B2-3 level filter, marked-anchor jump, and keyboard navigation');

    await page.evaluate(() => { closePanel(); setCardStyle('paper'); fitView(true); });
    for (const theme of ['whiteboard', 'wood', 'paper', 'cork', 'moon', 'cyber']) {
      await page.evaluate(themeName => { setTheme(themeName); setCardStyle('paper'); fitView(true); }, theme);
      await page.screenshot({path: path.join(out, `paper-${theme}.png`)});
    }
    console.log('PASS six-theme paper, sticky-note, and curl screenshots');
    assert.equal(errors.length, 0, 'page errors: ' + errors.join('; '));
    console.log('PASS no page errors');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
