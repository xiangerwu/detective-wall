const playwright = require('playwright-core');
const {ready} = require('./wall-ready.cjs');

// The editor's last row (顏色, 大小選項, 折疊, 刪除卡片) stays one readable row:
// swatches on a single line and no label squeezed into vertical text, at 1400 and 1280 wide.
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1; };

(async () => {
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    for (const [width, height] of [[1400, 900], [1280, 720]]) {
      const page = await browser.newPage({viewport: {width, height}});
      await page.goto(process.env.WALL_TEST_URL); await ready(page);
      // A width saved before this row existed must not keep it cramped.
      await page.evaluate(() => localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify({width: 360, height: 560})));
      await page.evaluate(() => openPanel(data.cards[0].id));
      await page.waitForTimeout(200);
      const problems = await page.evaluate(() => {
        const out = [], row = document.querySelector('#panel .editor-options-row');
        const swatches = [...row.querySelectorAll('#f-color > *')].filter(el => el.getBoundingClientRect().width > 0);
        if (new Set(swatches.map(el => Math.round(el.getBoundingClientRect().top))).size > 1) out.push('colour swatches wrap onto several lines');
        for (const el of row.querySelectorAll('label.check, #f-size-reset, #f-del')) {
          const r = el.getBoundingClientRect();
          if (r.height > 34) out.push(`「${el.textContent.trim()}」 wraps (${Math.round(r.height)}px tall)`);
        }
        const tops = [...row.children].map(el => el.getBoundingClientRect()).map(r => r.top + r.height / 2);
        if (Math.max(...tops) - Math.min(...tops) > 24) out.push('row items are not on one line');
        const panel = document.querySelector('#panel').getBoundingClientRect();
        if ([...row.children].some(el => el.getBoundingClientRect().right > panel.right - 4)) out.push('row runs past the editor edge');
        if (panel.right > innerWidth || panel.bottom > innerHeight) out.push('editor does not fit the window');
        const levels = [...document.querySelectorAll('#f-level button')].map(el => el.getBoundingClientRect());
        if (levels.some((r, i) => i && r.left - levels[i - 1].right < 6)) out.push('anchor level buttons touch each other');
        return out;
      });
      ok(problems.length === 0, `${width}x${height}: editor options stay one readable row ${problems.join('; ')}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
