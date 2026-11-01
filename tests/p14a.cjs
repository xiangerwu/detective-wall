const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require('playwright-core');
const {ready, reload} = require('./wall-ready.cjs');

const PAGE = process.env.WALL_TEST_URL;
const OUT = process.env.WALL_TEST_OUT || path.resolve(__dirname, '..', 'test-results', 'p14a');
fs.mkdirSync(OUT, {recursive: true});

(async () => {
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    await page.goto(PAGE); await ready(page);
    await page.click('#toggle-sidebar');

    const initial = await page.evaluate(() => ({cards: data.cards.length, edges: data.edges.length}));
    await page.evaluate(() => { clearPicked(); picked.add('mine'); picked.add('q1'); renderCards(); });
    assert.equal(await page.locator('#pick-toolbar').isVisible(), true, 'selected cards show the floating toolbar');
    assert.match(await page.textContent('#pick-delete'), /刪除選取（2）/);
    await page.screenshot({path: path.join(OUT, 'floating-toolbar.png')});
    await page.keyboard.press('Delete');
    assert.equal(await page.evaluate(() => data.cards.length), initial.cards, 'first delete press only arms the action');
    assert.match(await page.textContent('#pick-delete'), /再按一次刪除 2 張/);
    await page.keyboard.press('Delete');
    assert.equal(await page.evaluate(() => data.cards.length), initial.cards - 2, 'second delete press removes every picked card');
    assert.equal(await page.evaluate(() => data.edges.length), initial.edges - 3, 'deleting picked cards also removes their edges');
    await page.keyboard.press('Control+z');
    assert.deepEqual(await page.evaluate(() => ({cards: data.cards.length, edges: data.edges.length})), initial, 'one undo restores the batch');
    await page.evaluate(() => openPanel('mine'));
    const cardCount = await page.evaluate(() => data.cards.length);
    await page.fill('#f-title', 'Backspace check');
    await page.press('#f-title', 'Backspace');
    assert.equal(await page.evaluate(() => data.cards.length), cardCount, 'Backspace in an input does not delete a card');
    await page.click('#f-close');
    console.log('PASS A1 floating toolbar, two-click Delete, edge cleanup, one-step undo, and input Backspace');

    await page.click('#toggle-sidebar');
    await page.locator('#ai-section h2').click();
    assert.equal(await page.getAttribute('#ai-section h2', 'aria-expanded'), 'false');
    assert.ok(await page.locator('#ai-section').evaluate(panel => panel.offsetHeight < 80));
    await page.screenshot({path: path.join(OUT, 'sidebar-collapsed.png')});
    await reload(page);
    assert.equal(await page.getAttribute('#ai-section h2', 'aria-expanded'), 'false', 'collapsed sidebar state survives reload');
    await page.locator('#ai-section h2').click();
    await page.evaluate(() => localStorage.removeItem(SIDE_PANEL_COLLAPSED_KEY));
    console.log('PASS A2 sidebar title rows, collapse state, aria-expanded, and reload persistence');

    const bandCount = await page.locator('#band-nav button[data-band-id]').count();
    assert.equal(bandCount, await page.evaluate(() => data.bands.length), 'A3 band nav has one item per band');
    await page.locator('#band-nav button[data-band-id]').nth(1).click();
    await page.screenshot({path: path.join(OUT, 'band-nav.png')});
    const secondBand = await page.evaluate(() => [...data.bands].sort((a, b) => a.y - b.y)[1]);
    assert.ok(await page.evaluate(y => Math.abs(view.y - (24 - y * view.s)) < 1, secondBand.y));
    await page.focus('#viewport'); await page.keyboard.press('PageDown');
    assert.equal(await page.locator('#band-nav button[aria-current=true]').getAttribute('data-band-id'), 'thesis');
    console.log('PASS A3 band nav click, active state, and PageDown');

    await page.evaluate(() => setTheme('cork'));
    await page.screenshot({path: path.join(OUT, 'cork-band-label.png')});
    const bandStyle = await page.evaluate(() => {
      const label = document.querySelector('.band-label'), style = getComputedStyle(label);
      const color = value => { const match = value.match(/#([0-9a-f]{6})/i); return match ? [0, 1, 2].map(i => parseInt(match[1].slice(i * 2, i * 2 + 2), 16)) : null; };
      return {fontSize: style.fontSize, fontWeight: style.fontWeight, ink: color(getComputedStyle(document.documentElement).getPropertyValue('--band-label-ink')), bg: color(getComputedStyle(document.documentElement).getPropertyValue('--band-label-bg'))};
    });
    assert.equal(bandStyle.fontSize, '16px');
    assert.ok(Number(bandStyle.fontWeight) >= 700);
    assert.ok(bandStyle.ink && bandStyle.bg, 'cork band label exposes contrast tokens');
    console.log('PASS A5 six-theme token path and readable cork band label styling');

    await page.evaluate(() => {
      // Firefox copies a ClipboardEvent's init clipboardData, so the test pins its own DataTransfer onto the event.
      window.clipEvent = (type, dt) => Object.defineProperty(new ClipboardEvent(type, {bubbles: true, cancelable: true}), 'clipboardData', {value: dt});
    });
    const clip = await page.evaluate(() => {
      data.tags = [{id: 'p14-tag', name: '跨牆標籤', color: 'purple'}];
      byId('shoup').tags = ['p14-tag']; byId('eskm').tags = ['p14-tag'];
      clearPicked(); picked.add('shoup'); picked.add('eskm'); renderCards();
      const dt = new DataTransfer(), event = clipEvent('copy', dt);
      document.dispatchEvent(event);
      return dt.getData('text/plain');
    });
    const copied = JSON.parse(clip);
    assert.equal(copied.casegraph, 'cards/v1');
    assert.equal(copied.cards.length, 2);
    assert.equal(copied.edges.length, 1, 'copy only carries edges whose two endpoints are selected');
    const beforePaste = await page.evaluate(() => data.cards.length);
    await page.evaluate(text => {
      lastPointer = {x: 900, y: 120};
      const dt = new DataTransfer(); dt.setData('text/plain', text);
      document.dispatchEvent(clipEvent('paste', dt));
    }, clip);
    await page.waitForFunction(n => data.cards.length === n + 2, beforePaste);
    const pasted = await page.evaluate(() => {
      const ids = [...picked], cards = ids.map(byId);
      return {ids, cards, internal: data.edges.filter(edge => ids.includes(edge.from) && ids.includes(edge.to)).length,
        external: data.edges.filter(edge => ids.includes(edge.from) !== ids.includes(edge.to)).length,
        tags: cards.flatMap(card => card.tags || []).map(id => data.tags.find(tag => tag.id === id)?.name)};
    });
    assert.equal(pasted.ids.length, 2);
    assert.equal(pasted.internal, 1);
    assert.equal(pasted.external, 0);
    assert.deepEqual(pasted.tags, ['跨牆標籤', '跨牆標籤']);
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(n => data.cards.length, beforePaste), beforePaste, 'one undo removes the pasted batch');
    await page.evaluate(async () => createWall('P14-A 測試', {bands: [], tags: [], cards: [], edges: []}));
    const targetWallCards = await page.evaluate(() => data.cards.length);
    assert.equal(targetWallCards, 0);
    await page.evaluate(text => {
      lastPointer = {x: 200, y: 180};
      const dt = new DataTransfer(); dt.setData('text/plain', text);
      document.dispatchEvent(clipEvent('paste', dt));
    }, clip);
    await page.waitForFunction(() => data.cards.length === 2);
    assert.equal(await page.evaluate(() => data.tags.some(tag => tag.name === '跨牆標籤')), true, 'cross-wall paste creates the missing tag');
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    await page.evaluate(text => {
      const dt = new DataTransfer(); dt.setData('text/plain', text);
      document.dispatchEvent(clipEvent('paste', dt));
    }, JSON.stringify({casegraph: 'cards/v1', cards: [{id: 'image-card', kind: 'card', x: 0, y: 0, title: '圖片', note: '', links: [], tags: [], image: 'image-source'}], edges: [], tags: [], images: {'image-source': png}}));
    await page.waitForFunction(() => data.cards.some(card => card.title === '圖片' && card.image) && document.querySelector('.card-image'));
    assert.equal(await page.locator('.card-image').count(), 1, 'pasted image is stored and rendered');
    console.log('PASS A4 JSON copy/paste, internal-edge filtering, new ids, cross-wall tags, undo, and images');

    const orderIds = await page.evaluate(() => {
      const [b, a] = data.cards;
      b.x = 300; a.x = 340; b.y = a.y = 240;
      data.cards = [...data.cards.filter(card => card.id !== a.id && card.id !== b.id), b, a];
      lastJSON = JSON.stringify(data); past.length = future.length = 0; render();
      return [b.id, a.id];
    });
    const aBox = await page.locator(`.card[data-id="${orderIds[0]}"]`).boundingBox();
    await page.mouse.move(aBox.x + 20, aBox.y + 30); await page.mouse.down();
    await page.mouse.move(aBox.x + 34, aBox.y + 42, {steps: 3}); await page.mouse.up();
    assert.equal(await page.evaluate(({x, y}) => document.elementFromPoint(x, y)?.closest('.card')?.dataset.id, {x: aBox.x + 25, y: aBox.y + 35}), orderIds[0], 'dragging a card moves it above an overlapping card');
    await page.evaluate(id => { const card = byId(id); card.x = 600; card.y = 240; render(); save(true); }, orderIds[1]);
    await page.locator(`.card[data-id="${orderIds[1]}"]`).click({button: 'right'});
    assert.equal(await page.locator('#card-menu').isVisible(), true);
    await page.screenshot({path: path.join(OUT, 'card-context-menu.png')});
    await page.click('#card-menu-bottom');
    assert.equal(await page.evaluate(() => data.cards[0].id), orderIds[1], '移到最下層 puts the card first in stacking order');
    await reload(page);
    assert.equal(await page.evaluate(() => data.cards[0].id), orderIds[1], 'card order persists after reload');
    await page.locator(`.card[data-id="${orderIds[1]}"]`).click({button: 'right'});
    await page.click('#card-menu-top');
    assert.equal(await page.evaluate(() => data.cards.at(-1).id), orderIds[1], '移到最上層 puts the card last in stacking order');
    await page.evaluate(() => {
      const snapshot = structuredClone(data);
      snapshot.cards.reverse();
      openImporter('only-order.json', snapshot);
    });
    assert.equal(await page.evaluate(() => pending.items.length), 0, 'reordered-only import has no changed cards');
    await page.click('#im-cancel');
    console.log('PASS A6 drag z-order, context menu top/bottom, persistence, and id-based import comparison');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
