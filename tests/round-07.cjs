const playwright = require('playwright-core');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { ready, reload, settled, openActivity, previewBackup, restoreBackup, artifacts, chooseWall, openTabMenu } = require('./wall-ready.cjs');
const PAGE = process.env.WALL_TEST_URL || path.join(__dirname, '..', 'index.html');
const OUT = artifacts('round-07');
const errors = [];
const legacyKey = 'thesis-detective-wall-v2-before-import:w-main';
const observe = page => page.on('pageerror', e => errors.push(e.message));
const list = page => page.evaluate(() => store.listBackups(currentWall.id));
const wall = page => page.evaluate(() => structuredClone(data));
const tick = async page => { await page.clock.runFor(60000); return list(page); };
const twice = async (page, selector) => {
  await page.click(selector); await page.click(selector); await settled(page);
};
const choose = chooseWall;
const open = async (page, name, data) => {
  await openActivity(page, 'files');
  await page.setInputFiles('#import-file', {name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data))});
  await page.waitForSelector('#importer[open]');
};
const edit = (page, title) => page.evaluate(title => { data.cards[0].title = title; render(); return save(true); }, title);
const snapshot = (page, id) => page.evaluate(id => store.getBackup(id), id);
const check = (value, message) => { assert.ok(value, message); console.log('PASS ' + message); };

