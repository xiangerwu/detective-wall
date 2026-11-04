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

    // a card on screen that has an outgoing string, so its fixed top pin can be checked too
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

    const startNearTop = () => page.evaluate(id => {
      const c = byId(id), el = document.querySelector(`.card[data-id="${id}"]`), pin = el.querySelector('.pin').getBoundingClientRect(), w = wall.getBoundingClientRect();
      return Math.abs((pin.left + pin.width / 2 - w.left) / view.s - (c.x + el.offsetWidth / 2)) <= 3
        && Math.abs((pin.top + pin.height / 2 - w.top) / view.s - c.y) <= 5;
    }, id);
    ok(await startNearTop(), 'fixed top pin stays at the top centre of the tall card');

    // The floating editor may cover the card; drag it to the half of the viewport away from the card.
    const c = await card.boundingBox(), v = await page.locator('#viewport').boundingBox(), t = await page.locator('#panel-titlebar').boundingBox();
    await page.mouse.move(t.x + 60, t.y + t.height / 2); await page.mouse.down();
    await page.mouse.move(c.x + c.width / 2 < v.x + v.width / 2 ? v.x + v.width - 5 : v.x + 5, t.y + t.height / 2, {steps: 5}); await page.mouse.up();
    const fold = card.locator('.fold');
    ok(await fold.isVisible() && await fold.getAttribute('aria-expanded') === 'true', 'card shows a fold button');
    await fold.click();
    ok(await card.evaluate(el => {
      const title = el.querySelector('h3')?.getBoundingClientRect(), flap = el.querySelector('.folded-flap')?.getBoundingClientRect();
      return el.classList.contains('folded') && !(el.querySelector('.md, p')?.offsetParent)
        && !!title && !!flap && title.bottom <= flap.top + 1 && el.querySelector('h3').offsetParent;
    }), `fold button keeps the title above the V1 front flap (${await height()}px)`);
    ok(await page.isChecked('#f-fold') && await page.isVisible('#panel'), 'editor checkbox follows the fold button, editor stays as it was');
    ok(await startNearTop(), 'top pin follows the folded card');
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
    const resize = await card.locator('.resize-handle').boundingBox();
    await page.mouse.move(resize.x + resize.width / 2, resize.y + resize.height / 2);
    await page.mouse.down(); await page.mouse.move(resize.x + 84, resize.y + 52, {steps: 5}); await page.mouse.up();
    ok(await page.evaluate(id => Number.isInteger(byId(id).w) && Number.isInteger(byId(id).h) && byId(id).w >= 120 && byId(id).h >= 60, id), 'resize handle stores integer width and height');
    await page.click('#f-size-reset');
    ok(await page.evaluate(id => !('w' in byId(id)) && !('h' in byId(id)), id), 'editor reset restores the default width and content height');
    await page.selectOption('#f-kind', 'note');
    ok(await card.evaluate(el => el.offsetWidth) === 170, 'note cards use the note default width');
    await reload(page);
    ok(await card.evaluate(el => el.offsetWidth) === 170 && await page.evaluate(id => !('w' in byId(id)) && !('h' in byId(id)), id), 'default dimensions survive reload');

    ok(await page.evaluate(() => {
      const n = normalize({cards: [{id: 'a', fold: 'yes'}, {id: 'b', fold: true}], edges: []}).cards;
      return !('fold' in n[0]) && n[1].fold === true;
    }), 'import keeps valid fold values only');
    ok(await page.evaluate(id => {
      const fields = cardDiff(byId(id), {...byId(id), w: 240, h: 200, mount: 'tape', fold: true}).map(([f]) => f);
      return fields.includes('寬度') && fields.includes('高度') && fields.includes('固定方式') && fields.includes('折疊');
    }, id), 'import preview lists numeric width, height, mount and fold changes');
    ok(errs.length === 0, 'no page errors ' + errs.join('; '));
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
