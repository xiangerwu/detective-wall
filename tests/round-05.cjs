const { ready, reload, settled, openActivity, restoreBackup } = require('./wall-ready.cjs');
const playwright = require('playwright-core');
const path = require('path');
const PAGE = process.env.WALL_TEST_URL || path.join(__dirname, '..', 'index.html');
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1; };

(async () => {
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    await page.goto(PAGE); await ready(page); await openActivity(page, 'files');
    const state = () => page.evaluate(() => JSON.stringify(data));
    const seed = await state();
    const fresh = async () => {
      await page.evaluate(async json => { await store.deleteBackups(currentWall.id); await store.putWall(currentWall.id, currentWall.name, JSON.parse(json)); }, seed);
      await reload(page);
      // Advance only the history clock; browser input and animation still run normally.
      await page.evaluate(() => { window.testNow = 1000; performance.now = () => window.testNow; });
    };
    const tick = (ms = 501) => page.evaluate(ms => { window.testNow += ms; }, ms);
    const saved = () => page.evaluate(async () => JSON.stringify((await store.getWall(currentWall.id)).data) === JSON.stringify(data) && lastJSON === JSON.stringify(data));
    const rendered = () => page.evaluate(() =>
      document.querySelectorAll('.card').length === data.cards.length &&
      document.querySelectorAll('.band').length === data.bands.length &&
      document.querySelectorAll('.hit').length === data.edges.length &&
      data.cards.every(c => [...document.querySelectorAll('.card')].some(el => el.dataset.id === c.id &&
        el.querySelector('h3').textContent === (c.title || '（未命名）') &&
        Math.abs(parseFloat(el.style.left) - c.x) < .01 && Math.abs(parseFloat(el.style.top) - c.y) < .01 && el.classList.contains('c-' + colorOf(c)))));
    const roundtrip = async (name, action) => {
      const before = await state(), count = await page.evaluate(() => past.length);
      await action(); await settled(page);
      const after = await state();
      ok(after !== before && await page.evaluate(n => past.length === n + 1, count), name + ' records one step');
      await page.click('#undo');
      ok(await state() === before && await saved() && await rendered(), name + ' undo restores and saves all data');
      await page.click('#redo');
      ok(await state() === after && await saved() && await rendered(), name + ' redo restores and saves all data');
    };
    const open = async d => {
      await openActivity(page, 'files');
      await page.setInputFiles('#import-file', {name: 'history.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(d))});
      await page.waitForSelector('#importer[open]');
    };
    const twice = async selector => { await page.click(selector); await page.click(selector); };
    const keyEvent = (key, modifiers = {}, selector = 'body') => page.evaluate(({key, modifiers, selector}) => {
      const ev = new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true, ...modifiers});
      document.querySelector(selector).dispatchEvent(ev);
      return ev.defaultPrevented;
    }, {key, modifiers, selector});

    await fresh();
    ok(await page.isDisabled('#undo') && await page.isDisabled('#redo'), 'initial history buttons are disabled');
    ok(await page.getAttribute('#undo', 'title') === '復原（Ctrl+Z）' && await page.getAttribute('#redo', 'title') === '重做（Ctrl+Y）', 'history buttons have requested titles');
    ok(!(await keyEvent('z', {ctrlKey: true})), 'empty undo leaves browser default alone');
    await page.evaluate(async () => {
      const old = structuredClone(data);
      delete old.bands; delete old.tags;
      old.cards[0].title = 'Migration keeps this card';
      localStorage.setItem(KEY, JSON.stringify(old));
      await store.deleteWall(currentWall.id); // Recreate first-run migration, including history initialization.
    });
    await reload(page);
    ok(await page.evaluate(async () => data.cards[0].title === 'Migration keeps this card' && data.bands.length === SEED.bands.length &&
      data.tags.length === 0 && !past.length && !future.length && lastJSON === JSON.stringify(data) && JSON.stringify((await store.getWall(currentWall.id)).data) === lastJSON), 'migration writes without TDZ errors or recording history');

    await fresh();
    await page.click('#zoom-fit');
    await roundtrip('move a card', async () => {
      const box = await page.locator('.card[data-id="shoup"]').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 25, {steps: 5});
      await page.mouse.up();
    });

    await fresh();
    await page.evaluate(() => openPanel('shoup'));
    await roundtrip('delete a card with its strings', async () => {
      await twice('#f-del');
      ok(await page.evaluate(() => !byId('shoup') && !data.edges.some(e => e.from === 'shoup' || e.to === 'shoup')), 'deletion removes incident strings');
    });
    await page.click('#undo');
    ok(!(await page.isVisible('#panel')), 'undo deletion leaves a closed panel closed');
    await reload(page);
    ok(await state() === seed && await rendered() && await saved(), 'restored card and strings survive reload with panel closed');
    ok(await page.isDisabled('#undo') && await page.isDisabled('#redo'), 'reload clears in-memory history');

    await fresh();
    await page.click('#zoom-fit');
    await roundtrip('add a string', async () => {
      const a = await page.locator('.card[data-id="shoup"] .pin').boundingBox();
      const b = await page.locator('.card[data-id="pss"] h3').boundingBox();
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, {steps: 5});
      await page.mouse.up();
      ok(await page.evaluate(() => data.edges.length === SEED.edges.length + 1), 'pin drag creates a string');
    });

    await fresh();
    await page.evaluate(() => selectEdge('e1', {x: 200, y: 300}));
    await roundtrip('change an edge label', () => page.fill('#edge-label', 'Evidence'));
    ok(await page.locator('.str-label[data-id="e1"]').textContent() === 'Evidence' && !(await page.isVisible('#edgepop')), 'redo refreshes label and closes edge popup');
    await fresh();
    await roundtrip('add a band', () => page.click('#add-band'));
    ok(!(await page.isVisible('#bandpop')), 'history closes band popup');
    await fresh();
    await page.evaluate(() => openPanel('shoup'));
    await roundtrip('change a colour', () => page.click('#f-color [data-color="green"]'));
    ok(await page.isVisible('#panel') && await page.locator('#f-color [data-color="green"]').getAttribute('aria-checked') === 'true', 'open panel refreshes colour after history restore');
    await fresh();
    await page.evaluate(() => openPanel('shoup'));
    await roundtrip('add a tag', async () => { await page.fill('#f-tag', 'Sources'); await page.press('#f-tag', 'Enter'); });
    ok(await page.locator('.card[data-id="shoup"] .tag-chip').textContent() === 'Sources' && (await page.textContent('#f-tags')).includes('Sources'), 'tag definition and panel assignment render on redo');

    const incoming = {cards: [{id: 'imported', kind: 'card', x: 200, y: 200, title: 'Imported', note: 'Note', links: [], tags: ['source']}],
      edges: [{from: 'imported', to: 'shoup', type: 'uses', label: 'Imported string'}],
      bands: [{id: 'import-band', title: 'Imported band', y: 250}], tags: [{id: 'source', name: 'Source', color: 'red'}]};
    await fresh();
    await page.evaluate(() => openPanel('shoup'));
    await page.fill('#f-title', 'Before import');
    await roundtrip('apply import immediately after editing', async () => { await open(incoming); await page.click('#im-apply'); await settled(page); });
    ok(await page.locator('.card[data-id="imported"] .tag-chip').textContent() === 'Source', 'import redo renders imported tag');
    await roundtrip('edit immediately after import', async () => { await page.evaluate(() => openPanel('shoup')); await page.fill('#f-title', 'After import'); });
    await roundtrip('restore import backup', () => restoreBackup(page));
    ok(await page.evaluate(async () => (await store.listBackups(currentWall.id)).length === 2), 'undo and redo leave backup versions unchanged');
    await roundtrip('replace whole wall', async () => { await open({...incoming, edges: []}); await twice('#im-replace'); });
    await openActivity(page, 'files');
    await roundtrip('reset', () => twice('#reset'));

    await fresh();
    await page.evaluate(() => openPanel('shoup'));
    const title = await page.inputValue('#f-title');
    await page.focus('#f-title');
    await page.press('#f-title', 'End');
    await page.type('#f-title', 'ABC', {delay: 20});
    await tick(499);
    await page.type('#f-title', 'D');
    ok(await page.evaluate(() => past.length === 1), 'rapid title typing including a 499 ms gap coalesces');
    await page.click('#undo');
    ok(await page.inputValue('#f-title') === title && await page.isVisible('#panel') && await page.isDisabled('#undo') && !(await page.isDisabled('#redo')), 'one undo restores title, panel and button states');
    await page.click('#redo');
    ok(await page.inputValue('#f-title') === title + 'ABCD' && !(await page.isDisabled('#undo')) && await page.isDisabled('#redo'), 'redo restores complete typed title and button states');
    await page.fill('#f-title', title + 'ABCD!');
    await tick(500);
    await page.fill('#f-title', title + 'ABCD!!');
    ok(await page.evaluate(() => past.length === 3), '500 ms boundary records another step');
    const beforeNative = await state();
    await page.focus('#f-note');
    await page.keyboard.press('Control+z');
    ok(await state() === beforeNative, 'Ctrl+Z in note textarea does not undo wall data');
    for (const selector of ['#f-title', '#f-note', '#f-kind']) {
      ok(!(await keyEvent('z', {ctrlKey: true}, selector)) && await state() === beforeNative, selector + ' leaves native undo alone');
    }
    await page.click('#f-close');
    await page.keyboard.press('Control+z');
    ok(await state() !== beforeNative, 'Ctrl+Z outside fields undoes wall data');
    await page.keyboard.press('Control+y');
    ok(await state() === beforeNative, 'Ctrl+Y outside fields redoes wall data');
    for (const [undoMods, redoKey, redoMods] of [
      [{ctrlKey: true}, 'y', {ctrlKey: true}],
      [{ctrlKey: true}, 'Z', {ctrlKey: true, shiftKey: true}],
      [{metaKey: true}, 'Z', {metaKey: true, shiftKey: true}],
    ]) {
      ok(await keyEvent('z', undoMods) && await state() !== beforeNative, 'undo shortcut handles ' + JSON.stringify(undoMods));
      ok(await keyEvent(redoKey, redoMods) && await state() === beforeNative, 'redo shortcut handles ' + redoKey + JSON.stringify(redoMods));
    }
    await open(incoming);
    const modalState = await state();
    ok(!(await keyEvent('z', {ctrlKey: true}, '#im-apply')) && !(await keyEvent('y', {ctrlKey: true}, '#im-apply')) && await state() === modalState, 'import dialog blocks history shortcuts without preventing defaults');
    await page.click('#im-cancel');
    await page.click('#undo');
    await page.evaluate(() => save());
    ok(!(await page.isDisabled('#redo')), 'unchanged save retains redo');
    await page.evaluate(() => openPanel('shoup'));
    const branch = await state();
    await page.fill('#f-title', 'New branch');
    ok(await page.isDisabled('#redo') && !(await keyEvent('y', {ctrlKey: true})), 'new change clears redo and empty redo leaves default alone');
    await page.click('#undo');
    ok(await state() === branch, 'first edit after undo is its own undoable step');

    await fresh();
    await page.evaluate(() => openPanel('shoup'));
    await page.fill('#f-tag', 'Temporary'); await page.press('#f-tag', 'Enter');
    await page.click('#f-close');
    await openActivity(page, 'tags');
    await page.locator('#tag-filter .tag-toggle').click();
    await page.evaluate(() => {
      openTag(data.tags[0]);
      selectEdge('e1', {x: 100, y: 100});
      spring.e1 = {s: 3, v: 2};
      window.viewerBefore = JSON.stringify({view, activeTags: [...activeTags], spring, selCard, selEdge});
      undo();
    });
    ok(await page.evaluate(() => viewerBefore === JSON.stringify({view, activeTags: [...activeTags], spring, selCard, selEdge}) &&
      $('#tagpop').hidden && pop.hidden && bandpop.hidden), 'undo preserves view, filter, selection and spring while closing popups');
    await page.click('#redo');
    ok(await page.locator('#tag-filter .tag-toggle').getAttribute('aria-pressed') === 'true', 'redo restores active filter chip');

    await fresh();
    await page.click('#add-card');
    await page.click('#undo');
    ok(!(await page.isVisible('#panel')) && await page.evaluate(() => selCard === null), 'undo creating selected card closes its panel');
    await fresh();
    await page.evaluate(() => {
      for (let i = 0; i < 105; i++) {
        window.testNow += 501;
        byId('shoup').title = 'Step ' + i;
        save();
      }
    });
    ok(await page.evaluate(() => past.length === 100 && future.length === 0), 'history caps past at 100 steps');
    await page.evaluate(() => { for (let i = 0; i < 100; i++) undo(); });
    ok(await page.evaluate(() => byId('shoup').title === 'Step 4' && past.length === 0 && future.length === 100 && !undo()) && await page.isDisabled('#undo'), '100 undos reach oldest retained state and cap future');
    await page.evaluate(() => { for (let i = 0; i < 100; i++) redo(); });
    ok(await page.evaluate(() => byId('shoup').title === 'Step 104' && past.length === 100 && future.length === 0 && !redo()) && await saved() && await page.isDisabled('#redo'), '100 redos restore latest saved state');
    ok(errs.length === 0, 'no page errors ' + errs.join('; '));
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
