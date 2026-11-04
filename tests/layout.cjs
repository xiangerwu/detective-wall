const assert = require('node:assert/strict');
const playwright = require('playwright-core');
const {ready, reload, openActivity, openSidebar} = require('./wall-ready.cjs');

const base = process.env.WALL_TEST_URL;

(async () => {
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    await page.goto(base); await ready(page);
    const icons = page.locator('#rail .rail-activity[data-panel]');
    assert.equal(await icons.count(), 8);
    for (let i = 0; i < 8; i++) {
      assert.ok(await icons.nth(i).getAttribute('title'));
      assert.ok(await icons.nth(i).getAttribute('aria-label'));
      assert.equal(await icons.nth(i).locator('svg').count(), 1);
    }
    await page.click('#activity-toggle');
    await page.click('#activity-files');
    await page.click('#activity-history');
    assert.equal(await page.isVisible('#files-section'), false);
    assert.equal(await page.isVisible('#history-section'), true);
    await page.click('#activity-history');
    assert.equal(await page.isVisible('#rail-panel'), false);
    console.log('PASS activity icons switch one left panel at a time and collapse the active panel');
    await page.focus('#activity-help'); await page.keyboard.press('Enter');
    assert.equal(await page.isVisible('#help-section'), true);
    await page.keyboard.press('Space');
    assert.equal(await page.isVisible('#rail-panel'), false);
    console.log('PASS activity icons open and collapse with Enter and Space');

    await openActivity(page, 'files');
    await page.evaluate(() => showActivity(null));
    await reload(page);
    assert.equal(await page.locator('#rail-resize').count(), 0, 'rail panel has no resize handle');
    await openActivity(page, 'files');
    await openSidebar(page);
    assert.deepEqual(await page.locator('#case-folder-tabs [role=tab]').allTextContents(), ['對話', '提案', '紀錄', '模型']);
    assert.ok((await page.locator('#case-folder-header').textContent()).includes('AI 案件夾'));
    assert.equal(await page.locator('#sidebar .theme-picker, #sidebar #theme').count(), 0);
    assert.equal(await page.evaluate(() => vp.clientWidth), 1400, 'floating rail leaves the viewport full width');
    console.log('PASS floating rail has no resize handle and the clipboard leaves the viewport full width');

    const clickCard = async () => {
      const point = await page.evaluate(() => {
        const mascot = document.querySelector('#mascot').getBoundingClientRect();
        const blockers = [...document.querySelectorAll('#clipboard-peek, #case-folder')]
          .filter(el => !el.hidden && getComputedStyle(el).display !== 'none')
          .map(el => el.getBoundingClientRect());
        const blocked = point => blockers.some(box => point.x < box.right && point.x > box.left && point.y < box.bottom && point.y > box.top);
        return [...document.querySelectorAll('.card')].map(card => {
          const r = card.getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2, right: r.right, bottom: r.bottom};
        }).find(point => (point.right < mascot.left || point.bottom < mascot.top) && !blocked(point));
      });
      assert.ok(point, 'a card remains reachable outside the mascot');
      await page.mouse.click(point.x, point.y);
    };
    await page.click('#zoom-fit');  // the board cannot be scrolled, so bring every card into view before clicking one
    await clickCard();
    const original = await page.locator('#panel').boundingBox();
    const titlebar = await page.locator('#panel-titlebar').boundingBox();
    await page.mouse.move(titlebar.x + 60, titlebar.y + titlebar.height / 2); await page.mouse.down();
    // Release inside the window: Firefox automation drops a pointerup outside it, which real browsers deliver via capture.
    await page.mouse.move(1, 1, {steps: 5}); await page.mouse.up();
    const dragged = await page.locator('#panel').boundingBox(), view = await page.locator('#viewport').boundingBox();
    assert.notEqual(dragged.x, original.x);
    assert.ok(dragged.x >= view.x - 1 && dragged.y >= view.y - 1 && dragged.x + dragged.width <= view.x + view.width + 1 && dragged.y + dragged.height <= view.y + view.height + 1);
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('#panel'), false);
    await clickCard();
    await page.click('#f-close');
    await page.setViewportSize({width: 900, height: 600});
    await page.click('#zoom-fit');
    await clickCard();
    const resized = await page.locator('#panel').boundingBox(), smallView = await page.locator('#viewport').boundingBox();
    assert.ok(resized.x >= smallView.x - 1 && resized.y >= smallView.y - 1 && resized.x + resized.width <= smallView.x + smallView.width + 1 && resized.y + resized.height <= smallView.y + smallView.height + 1);
    const expected = resized;
    await page.setViewportSize({width: 1400, height: 900});
    await page.click('#f-close'); await page.reload(); await ready(page); await page.click('#zoom-fit'); await clickCard();
    const restored = await page.locator('#panel').boundingBox();
    const selected = await page.locator('.card.sel').boundingBox();
    const overlaps = box => box.x < selected.x + selected.width - 1 && selected.x < box.x + box.width - 1
      && box.y < selected.y + selected.height - 1 && selected.y < box.y + box.height - 1;
    if (overlaps(expected)) assert.equal(overlaps(restored), false);
    else assert.ok(Math.abs(restored.x - expected.x) < 2 && Math.abs(restored.y - expected.y) < 2);
    console.log('PASS floating editor drags, clamps on resize, closes with Escape, and restores its position');

    await page.evaluate(() => localStorage.removeItem(THEME_KEY));
    await page.reload(); await ready(page);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'paper');
    await page.evaluate(() => localStorage.setItem(THEME_KEY, 'cyber'));
    await page.reload(); await ready(page);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'cyber');
    console.log('PASS paper is the first-use theme and stored themes are preserved');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
