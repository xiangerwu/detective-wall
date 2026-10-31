const { ready, reload, settled, openActivity, restoreBackup } = require('./wall-ready.cjs');
const playwright = require('playwright-core');
const path = require('path');
const PAGE = process.env.WALL_TEST_URL || path.join(__dirname, '..', 'index.html');
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1; };

(async () => {
    const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errs = [], dialogs = [];
    page.on('pageerror', e => errs.push(e.message));
    page.on('dialog', async d => { dialogs.push(d.message()); await d.dismiss(); });
    await page.goto(PAGE); await ready(page); await openActivity(page, 'files');
    const seed = await page.evaluate(() => structuredClone(data));
    const bands = () => page.evaluate(() => structuredClone(data.bands));
    const label = id => page.locator(`.band[data-id="${id}"] .band-label`);
    const open = async d => {
      await page.setInputFiles('#import-file', { name: 'bands.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(d)) });
      await page.waitForSelector('#importer[open]');
    };
    const dragBy = async (x, y, dx, dy) => {
      await page.mouse.move(x, y); await page.mouse.down();
      await page.mouse.move(x + dx, y + dy, { steps: 6 }); await page.mouse.up();
    };

    ok(await page.locator('.band').count() === 3 && JSON.stringify(seed.bands.map(b => [b.title, b.y])) === JSON.stringify([
      ['基底演算法', 0], ['應用先例', 500], ['我的論文', 1020],
    ]), 'seed renders three bands at the specified positions');
    await page.evaluate(async () => { const old = structuredClone(data); delete old.bands; localStorage.setItem(KEY, JSON.stringify(old)); await store.deleteWall(currentWall.id); });
    await reload(page);
    ok(JSON.stringify(await bands()) === JSON.stringify(seed.bands) && await page.evaluate(async () => (await store.getWall(currentWall.id)).data.bands.length) === 3,
      'load migrates and saves old data without bands');
    await page.evaluate(() => store.putWall(currentWall.id, currentWall.name, {...data, bands: null}));
    await reload(page);
    ok((await bands()).length === 3, 'invalid saved bands migrate to seed');

    const id = seed.bands[0].id;
    await page.click('#zoom-fit');
    const before = (await bands())[0], scale = await page.evaluate(() => view.s);
    const box = await label(id).boundingBox();
    await dragBy(box.x + 20, box.y + box.height / 2, 30, 90);
    const moved = (await bands()).find(b => b.id === id);
    ok(Math.abs(moved.y - before.y - 90 / scale) < 1 && !(await page.isVisible('#bandpop')), 'label drag uses zoom-adjusted vertical distance without opening popup');
    await reload(page);
    ok(Math.abs((await bands()).find(b => b.id === id).y - moved.y) < 1, 'drag persists after reload');

    await label(id).click();
    ok(await page.isVisible('#bandpop') && await page.inputValue('#band-title') === before.title, 'click without movement opens title popup');
    await page.fill('#band-title', 'ABC');
    await page.press('#band-title', 'Home'); await page.press('#band-title', 'Delete');
    await page.press('#band-title', 'End'); await page.press('#band-title', 'Backspace');
    ok(await page.inputValue('#band-title') === 'B' && await page.evaluate(() => data.cards.length === SEED.cards.length && data.edges.length === SEED.edges.length && data.bands.length === 3),
      'Delete and Backspace only edit the title input');
    await page.fill('#band-title', '已改名分層');
    ok(await label(id).textContent() === '已改名分層', 'rename updates label live');
    const popup = await page.locator('#bandpop').boundingBox();
    await page.click('#zoom-out');
    const zoomed = await page.locator('#bandpop').boundingBox();
    ok(Math.abs(popup.width - zoomed.width) < 1 && Math.abs(popup.height - zoomed.height) < 1, 'band popup keeps its screen size when zooming');
    await page.press('#band-title', 'Escape');
    ok(!(await page.isVisible('#bandpop')), 'Escape closes popup from title input');
    await reload(page);
    ok((await bands()).find(b => b.id === id).title === '已改名分層', 'rename persists after reload');
    await label(id).click();
    await page.click('#bandpop button');
    ok((await bands()).length === 3, 'first delete click only arms');
    await page.click('#bandpop button');
    ok((await bands()).length === 2 && await label(id).count() === 0 && !(await page.isVisible('#bandpop')), 'second delete click removes band and closes popup');
    await reload(page);
    ok((await bands()).length === 2, 'deletion persists');

    await page.click('#zoom-fit');
    const center = await page.evaluate(() => (vp.clientHeight / 2 - view.y) / view.s);
    await page.click('#add-band');
    const added = (await bands()).at(-1);
    ok(added.title === '新分層' && Math.abs(added.y - center) < 1 && await page.isVisible('#bandpop'), 'add places a new band at view centre and opens popup');
    await page.press('#band-title', 'Escape');
    await reload(page);
    ok((await bands()).some(b => b.id === added.id), 'added band persists');

    await page.click('#zoom-fit');
    const pan = async onLine => {
      const start = await page.evaluate(onLine => {
        const r = vp.getBoundingClientRect();
        return { x: r.right - 80, y: onLine ? r.top + view.y + data.bands[0].y * view.s + 0.5 : r.bottom - 60, view: {...view} };
      }, onLine);
      await dragBy(start.x, start.y, -50, 30);
      ok(await page.evaluate(v => Math.abs(view.x - v.x + 50) < 1 && Math.abs(view.y - v.y - 30) < 1, start.view), onLine ? 'band line away from label allows panning' : 'empty wall allows panning');
    };
    await pan(false); await pan(true);
    ok(await page.evaluate(() => {
      const v = vp.getBoundingClientRect();
      return [...wall.querySelectorAll('.band')].every(b => {
        const r = b.getBoundingClientRect(), label = b.firstChild.getBoundingClientRect();
        return Math.abs(r.left - v.left) < 1 && Math.abs(r.width - v.width) < 1 && Math.abs(label.left - v.left - 14 * view.s) < 1;
      });
    }), 'all rendered bands stretch across view and labels stay at visible left edge');

    const current = await bands(), renamed = {...current[0], title: '匯入改名', y: current[0].y + 10};
    const incoming = { cards: [], edges: [], bands: [renamed, {id: 'incoming', title: '匯入新分層', y: -200}] };
    await open(incoming);
    const summary = await page.textContent('#im-summary');
    ok(summary.includes('新分層 1｜有變更的分層 1') && await page.locator('#im-list .im-row').count() === 2 && await page.textContent('#im-apply') === '匯入勾選項目（2）', 'import preview counts one new and one changed band: ' + summary);
    const rows = await page.locator('#im-list .im-row').allTextContents();
    ok(rows.some(t => t.includes(current[0].title) && t.includes('匯入改名') && t.includes('位置')) && (await bands())[0].title === current[0].title, 'preview shows title and position differences without applying');
    await page.click('#im-none');
    ok(await page.isDisabled('#im-apply'), 'bands participate in select none');
    await page.click('#im-all');
    await page.locator('#im-list .im-row').filter({hasText: '匯入改名'}).locator('input').uncheck();
    await page.click('#im-apply'); await settled(page);
    ok((await bands()).some(b => b.id === 'incoming') && (await bands()).find(b => b.id === renamed.id).title === current[0].title, 'only checked band is added');
    await open(incoming); await page.click('#im-apply'); await settled(page);
    const merged = await bands();
    ok(merged.find(b => b.id === renamed.id).title === renamed.title && merged.find(b => b.id === renamed.id).y === renamed.y && merged.length === current.length + 1 && current.every(b => merged.some(x => x.id === b.id)), 'selected changes apply and absent wall bands stay');
    await reload(page);
    ok(JSON.stringify(await bands()) === JSON.stringify(merged), 'imported bands persist');

    ok(await page.evaluate(() => {
      const bands = [null, {id: 1, title: 'bad', y: 0}, {id: 'title', title: 1, y: 0}, {id: 'long', title: '字'.repeat(61), y: 0},
        {id: 'nan', title: '', y: NaN}, {id: 'inf', title: '', y: Infinity}, {id: 'str', title: '', y: '1'},
        {id: 'ok', title: '字'.repeat(60), y: -5}, {id: 'ok', title: 'duplicate', y: 2}];
      const n = normalize({cards: [], edges: [], bands});
      return n.bands.length === 1 && n.bands[0].id === 'ok' && n.bands[0].title.length === 60 && n.bands[0].y === -5
        && normalize({cards: [], edges: []}).bands === undefined && normalize({cards: [], edges: [], bands: []}).bands.length === 0;
    }), 'normalize skips invalid bands and duplicate ids, preserving absent versus empty bands');

    const payload = '<img src=x onerror=alert(1)>';
    await open({cards: [], edges: [], bands: [{id: 'incoming', title: payload, y: -200}]});
    ok((await page.textContent('#im-list')).includes(payload) && await page.locator('#im-list img').count() === 0, 'malicious title is text in import preview');
    await page.click('#im-apply'); await settled(page);
    ok(await label('incoming').textContent() === payload && await page.locator('img:not(#sidebar img)').count() === 0 && dialogs.length === 0, 'malicious title renders only as text on wall');

    const download = page.waitForEvent('download');
    await page.click('#export');
    const chunks = [];
    for await (const chunk of await (await download).createReadStream()) chunks.push(chunk);
    ok(JSON.parse(Buffer.concat(chunks).toString()).bands.find(b => b.id === 'incoming').title === payload, 'export includes bands');

    const beforeReplace = await bands();
    await open({cards: seed.cards, edges: seed.edges});
    await page.click('#im-replace'); await page.click('#im-replace'); await settled(page);
    ok(JSON.stringify(await bands()) === JSON.stringify(beforeReplace), 'replace without bands preserves current bands');
    await open({cards: [], edges: [], bands: [{id: 'only', title: '唯一分層', y: 400}]});
    await page.click('#im-replace'); await page.click('#im-replace'); await settled(page);
    ok((await bands()).length === 1 && await label('only').count() === 1, 'replace uses supplied bands');
    await page.click('#zoom-fit');
    ok(await label('only').isVisible() && await page.evaluate(() => Number.isFinite(view.s) && Number.isFinite(view.y)), 'fit handles a wall with bands and no cards');
    await restoreBackup(page);
    ok(JSON.stringify(await bands()) === JSON.stringify(beforeReplace), 'backup restore restores and rerenders bands');
    await open({cards: seed.cards, edges: seed.edges, bands: []});
    await page.click('#im-replace'); await page.click('#im-replace'); await settled(page);
    await reload(page);
    ok((await bands()).length === 0 && await page.locator('.band').count() === 0, 'explicit empty bands survive replacement and reload');

    await open({cards: [], edges: [], bands: [{id: 'far', title: '很高的分層', y: -10000}, {id: 'below', title: '很低的分層', y: 10000}]});
    await page.click('#im-apply'); await settled(page); await page.click('#zoom-fit');
    ok(await page.evaluate(() => {
      const v = vp.getBoundingClientRect();
      return [...wall.querySelectorAll('.band-label, .card')].every(el => {
        const r = el.getBoundingClientRect();
        return r.top >= v.top && r.bottom <= v.bottom;
      }) && [...wall.querySelectorAll('.band')].map(el => el.dataset.id).join(',') === 'far,below';
    }), '全覽 includes bands far above and below cards, rendered in y order');
    await openActivity(page, 'files'); await page.click('#reset'); await page.click('#reset'); await settled(page);
    ok(JSON.stringify(await bands()) === JSON.stringify(seed.bands) && await page.locator('.band').count() === 3, 'reset restores seed bands');
    ok(errs.length === 0, 'no page errors ' + errs.join('; '));
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
