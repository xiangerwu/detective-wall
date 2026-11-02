const playwright = require('playwright-core');
const {ready, openSidebar} = require('./wall-ready.cjs');

// Inside the AI clipboard: the sheet tabs never cover each other, every tab name is fully readable,
// and the metal clip never sits on visible text, at the narrowest, default and widest sidebar widths.
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1; };

(async () => {
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    await page.goto(process.env.WALL_TEST_URL); await ready(page); await openSidebar(page);
    for (const theme of ['cork', 'moon', 'paper']) {
      for (const width of [220, 300, 480]) {
        await page.evaluate(([t, w]) => { setTheme(t); setSidebarWidth(w); }, [theme, width]);
        await page.waitForTimeout(250);
        const problems = await page.evaluate(() => {
          const hit = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
          const shown = el => { const s = getComputedStyle(el), r = el.getBoundingClientRect(); return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 2 && r.height > 2; };
          const tabs = [...document.querySelectorAll('.case-folder-tab')].filter(shown);
          const out = [];
          tabs.forEach((a, i) => tabs.slice(i + 1).forEach(b => { if (hit(a.getBoundingClientRect(), b.getBoundingClientRect())) out.push(`tabs ${a.textContent.trim()}/${b.textContent.trim()} overlap`); }));
          for (const tab of tabs) if (tab.scrollWidth > tab.clientWidth + 1) out.push(`tab ${tab.textContent.trim()} is clipped`);
          const clip = document.querySelector('.clipboard-clip');
          if (clip && shown(clip)) {
            const c = clip.getBoundingClientRect();
            const texts = [...document.querySelectorAll('#case-folder-header *, .case-folder-tab')].filter(el => shown(el) && el.textContent.trim() && !el.closest('.clipboard-clip'));
            for (const el of texts) if (hit(c, el.getBoundingClientRect())) out.push(`clip covers 「${el.textContent.trim().slice(0, 12)}」`);
          }
          return out;
        });
        ok(problems.length === 0, `${theme} ${width}px: clipboard tabs and clip leave every label readable ${problems.join('; ')}`);
      }
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
