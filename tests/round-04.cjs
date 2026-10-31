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
    await page.goto(PAGE); await ready(page); await openActivity(page, 'tags');
    await page.evaluate(() => setCardStyle('tech'));
    const tags = () => page.evaluate(() => structuredClone(data.tags));
    const card = id => page.locator(`.card[data-id="${id}"]`);
    const chip = id => page.locator(`#tag-filter .tag-chip[data-id="${id}"]`);
    const add = async (id, name) => {
      await page.evaluate(id => openPanel(id), id);
      await page.fill('#f-tag', name);
      await page.press('#f-tag', 'Enter');
    };
    const open = async d => {
      await openActivity(page, 'files');
      await page.setInputFiles('#import-file', {name: 'tags.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(d))});
      await page.waitForSelector('#importer[open]');
    };
    const replace = async d => { await open(d); await page.click('#im-replace'); await page.click('#im-replace'); await settled(page); await openActivity(page, 'tags'); };

    ok(!(await page.isVisible('#tag-filter')) && (await tags()).length === 0, 'no tags hides filter bar');
    await page.evaluate(() => { const old = structuredClone(data); delete old.tags; return store.putWall(currentWall.id, currentWall.name, old); });
    await reload(page);
    ok((await tags()).length === 0, 'load defaults missing tags to an empty array');
    await add('shoup', '  Witnesses  ');
    const witness = (await tags())[0];
    ok(witness.name === 'Witnesses' && witness.color === 'slate' && await card('shoup').locator('.tag-chip').textContent() === 'Witnesses', 'panel creates a trimmed tag and shows its card chip');
    await add('dt', 'wITNESSES');
    ok((await tags()).length === 1 && await page.evaluate(id => byId('dt').tags[0] === id, witness.id), 'different-case name reuses existing definition');
    await reload(page);
    ok(await page.evaluate(async id => ['shoup', 'dt'].every(c => byId(c).tags.includes(id)) && (await store.getWall(currentWall.id)).data.tags[0].id === id, witness.id), 'both assignments and definition persist after reload');
    await add('shoup', 'Witnesses');
    ok(await page.evaluate(() => byId('shoup').tags.length === 1), 'adding an assigned tag does not duplicate it');
    await add('shoup', '   ');
    ok((await tags()).length === 1, 'blank names do not add tags');
    await page.evaluate(() => { const input = $('#f-tag'); input.value = 'x'.repeat(31); input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})); });
    ok((await tags()).length === 1, 'overlong names are rejected even outside native maxlength');
    await add('pss', '2024 tender');
    const tender = (await tags())[1];
    ok(tender.color === 'amber' && await page.locator('#tag-names option').count() === 2, 'new tags rotate palette colours and populate datalist');
    await add('shoup', '2024 tender');
    ok(await card('shoup').locator('.tag-chip').count() === 2, 'one card can carry several tags');
    await page.getByRole('button', {name: '移除標籤：2024 tender', exact: true}).click();
    ok(await card('shoup').locator('.tag-chip').count() === 1 && await page.evaluate(id => !byId('shoup').tags.includes(id), tender.id), '× removes only the selected card assignment');
    await reload(page);
    ok(await card('shoup').locator('.tag-chip').count() === 1 && (await tags()).length === 2, 'removal persists without deleting definition');
    await page.evaluate(() => { byId('shoup').tags.push('unknown'); data.edges.forEach(e => { e.label = e.id; }); save(); render(); });
    ok(await card('shoup').locator('.tag-chip').count() === 1, 'unknown tag ids are ignored on cards');

    await chip(witness.id).locator('.tag-toggle').click();
    ok(await card('shoup').evaluate(el => !el.classList.contains('dim')) && await card('dt').evaluate(el => !el.classList.contains('dim')) && await card('pss').evaluate(el => el.classList.contains('dim') && getComputedStyle(el).opacity === '0.15'), 'filter dims only cards without active tags');
    ok(await page.locator('.hit[data-id="e1"]').evaluate(el => !el.previousElementSibling.classList.contains('dim')) && await page.locator('.hit[data-id="e2"]').evaluate(el => el.previousElementSibling.classList.contains('dim')) && await page.locator('.str-label[data-id="e2"]').evaluate(el => el.classList.contains('dim') && getComputedStyle(el).opacity === '0.15'), 'strings and labels dim when either end is dimmed');
    await page.click('#zoom-fit');
    const before = await page.evaluate(() => ({...byId('pss'), scale: view.s})), box = await card('pss').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 15, {steps: 5}); await page.mouse.up();
    ok(await page.evaluate(b => Math.abs(byId('pss').x - b.x - 30 / b.scale) < 1, before), 'dimmed cards remain draggable');
    await card('pss').locator('h3').click();
    ok(await page.isVisible('#panel') && await page.evaluate(() => selCard === 'pss'), 'dimmed cards remain clickable');
    await page.click('#f-close');
    await chip(tender.id).locator('.tag-toggle').click();
    ok(await card('pss').evaluate(el => !el.classList.contains('dim')) && await card('shoup').evaluate(el => !el.classList.contains('dim')) && await card('mine').evaluate(el => el.classList.contains('dim')), 'multiple active tags use OR matching');
    await page.getByRole('button', {name: '全部', exact: true}).click();
    ok(await page.locator('.dim').count() === 0, '全部 clears cards, strings and labels');
    await chip(witness.id).locator('.tag-toggle').click();
    await reload(page);
    ok(await page.locator('.dim').count() === 0 && await page.evaluate(async () => !('activeTags' in (await store.getWall(currentWall.id)).data)), 'filter state is not saved and reload clears it');

    await chip(witness.id).locator('.tag-edit').click();
    await page.fill('#tag-name', '  Sources  ');
    await page.click('#tagpop [data-color="green"]');
    ok((await tags())[0].name === 'Sources' && (await tags())[0].color === 'green' && await card('shoup').locator('.tag-chip').evaluate(el => el.textContent === 'Sources' && getComputedStyle(el).color === 'rgb(61, 220, 132)' && getComputedStyle(el).backgroundColor === 'rgb(18, 48, 31)'), '✎ renames and recolours using palette chip colours');
    const popup = await page.locator('#tagpop').boundingBox();
    await page.click('#zoom-out');
    const zoomed = await page.locator('#tagpop').boundingBox();
    ok(await page.locator('#tagpop').evaluate(el => el.closest('#activity-panel') && getComputedStyle(el).transform === 'none') && Math.abs(popup.width - zoomed.width) < 1, 'tag popup is in the activity panel without inverse zoom scaling');
    await reload(page);
    ok((await tags())[0].name === 'Sources' && (await tags())[0].color === 'green', 'rename and colour persist');
    await chip(witness.id).locator('.tag-toggle').click();
    await chip(witness.id).locator('.tag-edit').click();
    await page.getByRole('button', {name: '刪除標籤', exact: true}).click();
    ok((await tags()).length === 2 && await page.evaluate(id => byId('dt').tags.includes(id), witness.id), 'first delete click only arms');
    await page.getByRole('button', {name: '再按一次刪除', exact: true}).click();
    ok((await tags()).length === 1 && await page.evaluate(id => data.cards.every(c => !(c.tags || []).includes(id)), witness.id) && await page.locator('.dim').count() === 0 && !(await page.isVisible('#tagpop')), 'second delete removes definition and every assignment, clears stale filter');
    await reload(page);
    ok((await tags()).length === 1 && await card('dt').locator('.tag-chip').count() === 0, 'tag deletion persists');

    const incoming = {cards: [{id: 'new-card', title: 'Imported clue', tags: ['new-tag']}], edges: [], tags: [{id: 'new-tag', name: 'Imported', color: 'purple'}]};
    await open(incoming);
    await page.click('#im-none');
    ok(await page.isDisabled('#im-apply') && !(await tags()).some(t => t.id === 'new-tag'), 'unselected import adds no definitions');
    await page.click('#im-all'); await page.click('#im-apply'); await settled(page); await openActivity(page, 'tags');
    ok((await tags()).some(t => t.id === 'new-tag' && t.color === 'purple') && await card('new-card').locator('.tag-chip').textContent() === 'Imported', 'applying a card automatically adds its missing tag definition');
    const changed = {cards: [], edges: [], tags: [{id: 'new-tag', name: 'Updated', color: 'red'}]};
    await open(changed);
    ok(await page.locator('#im-list h3').textContent() === '有變更的標籤' && (await page.textContent('#im-list')).includes('Imported') && (await page.textContent('#im-list')).includes('Updated'), 'changed definition has a selectable group with name and colour diff');
    await page.click('#im-none');
    ok(await page.isDisabled('#im-apply'), 'changed definitions participate in selection');
    await page.click('#im-cancel');
    ok((await tags()).find(t => t.id === 'new-tag').name === 'Imported', 'cancelling leaves definition unchanged');
    await open(changed); await page.click('#im-apply'); await settled(page); await openActivity(page, 'tags');
    ok((await tags()).find(t => t.id === 'new-tag').color === 'red' && await card('new-card').locator('.tag-chip').textContent() === 'Updated', 'selected definition updates existing cards');
    const c = await page.evaluate(() => structuredClone(byId('new-card')));
    await open({cards: [{...c, tags: [tender.id]}], edges: []});
    ok((await page.textContent('#im-list')).includes('標籤：Updated → 2024 tender'), 'cardDiff compares tag names');
    await page.click('#im-apply'); await settled(page); await openActivity(page, 'tags');
    ok(await card('new-card').locator('.tag-chip').textContent() === '2024 tender', 'card tag change applies with existing definitions');

    ok(await page.evaluate(() => {
      const n = normalize({cards: [{id: 'test', tags: ['a', 'a', 1, null, 'b']}], edges: [], tags: [null, {id: 1, name: 'bad'},
        {id: 'blank', name: '  '}, {id: 'long', name: 'x'.repeat(31)}, {id: 'a', name: ' A ', color: 'invalid'},
        {id: 'a', name: 'duplicate', color: 'red'}, {id: 'b', name: 'x'.repeat(30), color: 'green'}, {id: 'c', name: 'C', color: 'toString'}]});
      return JSON.stringify(n.cards[0].tags) === '["a","b"]' && n.tags.length === 3 && n.tags[0].name === 'A' && n.tags[0].color === 'slate'
        && n.tags[1].color === 'green' && n.tags[2].color === 'slate' && normalize({cards: [], edges: []}).tags === undefined;
    }), 'normalize validates names and palette, defaults invalid colours and deduplicates ids');
    const payload = '<img src=x onerror=alert(1)>';
    await open({cards: [c], edges: [], tags: [{id: 'new-tag', name: payload, color: 'cream'}]});
    ok((await page.textContent('#im-list')).includes(payload) && await page.locator('#im-list img').count() === 0, 'malicious tag name is literal text in preview');
    await page.click('#im-apply'); await settled(page); await openActivity(page, 'tags');
    await page.evaluate(() => openPanel('new-card'));
    ok(await card('new-card').locator('.tag-chip').textContent() === payload && (await page.textContent('#f-tags')).includes(payload) && await chip('new-tag').locator('.tag-toggle').textContent() === payload && await page.locator('img:not(#sidebar img)').count() === 0 && dialogs.length === 0, 'malicious tag name stays text on card, panel and filter');
    await page.click('#f-close');
    const download = page.waitForEvent('download');
    await openActivity(page, 'files'); await page.click('#export');
    const chunks = [];
    for await (const chunk of await (await download).createReadStream()) chunks.push(chunk);
    const exported = JSON.parse(Buffer.concat(chunks).toString());
    ok(exported.tags.find(t => t.id === 'new-tag').name === payload && exported.cards.find(c => c.id === 'new-card').tags[0] === 'new-tag', 'export includes definitions and card assignments');
    const saved = await tags();
    await replace({cards: [c], edges: []});
    ok(JSON.stringify(await tags()) === JSON.stringify(saved), 'whole replacement without tags retains current definitions');
    await replace({cards: [c], edges: [], tags: [{id: 'new-tag', name: 'Only', color: 'amber'}]});
    ok((await tags()).length === 1 && await card('new-card').locator('.tag-chip').textContent() === 'Only', 'whole replacement uses file tags');
    await restoreBackup(page);
    ok(JSON.stringify(await tags()) === JSON.stringify(saved), 'backup restore restores tag definitions');
    await replace({cards: [], edges: [], tags: []});
    await reload(page);
    ok((await tags()).length === 0 && !(await page.isVisible('#tag-filter')), 'explicit empty tags replace and persist');
    ok(dialogs.length === 0, 'no dialogs ' + dialogs.join('; '));
    ok(errs.length === 0, 'no page errors ' + errs.join('; '));
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
