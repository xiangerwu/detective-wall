const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require('playwright-core');
const {ready} = require('./wall-ready.cjs');

const PAGE = process.env.WALL_TEST_URL || path.join(__dirname, '..', 'index.html');
const OUT = path.resolve(process.env.WALL_TEST_OUT || path.join(__dirname, '..', 'test-results', 'rail'));
fs.mkdirSync(OUT, {recursive: true});

const waitMotion = page => page.waitForTimeout(260);

(async () => {
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'chromium'].launch();
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    await page.goto(PAGE); await ready(page);

    assert.equal(await page.locator('#rail-toggle').count(), 0, 'the old rail toggle is removed');
    assert.equal(await page.locator('#rail-resize').count(), 0, 'the old rail resize handle is removed');
    assert.equal(await page.locator('#rail').evaluate(element => getComputedStyle(element).pointerEvents), 'none', 'rail chrome lets the wall receive pointer input outside bubbles');
    assert.ok((await page.locator('#rail').boundingBox()).width <= 60, 'rail only occupies the bubble gutter');

    const first = page.locator('#add-card');
    const before = await page.evaluate(() => ['#add-note', '#add-image'].map(selector => {
      const box = document.querySelector(selector).getBoundingClientRect();
      return {x: box.x, y: box.y};
    }));
    await first.hover(); await waitMotion(page);
    const hover = await first.evaluate(element => ({
      width: element.getBoundingClientRect().width,
      label: getComputedStyle(element.querySelector('.rail-label')).opacity,
    }));
    assert.ok(hover.width >= 120 && Number(hover.label) > 0, 'upper bubble grows and reveals its label on hover');
    const after = await page.evaluate(() => ['#add-note', '#add-image'].map(selector => {
      const box = document.querySelector(selector).getBoundingClientRect();
      return {x: box.x, y: box.y};
    }));
    assert.deepEqual(after, before, 'upper bubble hover does not move neighboring bubbles');
    await page.mouse.move(700, 200);
    await page.focus('#add-card'); await waitMotion(page);
    assert.ok(await first.evaluate(element => element.getBoundingClientRect().width >= 120), 'upper bubble also grows for keyboard focus');
    await page.mouse.move(700, 200);

    const gear = page.locator('#activity-toggle');
    assert.equal(await gear.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#activity-files').getAttribute('aria-hidden'), 'true');
    assert.ok(await page.locator('#activity-files').getAttribute('inert') !== null, 'collapsed activity bubbles are not tabbable');
    assert.equal(await page.locator('#activity-launcher-settings').isHidden(), true, 'launcher settings bubble is hidden without Electron caseGraph');

    await gear.click(); await waitMotion(page);
    assert.equal(await gear.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#activity-files').getAttribute('aria-hidden'), 'false');
    assert.equal(await page.locator('#activity-files').getAttribute('inert'), null);
    await gear.focus(); await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'activity-navigation', 'expanded bubbles participate in tab order');

    await gear.click(); await waitMotion(page);
    assert.equal(await gear.getAttribute('aria-expanded'), 'false');
    assert.ok(await page.locator('#activity-files').getAttribute('inert') !== null, 'collapsing the gear removes activity bubbles from tab order');

    await gear.click(); await waitMotion(page);
    await page.click('#activity-files'); await waitMotion(page);
    assert.equal(await page.getAttribute('#activity-files', 'aria-pressed'), 'true');
    assert.equal(await page.locator('#rail-panel').getAttribute('role'), 'dialog');
    assert.equal(await page.evaluate(() => document.activeElement.closest('#rail-panel')?.id), 'rail-panel', 'opening a panel moves focus into the floating window');
    const panel = await page.locator('#rail-panel').boundingBox();
    const rail = await page.locator('#rail').boundingBox();
    assert.ok(panel.x >= rail.x + rail.width - 1 && panel.x + panel.width <= 1400 + 1 && panel.y + panel.height <= 900 + 1 && panel.y >= -1,
      'floating panel opens right of the bubble column and stays inside the viewport: ' + JSON.stringify({panel, rail}));
    // The window was opened with the pointer on the (hover-widened) bubble; re-placing it with the pointer away
    // must give the same spot, or the window jumps whenever its content resizes.
    await page.mouse.move(700, 450); await waitMotion(page);
    await page.evaluate(() => positionActivityPanel());
    const settled = await page.locator('#rail-panel').boundingBox();
    assert.ok(Math.abs(settled.x - panel.x) < 1 && Math.abs(settled.y - panel.y) < 1,
      'the floating panel position does not depend on bubble hover: ' + JSON.stringify({panel, settled}));

    await page.click('#activity-history'); await waitMotion(page);
    assert.equal(await page.locator('#files-section').isVisible(), false);
    assert.equal(await page.locator('#history-section').isVisible(), true);
    assert.equal(await page.getAttribute('#activity-files', 'aria-pressed'), 'false');
    assert.equal(await page.getAttribute('#activity-history', 'aria-pressed'), 'true');
    assert.ok(await page.evaluate(() => document.querySelector('#history-section')?.closest('#rail-panel')));

    const blank = await page.evaluate(() => {
      const viewport = document.querySelector('#viewport').getBoundingClientRect();
      for (let y = viewport.top + 30; y < viewport.bottom - 30; y += 24) for (let x = viewport.left + 80; x < viewport.right - 80; x += 24)
        if (document.elementFromPoint(x, y)?.id === 'bg') return {x, y};
      return null;
    });
    assert.ok(blank, 'a blank wall point exists for outside-click testing');
    await page.mouse.click(blank.x, blank.y); await waitMotion(page);
    assert.equal(await page.locator('#rail-panel').isVisible(), false, 'clicking wall space closes the floating panel');
    await page.waitForTimeout(500);
    assert.equal(await gear.getAttribute('aria-expanded'), 'false', 'with the window closed and the pointer away, the bubbles fold into the gear');

    // A clicked bubble shrinks back to a circle even though the pointer still rests on it.
    await gear.click(); await waitMotion(page);
    await page.hover('#activity-files'); await waitMotion(page);
    assert.ok((await page.locator('#activity-files').boundingBox()).width >= 120, 'a settings bubble widens on hover');
    await page.click('#activity-files'); await waitMotion(page);
    assert.ok((await page.locator('#activity-files').boundingBox()).width <= 44, 'the clicked bubble returns to a circle while its window is open');
    // An open window keeps the bubbles out even when the pointer leaves the corner.
    await page.mouse.move(700, 450); await page.waitForTimeout(800);
    assert.equal(await gear.getAttribute('aria-expanded'), 'true', 'an open window keeps the settings bubbles expanded');
    await page.hover('#activity-files'); await waitMotion(page);
    assert.ok((await page.locator('#activity-files').boundingBox()).width >= 120, 'after the pointer leaves and returns, hover widens it again');
    await page.keyboard.press('Escape'); await waitMotion(page);

    await gear.click(); await waitMotion(page);
    await page.click('#activity-files'); await waitMotion(page);
    await page.keyboard.press('Escape'); await waitMotion(page);
    assert.equal(await page.locator('#rail-panel').isVisible(), false, 'Escape closes the floating panel');
    assert.equal(await gear.getAttribute('aria-expanded'), 'false', 'Escape also retracts the gear menu');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'activity-toggle', 'Escape returns focus to the gear');

    await gear.click(); await waitMotion(page);
    await page.click('#activity-files'); await waitMotion(page);
    await page.click('#rail-panel-close'); await waitMotion(page);
    assert.equal(await page.locator('#rail-panel').isVisible(), false, 'the floating window close button closes the panel');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'activity-files', 'closing the panel returns focus to its bubble');

    for (const theme of ['cork', 'moon']) {
      await page.evaluate(value => setTheme(value), theme);
      await page.screenshot({path: path.join(OUT, 'rail-' + theme + '.png')});
    }
    console.log('PASS floating rail bubbles, gear menu, floating activity panels, focus, outside close, and launcher visibility');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