(async () => {
    const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const ctx = await browser.newContext({viewport: {width: 1400, height: 900}});
    const page = await ctx.newPage();
    observe(page);
    await page.addInitScript(key => localStorage.setItem(key, 'old snapshot stays untouched'), legacyKey);
    await page.clock.install({time: new Date('2026-10-28T12:00:00Z')});
    await page.clock.pauseAt(new Date('2026-10-28T12:00:01Z'));
    await page.goto(PAGE); await ready(page); await openActivity(page, 'history');

    check(await page.locator('#undo-import').count() === 0, 'old one-level undo button is removed');
    await openActivity(page, 'history'); await page.click('#show-backups'); await page.waitForSelector('#backups[open]');
    assert.equal((await page.textContent('#backup-list')).trim(), '還沒有備份');
    await page.click('#backups-close');
    assert.equal((await tick(page)).length, 0);
    await page.evaluate(() => save());
    assert.equal((await tick(page)).length, 0);
    check(true, 'unchanged startup and unchanged save do not create automatic backups');

    await edit(page, 'Automatic version');
    await page.clock.runFor(59999);
    assert.equal((await list(page)).length, 0);
    await page.clock.runFor(1);
    const auto = (await list(page))[0], autoData = await wall(page);
    assert.equal(auto.reason, '自動');
    assert.equal(auto.cards, autoData.cards.length);
    assert.equal(auto.edges, autoData.edges.length);
    assert.ok(!Object.hasOwn(auto, 'data'));
    assert.deepEqual((await snapshot(page, auto.id)).data, autoData);
    assert.equal((await tick(page)).length, 1);
    check(true, 'auto backup occurs at 60 seconds after a change, lists metadata only, and skips unchanged intervals');

    await openActivity(page, 'history'); await page.click('#show-backups'); await page.waitForSelector('#backups[open]');
    const row = await page.locator('.backup-row').textContent();
    const time = await page.evaluate(at => new Date(at).toLocaleString('zh-TW'), auto.at);
    check(row.includes(time) && row.includes('自動') && row.includes(auto.cards + ' 張卡片') && row.includes(auto.edges + ' 條連線'), 'backup list renders localized time, reason and both counts');
    await page.screenshot({path: path.join(OUT, 'backups.png')});
    const history = await page.evaluate(() => JSON.stringify({past, future}));
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(() => JSON.stringify({past, future})), history);
    await page.click('#backups-close');
    await reload(page);
    assert.deepEqual(await list(page), [auto]);
    assert.equal((await tick(page)).length, 1);
    check(true, 'backup and duplicate suppression survive reload');

    await edit(page, 'Before importing');
    const beforeImport = await wall(page);
    const incoming = structuredClone(beforeImport);
    incoming.cards[0].title = 'Imported title';
    incoming.cards[1].title = 'Keep this imported title';
    incoming.cards.push({id: 'extra', kind: 'card', title: 'Extra imported card', note: '', links: [], tags: [], x: 100, y: 100});
    await open(page, 'round-07.json', incoming);
    assert.equal((await list(page)).length, 1, 'preview alone does not back up');
    await page.click('#im-cancel');
    assert.equal((await list(page)).length, 1);
    await open(page, 'round-07.json', incoming);
    await page.click('#im-apply'); await settled(page);
    const preImport = (await list(page))[0];
    assert.equal(preImport.reason, '匯入 round-07.json 前');
    assert.deepEqual((await snapshot(page, preImport.id)).data, beforeImport);
    check(true, 'import application saves the exact pre-import wall; preview and cancel do not');

    const imported = await wall(page);
    await previewBackup(page, preImport.id);
    assert.equal(await page.evaluate(() => pending.restore), true);
    assert.match(await page.textContent('#im-file'), /^備份 /);
    await page.click('#im-none');
    await page.locator('#im-list .im-row').filter({hasText: 'Before importing'}).locator('input').check();
    await page.click('#im-apply'); await settled(page);
    let restored = await wall(page);
    assert.equal(restored.cards[0].title, beforeImport.cards[0].title);
    assert.equal(restored.cards[1].title, imported.cards[1].title);
    assert.ok(restored.cards.some(c => c.id === 'extra'));
    const prePartial = (await list(page))[0];
    assert.equal(prePartial.reason, '還原前');
    assert.deepEqual((await snapshot(page, prePartial.id)).data, imported);
    check(true, 'partial restore merges only selected items and saves 還原前');

    const partial = restored;
    await restoreBackup(page, preImport.id);
    restored = await wall(page);
    assert.deepEqual(restored.cards.map(c => c.id), beforeImport.cards.map(c => c.id));
    assert.deepEqual(restored.cards.map(c => c.title), beforeImport.cards.map(c => c.title));
    assert.deepEqual(restored.bands, beforeImport.bands);
    assert.deepEqual(restored.tags, beforeImport.tags);
    assert.deepEqual(restored.edges.map(({id, label = '', ...e}) => ({...e, label})), beforeImport.edges.map(({id, label = '', ...e}) => ({...e, label})));
    assert.equal((await list(page))[0].reason, '還原前');
    assert.deepEqual((await snapshot(page, (await list(page))[0].id)).data, partial);
    await reload(page);
    assert.deepEqual(await wall(page), restored);
    check(true, 'full restore removes extra items, saves the partial state first, and persists across reload');

    await open(page, 'replacement.json', {cards: [{id: 'replacement', title: 'Replacement'}], edges: [], bands: [], tags: []});
    await twice(page, '#im-replace');
    const preReplace = (await list(page))[0];
    assert.equal(preReplace.reason, '整份取代前');
    assert.deepEqual((await snapshot(page, preReplace.id)).data, restored);
    const beforeReset = await wall(page);
    await openActivity(page, 'files'); await twice(page, '#reset');
    const preReset = (await list(page))[0];
    assert.equal(preReset.reason, '重設前');
    assert.deepEqual((await snapshot(page, preReset.id)).data, beforeReset);
    check(true, 'whole replacement and reset preserve their previous wall with distinct reasons');
    const afterReset = await tick(page);
    await openActivity(page, 'files'); await twice(page, '#reset');
    assert.deepEqual(await list(page), afterReset);
    check(true, 'before-change backup also skips an already backed-up, unchanged wall');

    const main = await page.evaluate(() => currentWall.id);
    await edit(page, 'Before switch');
    const beforeSwitch = await wall(page);
    await page.click('#add-wall'); await settled(page);
    const other = await page.evaluate(() => currentWall.id);
    const mainBackups = await page.evaluate(id => store.listBackups(id), main);
    assert.equal(mainBackups[0].reason, '自動');
    assert.deepEqual((await snapshot(page, mainBackups[0].id)).data, beforeSwitch);
    assert.equal((await list(page)).length, 0);
    await openActivity(page, 'history'); await page.click('#show-backups'); await page.waitForSelector('#backups[open]');
    assert.equal((await page.textContent('#backup-list')).trim(), '還沒有備份');
    await page.click('#backups-close');
    await tick(page);
    assert.equal((await list(page)).length, 0);
    await choose(page, main); await choose(page, other);
    assert.deepEqual(await page.evaluate(id => store.listBackups(id), main), mainBackups);
    check(true, 'switch backs up changed outgoing wall only, with no duplicate on unchanged switching');

    await page.click('#add-card'); await page.click('#f-close');
    for (let i = 0; i < 23; i++) {
      await edit(page, 'Version ' + i);
      await tick(page);
    }
    const capped = await list(page);
    assert.equal(capped.length, 20);
    assert.equal((await snapshot(page, capped[0].id)).data.cards[0].title, 'Version 22');
    assert.equal((await snapshot(page, capped.at(-1).id)).data.cards[0].title, 'Version 3');
    assert.ok(capped.every((b, i) => b.wallId === other && (!i || b.id < capped[i - 1].id)));
    assert.deepEqual(await page.evaluate(id => store.listBackups(id), main), mainBackups);
    await reload(page);
    assert.deepEqual(await list(page), capped);
    check(true, 'newest 20 are retained in order per wall, persist on reload, and leave other walls untouched');

    // The store uses the same queue for rapid writes, cloning inputs before callers mutate them.
    const queueResult = await page.evaluate(async () => {
      const value = structuredClone(data), jobs = [];
      for (let i = 0; i < 24; i++) {
        value.cards[0].title = 'Queued ' + i;
        jobs.push(store.addBackup(currentWall.id, '自動', value));
      }
      value.cards[0].title = 'Caller mutation';
      const ids = await Promise.all(jobs);
      return {ids, rows: await store.listBackups(currentWall.id), latest: await store.getBackup(ids.at(-1)), oldest: await store.getBackup(ids[0])};
    });
    assert.equal(queueResult.rows.length, 20);
    assert.equal(queueResult.latest.data.cards[0].title, 'Queued 23');
    assert.equal(queueResult.oldest, undefined);
    check(true, 'queued backup writes clone data and prune within the write transaction');

    const deletedIds = queueResult.rows.map(b => b.id);
    await edit(page, 'Unsaved-to-backup before deleting');
    await openTabMenu(page); await twice(page, '#delete-wall');
    assert.equal(await page.evaluate(() => currentWall.id), main);
    assert.deepEqual(await page.evaluate(id => store.listBackups(id), other), []);
    for (const id of deletedIds) assert.equal(await snapshot(page, id), undefined);
    assert.deepEqual(await list(page), mainBackups);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), legacyKey), 'old snapshot stays untouched');
    check(true, 'wall deletion removes all its backups without creating a new orphan or deleting legacy localStorage');

    // A new browser context reads the same server-backed wall and metadata.
    const upgradeCtx = await browser.newContext();
    const upgrade = await upgradeCtx.newPage();
    observe(upgrade);
    await upgrade.goto(PAGE); await ready(upgrade);
    check(await upgrade.evaluate(async () => {
      const wall = await (await fetch('/api/walls/w-main')).json();
      return currentWall.id === 'w-main' && wall.id === 'w-main' && Number.isInteger(wall.version)
        && wall.data.cards.length === data.cards.length && await store.getMeta('currentWall') === 'w-main';
    }), 'new browser context reads the shared server wall, version and metadata');
    await upgradeCtx.close();

    const fallbackCtx = await browser.newContext({viewport: {width: 1400, height: 900}});
    const fallback = await fallbackCtx.newPage();
    observe(fallback);
    await fallback.addInitScript(() => { window.fetch = () => Promise.reject(new Error('server unavailable in test')); });
    await fallback.clock.install({time: new Date('2026-10-28T12:00:00Z')});
    await fallback.clock.pauseAt(new Date('2026-10-28T12:00:01Z'));
    await fallback.goto(PAGE); await ready(fallback);
    assert.ok(await fallback.isVisible('#storage-warning'));
    assert.equal((await tick(fallback)).length, 0);
    await edit(fallback, 'Memory backup');
    const memoryBackup = (await tick(fallback))[0];
    const memoryData = await wall(fallback);
    await edit(fallback, 'Memory changed');
    await restoreBackup(fallback, memoryBackup.id);
    assert.equal((await wall(fallback)).cards[0].title, 'Memory backup');
    assert.equal((await list(fallback))[0].reason, '還原前');
    assert.deepEqual((await snapshot(fallback, memoryBackup.id)).data, memoryData);
    await fallback.evaluate(async () => {
      const id = currentWall.id;
      for (let i = 0; i < 25; i++) {
        data.cards[0].title = 'Memory ' + i;
        await save(true);
        await backupWall('自動');
      }
    });
    const memoryRows = await list(fallback);
    assert.equal(memoryRows.length, 20);
    assert.equal((await snapshot(fallback, memoryRows.at(-1).id)).data.cards[0].title, 'Memory 5');
    const memoryMain = await fallback.evaluate(() => currentWall.id);
    await fallback.click('#add-wall'); await settled(fallback);
    assert.equal((await list(fallback)).length, 0);
    await choose(fallback, memoryMain);
    assert.deepEqual(await list(fallback), memoryRows);
    await openTabMenu(fallback); await twice(fallback, '#delete-wall');
    assert.deepEqual(await fallback.evaluate(id => store.listBackups(id), memoryMain), []);
    assert.equal(await snapshot(fallback, memoryRows[0].id), undefined);
    await fallback.evaluate(async () => {
      await store.addBackup(currentWall.id, '自動', data);
      await store.deleteBackups(currentWall.id);
    });
    assert.deepEqual(await list(fallback), []);
    await fallback.evaluate(() => store.addBackup(currentWall.id, '自動', data));
    await reload(fallback);
    assert.deepEqual(await list(fallback), []);
    check(true, 'in-memory fallback supports auto backup, restore, cap, per-wall isolation, get/delete and warned reload loss');
    await fallbackCtx.close();
    assert.deepEqual(errors, []);
    check(true, 'no page errors');
    fs.writeFileSync(path.join(OUT, 'round-07-result.json'), JSON.stringify({passed: true, browser: browser.browserType().name(), errors}, null, 2) + '\n');
    console.log('Artifacts retained: ' + OUT);
    await ctx.close();
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
