const assert = require('node:assert/strict');
const playwright = require('playwright-core');

const base = process.env.WALL_TEST_URL;

(async () => {
  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    await page.goto(base);
    await page.waitForFunction(() => window.wallReady === true);
    assert.equal(await page.evaluate(() => window.caseGraph), undefined);
    assert.equal(await page.locator('#activity-launcher-settings').isHidden(), true);
    console.log('PASS the launcher settings entry stays hidden in a normal browser');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
