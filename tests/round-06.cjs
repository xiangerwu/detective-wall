const playwright = require('playwright-core');
const fs = require('fs');
const path = require('path');
const { ready, reload, openActivity, restoreBackup, artifacts, profile, chooseWall, openTabMenu, renameWall } = require('./wall-ready.cjs');
const PAGE = process.env.WALL_TEST_URL || path.join(__dirname, '..', 'index.html');
const OUT = artifacts('round-06');
const PROF = profile();
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1; };
const legacy = {cards: [{id: 'legacy', kind: 'card', x: 100, y: 100, title: '舊線索', note: '', links: []}], edges: []};
const errs = [];
const observe = page => page.on('pageerror', e => errs.push(e.message));
const options = {viewport: {width: 1400, height: 900}, downloadsPath: OUT, timeout: 30000};

(async () => {
  let ctx;
  try {
    ctx = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launchPersistentContext(PROF, options);
    let page = ctx.pages()[0] || await ctx.newPage();
    observe(page);
    await page.addInitScript(d => localStorage.setItem('thesis-detective-wall-v2', JSON.stringify(d)), legacy);
    await page.goto(PAGE); await ready(page);
    ok(await page.evaluate(async d => {
      const saved = await store.getWall('w-main'), listed = await store.listWalls();
      return currentWall.id === 'w-main' && currentWall.name === '案件圖譜' && saved.data.cards[0].title === d.cards[0].title &&
        saved.data.bands.length === SEED.bands.length && saved.data.tags.length === 0 &&
        listed.length === 1 && Object.keys(listed[0]).sort().join(',') === 'id,name,updated' && Number.isFinite(listed[0].updated) &&
        await store.getMeta('currentWall') === 'w-main' && localStorage.getItem(KEY) === JSON.stringify(d);
    }, legacy), 'first run migrates legacy data and defaults into w-main, preserving the old localStorage key');
    ok(await page.title() === '案件圖譜｜CaseGraph 案件圖譜' && await page.isDisabled('#delete-wall') && !(await page.isVisible('#storage-warning')), 'startup renders title and protects the only wall without a storage warning');
    await page.evaluate(() => openPanel('legacy'));
    await page.fill('#f-title', '重新啟動後保留');
    await page.evaluate(() => store.getWall(currentWall.id));
    await ctx.close(); ctx = null;

    // Same profile, a genuinely new browser process.
    ctx = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launchPersistentContext(PROF, options);
    page = ctx.pages()[0] || await ctx.newPage();
    observe(page);
    await page.goto(PAGE); await ready(page); await openActivity(page, 'tags');
    ok(await page.locator('.card[data-id="legacy"] h3').textContent() === '重新啟動後保留' &&
      await page.evaluate(async () => (await store.getWall('w-main')).data.cards[0].title === '重新啟動後保留'), 'edits persist across browser restart in the same profile');
    const settled = () => page.waitForFunction(() => !wallBusy && !document.body.inert);
    const choose = id => chooseWall(page, id);
    const twice = async selector => { await page.click(selector); await page.click(selector); await settled(); };
    const open = async d => {
      await openActivity(page, 'files');
      await page.setInputFiles('#import-file', {name: 'round-06.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(d))});
      await page.waitForSelector('#importer[open]');
    };
    const state = () => page.evaluate(() => JSON.stringify({
      bands: data.bands, tags: data.tags,
      cards: data.cards.map(c => ({...c, tags: c.tags || []})), edges: data.edges,
    }));
    await page.evaluate(() => {
      for (let i = 0; i < 12; i++) { byId('legacy').title = 'Main ' + i; save(true); }
    });
    await page.click('#add-wall'); await settled();
    const second = await page.evaluate(() => currentWall.id);
    ok(await page.evaluate(() => currentWall.name === '新的牆 1' && ['bands', 'tags', 'cards', 'edges'].every(k => data[k].length === 0) &&
      past.length === 0 && future.length === 0 && lastJSON === JSON.stringify(data)), 'new wall starts empty with a fresh history');
    ok(await page.evaluate(async () => (await store.getWall('w-main')).data.cards[0].title === 'Main 11'), 'switch flushes rapid saves, with the last save winning');
    await page.click('#add-wall'); await settled();
    const third = await page.evaluate(() => currentWall.id);
    ok(await page.evaluate(() => currentWall.name === '新的牆 2'), 'new wall numbering avoids existing names');
    await choose(second);
    await renameWall(page, '研究 B');
    ok(await page.title() === '研究 B｜CaseGraph 案件圖譜' && await page.locator('.wall-tab[aria-selected=true]').textContent() === '研究 B' &&
      await page.evaluate(async () => (await store.getWall(currentWall.id)).name === '研究 B'), 'rename updates storage, tab and document title');
    await page.click('#add-card');
    await page.fill('#f-title', 'B 的卡片');
    await page.fill('#f-tag', 'B tag'); await page.press('#f-tag', 'Enter');
    await page.click('#f-close');
    await page.locator('#tag-filter .tag-toggle').click();
    await page.locator('#tag-filter .tag-edit').click();
    await page.click('#undo');
    ok(await page.evaluate(() => future.length > 0), 'outgoing wall has redo history before switching');
    await page.click('#redo');
    await page.evaluate(() => { data.cards[0].note = 'Temporary edit'; save(true); undo(); });
    ok(await page.evaluate(() => past.length > 0 && future.length > 0), 'outgoing wall has both undo and redo steps');
    await page.locator('#tag-filter .tag-edit').click();
    const bData = await state();
    await choose('w-main');
    ok(await page.evaluate(() => data.cards.length === 1 && byId('legacy').title === 'Main 11' && data.tags.length === 0), 'main wall keeps its own cards and tags');
    ok(await page.evaluate(() => !past.length && !future.length && lastJSON === JSON.stringify(data) && !activeTags.size &&
      panel.hidden && pop.hidden && bandpop.hidden && $('#tagpop').hidden && $('#tabmenu').hidden && !$('#importer').open &&
      selCard === null && selEdge === null) && await page.isDisabled('#undo') && await page.isDisabled('#redo'), 'switch resets both histories, filter, selections, panels and popups');
    await choose(second);
    ok(await state() === bData && await page.evaluate(() => !past.length && !future.length && !activeTags.size), 'switching back restores only that wall data, with empty history and filter');
    await reload(page);
    ok(await page.evaluate(id => currentWall.id === id && currentWall.name === '研究 B', second), 'current wall and rename survive reload');
    const downloading = page.waitForEvent('download');
    await openActivity(page, 'files'); await page.click('#export');
    const download = await downloading;
    ok(download.suggestedFilename() === '研究 B.json', 'export filename uses the wall name');
    const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    ok(JSON.stringify(JSON.parse(Buffer.concat(chunks).toString())) === await page.evaluate(() => JSON.stringify({...data, images: {}})), 'export contains the current wall data and an empty images map');

    // Independent wall backups, including restoring after a reload.
    await choose('w-main');
    const mainBefore = await state();
    await open({cards: [{id: 'import-main', title: 'Main import'}], edges: []});
    await page.click('#im-apply'); await settled();
    const mainBackup = await page.evaluate(async () => (await store.listBackups(currentWall.id))[0].id);
    ok(!!mainBackup, 'main wall has a pre-import version (an unchanged auto backup is reused)');
    await choose(second);
    ok(await page.evaluate(async id => !(await store.listBackups(currentWall.id)).some(b => b.id === id), mainBackup), 'other wall does not expose main wall backup');
    await open({cards: [{id: 'import-b', title: 'B import'}], edges: [], bands: [], tags: []});
    await twice('#im-replace');
    const secondBackup = await page.evaluate(async () => (await store.listBackups(currentWall.id))[0].id);
    ok(await page.evaluate(async ([aId, bId]) => {
      const a = await store.getBackup(aId), b = await store.getBackup(bId);
      return a.wallId !== b.wallId && a.data.cards[0].id === 'legacy' && b.data.cards[0].title === 'B 的卡片' && data.cards[0].id === 'import-b';
    }, [mainBackup, secondBackup]), 'replace affects only current wall and backups have separate wall ids');
    await choose('w-main');
    ok(await page.evaluate(() => !!byId('import-main') && !byId('import-b')), 'imported data stays isolated');
    await restoreBackup(page, mainBackup);
    ok(await state() === mainBefore, 'main snapshot restores main wall');
    await choose(second); await reload(page);
    ok(await page.evaluate(async id => !!await store.getBackup(id), secondBackup), 'other backup survives restoring main wall and reload');
    await restoreBackup(page, secondBackup);
    ok(await state() === bData, 'other snapshot restores its own wall');
    await openActivity(page, 'files'); await twice('#reset');
    ok(await page.evaluate(() => JSON.stringify(data) === JSON.stringify(SEED)), 'reset affects current wall');
    await choose('w-main');
    ok(await state() === mainBefore, 'reset leaves the other wall unchanged');

    await choose(third);
    await openTabMenu(page);
    await page.click('#delete-wall');
    ok(await page.evaluate(async () => (await store.listWalls()).length === 3 && !!await store.getWall(currentWall.id)), 'first delete click only arms');
    await page.click('#delete-wall'); await settled();
    ok(await page.evaluate(async id => !await store.getWall(id) && (await store.listWalls()).length === 2, third), 'second delete click deletes the selected wall');
    await choose(second); await openTabMenu(page); await twice('#delete-wall');
    ok(await page.isDisabled('#delete-wall') && await page.evaluate(async () => currentWall.id === 'w-main' && (await store.listWalls()).length === 1), 'deleting down to one wall disables deletion');
    await page.evaluate(() => { $('#delete-wall').click(); $('#delete-wall').click(); });
    await reload(page);
    ok(await page.evaluate(async () => (await store.listWalls()).length === 1) && await state() === mainBefore, 'last wall cannot be deleted and remains saved');

    const fallback = await ctx.newPage();
    observe(fallback);
    await fallback.addInitScript(() => { window.fetch = () => Promise.reject(new Error('server unavailable in test')); });
    await fallback.goto(PAGE); await ready(fallback);
    ok(await fallback.isVisible('#storage-warning') && await fallback.textContent('#storage-warning') === '本機服務無法連線，變更目前只保留在此分頁。' &&
      await fallback.evaluate(() => byId('legacy').title === '舊線索'), 'open failure shows the warning and loads legacy data in memory');
    await fallback.evaluate(() => { byId('legacy').title = 'Memory only'; save(); });
    await fallback.click('#add-wall');
    await fallback.waitForFunction(() => !wallBusy && currentWall.id !== 'w-main');
    await chooseWall(fallback, 'w-main');
    ok(await fallback.evaluate(() => byId('legacy').title === 'Memory only' && JSON.parse(localStorage.getItem(KEY)).cards[0].title === '舊線索'), 'fallback supports wall switching without overwriting legacy storage');
    await reload(fallback);
    ok(await fallback.evaluate(() => byId('legacy').title === '舊線索' && walls.length === 1), 'fallback edits disappear on reload as warned');
    await fallback.evaluate(() => localStorage.setItem(KEY, 'invalid JSON'));
    await reload(fallback);
    ok(await fallback.evaluate(() => JSON.stringify(data) === JSON.stringify(SEED)), 'fallback uses SEED when legacy storage is invalid');
    await fallback.close();
    ok(errs.length === 0, 'no page errors ' + errs.join('; '));
    console.log('Artifacts retained: ' + OUT);
  } finally {
    if (ctx) await ctx.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
