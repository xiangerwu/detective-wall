const assert = require('node:assert/strict');
const path = require('node:path');
const playwright = require('playwright-core');
const {ready, artifacts} = require('./wall-ready.cjs');

const base = process.env.WALL_TEST_URL;
const out = artifacts('p14d');

const fixture = {
  bands: [], tags: [],
  cards: [
    {id: 'p14d-wide', kind: 'card', w: 220, h: 150, x: 40, y: 80, title: '寬卡片', note: '固定尺寸', links: []},
    {id: 'p14d-note', kind: 'note', w: 170, h: 110, x: 120, y: 120, title: '重疊便利貼', note: '', links: []},
    {id: 'p14d-clear', kind: 'card', w: 180, h: 90, x: 760, y: 500, title: '未重疊卡', note: '', links: []},
  ],
  edges: [],
};

async function setFixture(page, selected = []) {
  await page.evaluate(async ({fixture, selected}) => {
    data = structuredClone(fixture);
    lastJSON = JSON.stringify(data);
    past.length = future.length = 0;
    clearPicked(); selected.forEach(id => picked.add(id));
    selCard = selEdge = drag = tempLine = null;
    render(); fitView(true);
    await store.putWall(currentWall.id, currentWall.name, data);
  }, {fixture, selected});
}

async function settled(page) {
  await page.waitForFunction(() => !wallBusy && !document.body.inert);
}

function positions(page) {
  return page.evaluate(() => Object.fromEntries(data.cards.map(card => [card.id, {x: card.x, y: card.y}])));
}

(async () => {
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base); await ready(page);

    await page.click('#layout-wall-arrow');
    assert.equal(await page.locator('#layout-wall-menu').isVisible(), true);
    assert.deepEqual(await page.locator('#layout-wall-menu [data-mode]').allTextContents(), ['推開重疊', '對齊格線', '全部重排']);
    assert.equal(await page.getAttribute('#layout-wall-arrow', 'aria-haspopup'), 'menu');
    await page.screenshot({path: path.join(out, 'dropdown.png')});
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.mode), 'grid');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#layout-wall-menu').isVisible(), false);
    assert.equal(await page.textContent('#layout-wall .rail-label'), '對齊格線');
    assert.equal(await page.locator('#layout-wall .rail-icon').count(), 1, 'changing the mode keeps the rail icon, so the icon rail never shows the mode as vertical text');
    assert.equal(await page.evaluate(() => localStorage.getItem(LAYOUT_MODE_KEY)), 'grid');
    await page.reload(); await ready(page);
    assert.equal(await page.textContent('#layout-wall .rail-label'), '對齊格線');
    console.log('PASS layout menu lists all modes, supports arrow-key selection, and remembers the main-button mode');

    await page.click('#layout-wall-arrow');
    await page.click('#layout-wall-menu [data-mode="overlap"]');
    await setFixture(page);
    const before = await positions(page);
    await page.screenshot({path: path.join(out, 'overlap-before.png')});
    await page.click('#layout-wall');
    await settled(page);
    const after = await positions(page);
    assert.ok(after['p14d-wide'].x !== before['p14d-wide'].x || after['p14d-wide'].y !== before['p14d-wide'].y
      || after['p14d-note'].x !== before['p14d-note'].x || after['p14d-note'].y !== before['p14d-note'].y);
    assert.deepEqual(after['p14d-clear'], before['p14d-clear']);
    const overlaps = await page.evaluate(() => {
      const boxes = data.cards.map(card => {
        const el = wall.querySelector(`.card[data-id="${CSS.escape(card.id)}"]`);
        return {x: card.x, y: card.y, width: el.offsetWidth, height: el.offsetHeight};
      });
      return boxes.some((a, i) => boxes.slice(i + 1).some(b => a.x < b.x + b.width + WallLayout.constants.gap
        && b.x < a.x + a.width + WallLayout.constants.gap && a.y < b.y + b.height + WallLayout.constants.gap
        && b.y < a.y + a.height + WallLayout.constants.gap));
    });
    assert.equal(overlaps, false);
    assert.match(await page.textContent('#wall-notice'), /已移動 2 張卡片/);
    await page.screenshot({path: path.join(out, 'overlap-after.png')});
    await page.click('#undo');
    await page.waitForFunction(expected => JSON.stringify(Object.fromEntries(data.cards.map(card => [card.id, {x: card.x, y: card.y}]))) === expected,
      JSON.stringify(before));
    console.log('PASS overlap mode moves only overlapping cards, follows real sizes, and restores in one undo');

    await setFixture(page, ['p14d-wide']);
    const selectedBefore = await positions(page);
    await page.click('#layout-wall');
    await settled(page);
    const selectedAfter = await positions(page);
    assert.deepEqual(selectedAfter['p14d-note'], selectedBefore['p14d-note']);
    assert.deepEqual(selectedAfter['p14d-clear'], selectedBefore['p14d-clear']);
    assert.notDeepEqual(selectedAfter['p14d-wide'], selectedBefore['p14d-wide']);
    console.log('PASS selected-card layout leaves every unselected card fixed');

    assert.deepEqual(errors, [], 'page errors: ' + errors.join('; '));
    console.log('PASS no page errors');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
