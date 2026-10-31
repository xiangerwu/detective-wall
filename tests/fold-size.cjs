const { ready, reload, openActivity, artifacts } = require('./wall-ready.cjs');
const playwright = require('playwright-core');
const path = require('path');
const PAGE = process.env.WALL_TEST_URL || path.join(__dirname, '..', 'index.html');
const OUT = artifacts('fold-size');
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1; };

(async () => {
    const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    await page.goto(PAGE); await ready(page); await openActivity(page, 'theme');

    await page.selectOption('#theme', 'cork');
    const cork = () => page.evaluate(() => document.documentElement.dataset.theme === 'cork' && getComputedStyle(bg).backgroundImage.includes('cork.jpg'));
    ok(await cork(), 'cork theme paints the Cork004 texture');
    await reload(page);
    ok(await cork(), 'cork theme survives reload');

    // a card on screen that has an outgoing string, so its pin can be checked too
    const id = await page.evaluate(() => {
      const v = vp.getBoundingClientRect();
      return data.edges.map(e => e.from).find(id => { const r = document.querySelector(`.card[data-id="${id}"]`).getBoundingClientRect(); return r.top > v.top && r.bottom < v.bottom - 200 && r.left > v.left && r.right < v.right - 200; });
    });
    const card = page.locator(`.card[data-id="${id}"]`);
    const height = () => card.evaluate(el => el.offsetHeight);
    const h0 = await height();
    await card.click({ position: { x: 20, y: 30 } });
    const long = Array.from({ length: 14 }, (_, i) => `第 ${i + 1} 行筆記內容`).join('\n');
    await page.fill('#f-note', long);
    ok(await height() > h0 + 150 && await card.evaluate(el => [...el.querySelectorAll('.md, p')].every(b => b.scrollHeight <= b.clientHeight + 1) && el.textContent.includes('第 14 行')), `card grows with a long note (${h0} -> ${await height()}px) and shows all of it`);
    await page.screenshot({ path: path.join(OUT, 'long-note.png') });

    await page.click(`#f-pin [data-pin="s"]`);
    const startNearBottom = () => page.evaluate(id => {
      const c = byId(id), el = document.querySelector(`.card[data-id="${id}"]`), e = data.edges.find(e => e.from === id);
      const [, , y] = document.querySelector(`path.hit[data-id="${e.id}"]`).getAttribute('d').match(/^M(\S+) (\S+)/).map(Number);
      return Math.abs(y - (c.y + el.offsetHeight)) <= 3;
    }, id);
    ok(await startNearBottom(), 'bottom pin string starts at the bottom of the tall card');

    // The floating editor may cover the card; drag it to the half of the viewport away from the card.
    const c = await card.boundingBox(), v = await page.locator('#viewport').boundingBox(), t = await page.locator('#panel-titlebar').boundingBox();
    await page.mouse.move(t.x + 60, t.y + t.height / 2); await page.mouse.down();
    await page.mouse.move(c.x + c.width / 2 < v.x + v.width / 2 ? v.x + v.width - 5 : v.x + 5, t.y + t.height / 2, {steps: 5}); await page.mouse.up();
    const fold = card.locator('.fold');
    ok(await fold.isVisible() && await fold.getAttribute('aria-expanded') === 'true', 'card shows a fold button');
    await fold.click();
    ok(await card.evaluate(el => el.classList.contains('folded')) && await height() < 70 && !(await card.locator('.md, p').first().isVisible()) && await card.locator('h3').isVisible(),
      `fold button collapses the card to its title (${await height()}px)`);
    ok(await page.isChecked('#f-fold') && await page.isVisible('#panel'), 'editor checkbox follows the fold button, editor stays as it was');
    ok(await startNearBottom(), 'bottom pin string follows the folded card');
    await page.screenshot({ path: path.join(OUT, 'folded.png') });
    await reload(page);
    ok(await card.evaluate(el => el.classList.contains('folded')), 'fold state survives reload');
    ok(!(await page.isVisible('#panel')), 'clicking the fold button does not open the editor');
    await card.locator('.fold').click();
    ok(!(await card.evaluate(el => el.classList.contains('folded'))) && await height() > h0 + 150 && !(await page.isVisible('#panel')), 'clicking again expands it without opening the editor');

    await card.click({ position: { x: 20, y: 30 } });
    await page.check('#f-fold');
    ok(await card.evaluate(el => el.classList.contains('folded')), 'editor checkbox folds the card');
    await page.uncheck('#f-fold');
    await page.selectOption('#f-size', 'xl');
    ok(await card.evaluate(el => el.offsetWidth) === 360, 'xl width is 1.8x a clue card');
    await page.selectOption('#f-kind', 'note');
    ok(await card.evaluate(el => el.offsetWidth) === 306, 'xl width scales from the note width');
    await page.selectOption('#f-size', 's');
    await reload(page);
    ok(await card.evaluate(el => el.offsetWidth) === 136 && await page.evaluate(id => byId(id).size === 's', id), 'width choice survives reload');

    ok(await page.evaluate(() => {
      const n = normalize({cards: [{id: 'a', size: 'huge', fold: 'yes'}, {id: 'b', size: 'l', fold: true}], edges: []}).cards;
      return !('size' in n[0]) && !('fold' in n[0]) && n[1].size === 'l' && n[1].fold === true;
    }), 'import keeps valid width and fold values only');
    ok(await page.evaluate(id => { const fields = cardDiff(byId(id), {...byId(id), size: 'l', fold: true}).map(([f]) => f); return fields.includes('寬度') && fields.includes('折疊'); }, id), 'import preview lists width and fold changes');
    ok(errs.length === 0, 'no page errors ' + errs.join('; '));
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
