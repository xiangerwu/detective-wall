const assert = require('node:assert/strict');
const playwright = require('playwright-core');
const {ready} = require('./wall-ready.cjs');

const PAGE = process.env.WALL_TEST_URL;

(async () => {
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    await page.goto(PAGE); await ready(page);
    const bands = await page.evaluate(() => [...data.bands].sort((a, b) => a.y - b.y));
    assert.equal(await page.locator('#band-nav button').count(), bands.length, 'band nav lists every band');
    assert.equal(await page.locator('#band-nav').isVisible(), true, 'band nav is visible when bands exist');
    await page.locator('#band-nav button').nth(1).click();
    assert.ok(await page.evaluate(y => Math.abs(view.y - (24 - y * view.s)) < 1, bands[1].y), 'clicking a band moves its top into view without changing zoom');
    assert.equal(await page.locator('#band-nav button[aria-current=true]').getAttribute('data-band-id'), bands[1].id, 'current band is marked');
    await page.focus('#viewport');
    await page.keyboard.press('PageDown');
    assert.ok(await page.evaluate(y => Math.abs(view.y - (24 - y * view.s)) < 1, bands[2].y), 'PageDown moves to the next band');
    await page.keyboard.press('PageUp');
    assert.equal(await page.locator('#band-nav button[aria-current=true]').getAttribute('data-band-id'), bands[1].id, 'PageUp returns to the previous band');
    await page.evaluate(() => { data.bands = []; renderBands(); });
    assert.equal(await page.locator('#band-nav').isVisible(), false, 'band nav hides when there are no bands');
    console.log('PASS band nav count, click positioning, active state, PageUp/PageDown, and empty state');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
