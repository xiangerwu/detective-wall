const { ready, reload, settled, openActivity, previewBackup, restoreBackup, artifacts } = require('./wall-ready.cjs');
const playwright = require('playwright-core');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const PAGE = process.env.WALL_TEST_URL || path.join(__dirname, '..', 'index.html');
const OUT = artifacts('base-undo');
const ids = d => d.cards.map(c => c.id).sort().join(',');

(async () => {
    const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(PAGE); await ready(page); await openActivity(page, 'files');
    const wall = () => page.evaluate(() => structuredClone(data));
    const backups = () => page.evaluate(() => store.listBackups(currentWall.id));
    await openActivity(page, 'history'); await page.click('#show-backups');
    await page.waitForSelector('#backups[open]');
    assert.match(await page.textContent('#backup-list'), /還沒有備份/);
    await page.click('#backups-close');

    const seed = await wall(), imported = structuredClone(seed);
    imported.cards.push({id: 'n1', kind: 'card', x: 900, y: 700, title: 'A 的新線索', note: '', links: []});
    imported.cards.find(c => c.id === 'mine').title = 'A 版';
    imported.edges.push({from: 'n1', to: 'mine', type: 'uses'});
    const file = path.join(OUT, 'ai_a.json');
    fs.writeFileSync(file, JSON.stringify(imported));
    const open = async f => {
      await openActivity(page, 'files');
      await page.setInputFiles('#import-file', f);
      await page.waitForSelector('#importer[open]');
    };
    await open(file); await page.click('#im-apply'); await settled(page);
    const original = (await backups())[0];
    assert.equal(original.reason, '匯入 ai_a.json 前');
    assert.equal(original.cards, seed.cards.length);
    await reload(page);
    assert.equal((await backups())[0].id, original.id);
    await previewBackup(page, original.id);
    await page.click('#im-replace');
    assert.ok((await wall()).cards.some(c => c.id === 'n1'), 'first click only arms replacement');
    await page.click('#im-replace'); await settled(page);
    const restored = await wall();
    assert.equal(ids(restored), ids(seed));
    assert.equal(restored.cards.find(c => c.id === 'mine').title, seed.cards.find(c => c.id === 'mine').title);
    assert.equal(restored.edges.length, seed.edges.length);
    assert.equal((await backups())[0].reason, '還原前');
    await reload(page);
    assert.deepEqual(await wall(), restored, 'restored wall survives reload');

    const replacement = path.join(OUT, 'replace.json');
    fs.writeFileSync(replacement, JSON.stringify({cards: [{id: 'only', title: '唯一'}], edges: []}));
    await open(replacement);
    await page.click('#im-replace'); await page.click('#im-replace'); await settled(page);
    assert.equal(ids(await wall()), 'only');
    const beforeReplace = (await backups())[0];
    assert.equal(beforeReplace.reason, '整份取代前');
    await restoreBackup(page, beforeReplace.id);
    assert.equal(ids(await wall()), ids(seed), 'replacement can be restored');
    await restoreBackup(page, original.id);
    assert.equal(ids(await wall()), ids(seed), 'older versions remain available after later restores');
    assert.deepEqual(errors, []);
    console.log('PASS import recovery, multiple versions, reload, 還原前, replacement and no page errors');
    console.log('Artifacts retained: ' + OUT);
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
