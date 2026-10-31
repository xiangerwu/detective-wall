const assert = require('node:assert/strict');
const playwright = require('playwright-core');
const {ready, reload, openActivity, openSidebar} = require('./wall-ready.cjs');

const base = process.env.WALL_TEST_URL;

(async () => {
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    await page.goto(base); await ready(page);
    const icons = page.locator('#activitybar button');
    assert.equal(await icons.count(), 7);
    for (let i = 0; i < 7; i++) {
      assert.ok(await icons.nth(i).getAttribute('title'));
      assert.ok(await icons.nth(i).getAttribute('aria-label'));
      assert.equal(await icons.nth(i).locator('svg').count(), 1);
    }
    await page.click('#activity-files');
    await page.click('#activity-history');
    assert.equal(await page.isVisible('#files-section'), false);
    assert.equal(await page.isVisible('#history-section'), true);
    await page.click('#activity-history');
    assert.equal(await page.isVisible('#activity-panel'), false);
    console.log('PASS activity icons switch one left panel at a time and collapse the active panel');
    await page.focus('#activity-help'); await page.keyboard.press('Enter');
    assert.equal(await page.isVisible('#help-section'), true);
    await page.keyboard.press('Space');
    assert.equal(await page.isVisible('#activity-panel'), false);
    console.log('PASS activity icons open and collapse with Enter and Space');

    await openActivity(page, 'files');
    const before = await page.evaluate(() => activityPanel.offsetWidth);
    await page.focus('#activity-resize'); await page.keyboard.press('ArrowRight');
    const widened = await page.evaluate(() => activityPanel.offsetWidth);
    assert.equal(widened, before + 16);
    await reload(page);
    assert.equal(await page.evaluate(() => activityPanel.offsetWidth), widened);
    await openSidebar(page);
    assert.deepEqual(await page.locator('#sidebar > section').evaluateAll(sections => sections.map(section => section.id)), ['chat-client-panel', 'ai-section', 'ai-audit-section', 'chat-progress', 'chat-section', 'chat-input-panel', 'chat-mascot-panel']);
    assert.ok(await page.isVisible('#activity-resize') && await page.isVisible('#sidebar-resize'));
    assert.equal(await page.evaluate(() => {
      const visible = el => getComputedStyle(el).display !== 'none';
      return vp.clientWidth + activitybar.offsetWidth + activityPanel.offsetWidth + activityResizer.offsetWidth
        + (visible(resizer) ? resizer.offsetWidth : 0) + (visible(sidebar) ? sidebar.offsetWidth : 0);
    }), 1400);
    console.log('PASS both panel handles resize independently and the viewport fills the remaining width');

    await page.click('#zoom-fit');  // the board cannot be scrolled, so bring every card into view before clicking one
    await page.click('.card');
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
    await page.click('.card');
    await page.click('#f-close');
    await page.setViewportSize({width: 900, height: 600});
    await page.click('#zoom-fit');
    await page.click('.card');
    const resized = await page.locator('#panel').boundingBox(), smallView = await page.locator('#viewport').boundingBox();
    assert.ok(resized.x >= smallView.x - 1 && resized.y >= smallView.y - 1 && resized.x + resized.width <= smallView.x + smallView.width + 1 && resized.y + resized.height <= smallView.y + smallView.height + 1);
    const expected = resized;
    await page.setViewportSize({width: 1400, height: 900});
    await page.click('#f-close'); await page.reload(); await ready(page); await page.click('#zoom-fit'); await page.click('.card');
    const restored = await page.locator('#panel').boundingBox();
    assert.ok(Math.abs(restored.x - expected.x) < 2 && Math.abs(restored.y - expected.y) < 2);
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
