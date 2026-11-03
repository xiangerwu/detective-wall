const playwright = require('playwright-core');
const {ready, openSidebar} = require('./wall-ready.cjs');

// Inside the floating AI clipboard: the sheet tabs stay readable and the centred metal clip never sits on text.
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1; };

(async () => {
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    await page.goto(process.env.WALL_TEST_URL); await ready(page); await openSidebar(page);
    for (const theme of ['cork', 'moon', 'paper']) {
      for (const [width, height] of [[1400, 900], [1280, 720]]) {
        await page.setViewportSize({width, height});
        await page.evaluate(t => setTheme(t), theme);
        await page.waitForTimeout(700);
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
          const active = document.querySelector('.case-folder-tab[aria-selected=true]'), sheet = document.querySelector('#case-folder .case-pane');
          if (!active || !sheet) out.push('active tab or sheet is missing');
          else {
            const activeStyle = getComputedStyle(active), sheetStyle = getComputedStyle(sheet);
            if (activeStyle.backgroundColor !== sheetStyle.backgroundColor) out.push('active tab and sheet use different paper colours');
            if (activeStyle.borderBottomWidth !== '0px' || sheetStyle.borderTopColor === 'rgb(201, 173, 127)') out.push('a line remains between active tab and sheet');
            if (Math.abs(active.getBoundingClientRect().bottom - sheet.getBoundingClientRect().top) > 2) out.push('active tab does not touch the sheet');
          }
          return out;
        });
        ok(problems.length === 0, `${theme} ${width}x${height}: floating clipboard tabs and clip stay readable ${problems.join('; ')}`);
      }
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
