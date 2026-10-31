const { ready, reload, settled, artifacts, chooseWall, openTabMenu, renameWall } = require('./wall-ready.cjs');
const playwright = require('playwright-core');
const path = require('path');
const PAGE = process.env.WALL_TEST_URL || path.join(__dirname, '..', 'index.html');
const OUT = artifacts('tabs');
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1; };

(async () => {
    const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    await page.goto(PAGE); await ready(page);
    const names = () => page.locator('.wall-tab').allTextContents();
    const ids = () => page.locator('.wall-tab').evaluateAll(els => els.map(el => el.dataset.id));
    const current = () => page.evaluate(() => currentWall.id);

    const header = await page.locator('header').boundingBox(), tab0 = await page.locator('.wall-tab').boundingBox();
    ok(JSON.stringify(await names()) === '["案件圖譜"]' && await page.getAttribute('.wall-tab', 'aria-selected') === 'true', 'one selected tab at startup');
    ok(Math.abs(tab0.y + tab0.height - (header.y + header.height)) <= 2, 'tabs sit on the header bottom edge');
    ok(!(await page.isVisible('#storage-warning')) && await page.locator('#tabrow #storage-warning').count() === 1, 'storage warning shares the tab row');

    await page.click('#add-wall'); await settled(page);
    await page.click('#add-wall'); await settled(page);
    const [a, b, c] = await ids();
    ok(JSON.stringify(await names()) === '["案件圖譜","新的牆 1","新的牆 2"]' && await current() === c, '＋ appends a tab and switches to it');
    await chooseWall(page, a);
    ok(await current() === a && await page.getAttribute(`.wall-tab[data-id="${a}"]`, 'aria-selected') === 'true', 'clicking a tab switches walls');

    await renameWall(page, '主牆');
    ok((await names())[0] === '主牆' && await page.evaluate(async () => (await store.getWall(currentWall.id)).name === '主牆' && document.title.startsWith('主牆')), 'double-click renames the active tab');
    await page.dblclick(`.wall-tab[data-id="${a}"]`); await page.fill('.wall-tab input', '不要'); await page.press('.wall-tab input', 'Escape');
    ok((await names())[0] === '主牆' && await page.isVisible('.card'), 'Escape cancels a rename and leaves the wall alone');
    await renameWall(page, '第二面', b);
    ok(await current() === b && (await names())[1] === '第二面', 'double-click on another tab switches and renames it');

    const box = id => page.locator(`.wall-tab[data-id="${id}"]`).boundingBox();
    const from = await box(a), to = await box(c);
    await page.mouse.move(from.x + 10, from.y + 10); await page.mouse.down();
    await page.mouse.move(to.x + to.width - 4, to.y + 10, { steps: 8 }); await page.mouse.up();
    ok(JSON.stringify(await ids()) === JSON.stringify([b, c, a]) && await current() === b, 'dragging a tab reorders without switching');
    await reload(page);
    ok(JSON.stringify(await ids()) === JSON.stringify([b, c, a]), 'tab order survives reload');

    await openTabMenu(page, c);
    ok(await page.isVisible('#tabmenu') && await page.locator('#tab-colors .swatch').count() === 7, 'right-click opens the menu with no-color plus six colors');
    ok(await page.evaluate(() => [...document.querySelectorAll('#tab-colors .swatch:not(.no-color):not(.on)')].every(el => {
      const style = getComputedStyle(el);
      return style.borderTopColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'rgba(0, 0, 0, 0)';
    })), 'every colour swatch shows its fill and ring');
    await page.click('#tab-colors [data-color="red"]');
    ok(!(await page.isVisible('#tabmenu')) && await page.locator(`.wall-tab[data-id="${c}"]`).evaluate(el => el.classList.contains('c-red')), 'choosing a color tints the tab');
    await reload(page);
    ok(await page.locator(`.wall-tab[data-id="${c}"]`).evaluate(el => el.classList.contains('c-red') && getComputedStyle(el).borderTopColor !== getComputedStyle(document.querySelector(`.wall-tab:not(.c-red)`)).borderTopColor), 'tab color survives reload and shows on the top border');
    await page.screenshot({ path: path.join(OUT, 'tabs.png'), clip: { x: 0, y: 0, width: 1400, height: 120 } });
    // slate is the cards' default tone, so it needs its own class for tabs to pick it up
    await openTabMenu(page, c); await page.click('#tab-colors [data-color="slate"]');
    // buttons ease border colours over .15s, so wait for the transition to settle
    const slateShown = await page.waitForFunction(id => {
      const el = document.querySelector(`.wall-tab[data-id="${id}"]`);
      return el.classList.contains('c-slate') && getComputedStyle(el).borderTopColor === 'rgb(58, 209, 255)';
    }, c, {timeout: 2000}).then(() => true, () => false);
    ok(slateShown, 'slate (blue) also shows on the tab top border');
    await openTabMenu(page, c); await page.click('#tab-colors [data-color=""]');
    ok(await page.locator(`.wall-tab[data-id="${c}"]`).evaluate(el => !/\bc-/.test(el.className)), 'no-color clears the tint');

    await openTabMenu(page, c); await page.keyboard.press('Escape');
    ok(!(await page.isVisible('#tabmenu')), 'Escape closes the menu');
    await openTabMenu(page, c); await page.mouse.click(700, 500);
    ok(!(await page.isVisible('#tabmenu')), 'clicking elsewhere closes the menu');
    await openTabMenu(page, c); await page.click('#rename-wall');
    await page.fill('.wall-tab input', '選單改名'); await page.press('.wall-tab input', 'Enter'); await settled(page);
    ok(await current() === b && await page.evaluate(async id => (await store.getWall(id)).name === '選單改名', c), 'menu rename works on an inactive tab without switching');

    await openTabMenu(page, c); await page.click('#delete-wall'); await page.click('#delete-wall'); await settled(page);
    ok(JSON.stringify(await ids()) === JSON.stringify([b, a]) && await current() === b, 'deleting an inactive tab keeps the current wall');
    await openTabMenu(page, b); await page.click('#delete-wall'); await page.click('#delete-wall'); await settled(page);
    ok(JSON.stringify(await ids()) === JSON.stringify([a]) && await current() === a, 'deleting the current tab switches to its neighbour');
    await reload(page);
    ok(JSON.stringify(await ids()) === JSON.stringify([a]) && await page.evaluate(async () => (await store.getMeta('tabs')).colors && !Object.keys((await store.getMeta('tabs')).colors).length), 'deletions persist and drop stale colors');
    ok(errs.length === 0, 'no page errors ' + errs.join('; '));
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
