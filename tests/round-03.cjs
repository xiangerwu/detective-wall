const { ready, reload, openActivity } = require('./wall-ready.cjs');
const playwright = require('playwright-core');
const path = require('path');
const PAGE = process.env.WALL_TEST_URL || path.join(__dirname, '..', 'index.html');
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1; };

(async () => {
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errs = [], dialogs = [];
    page.on('pageerror', e => errs.push(e.message));
    page.on('dialog', async d => { dialogs.push(d.message()); await d.dismiss(); });
    await page.goto(PAGE); await ready(page); await openActivity(page, 'theme');
    await page.selectOption('#card-style', 'tech');
    if (!await page.evaluate(() => !!window.marked && !!window.DOMPurify)) throw new Error('CDN libraries unavailable: online Markdown tests cannot run');
    await page.click('#add-card');
    const id = await page.evaluate(() => selCard);
    const card = page.locator(`.card[data-id="${id}"]`), md = card.locator('.md');
    const setNote = async note => {
      await page.evaluate(id => openPanel(id), id);
      await page.fill('#f-note', note);
      await page.click('#f-close');
    };

    const raw = '**粗體**\n\n- 項目 `code`';
    await setNote(raw);
    ok(await md.locator('strong').textContent() === '粗體' && await md.locator('li').count() === 1 && await md.locator('code').textContent() === 'code', 'bold, list and inline code render as Markdown');
    ok(await page.evaluate(async ({id, raw}) => byId(id).note === raw && (await store.getWall(currentWall.id)).data.cards.find(c => c.id === id).note === raw, {id, raw}), 'data and IndexedDB keep raw Markdown');
    await reload(page);
    await page.click('#zoom-fit');
    ok(await md.locator('strong').textContent() === '粗體', 'Markdown renders again after reload');
    await page.evaluate(id => openPanel(id), id);
    ok(await page.inputValue('#f-note') === raw && await page.locator('label').filter({has: page.locator('#f-note')}).textContent() === '筆記（支援 Markdown）', 'panel edits raw text and advertises Markdown');
    await page.click('#f-close');

    await setNote('[ESKM](https://example.com)');
    const link = md.locator('a');
    ok(await link.getAttribute('target') === '_blank' && (await link.getAttribute('rel')).split(/\s+/).includes('noopener') && (await link.getAttribute('rel')).includes('noreferrer'), 'note link opens a protected new tab');
    await page.context().route('https://example.com/**', route => route.fulfill({contentType: 'text/html', body: '<title>ESKM</title>'}));
    const before = await page.evaluate(id => ({x: byId(id).x, y: byId(id).y}), id);
    const box = await link.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    ok(await page.evaluate(() => drag === null) && await page.locator('.card.dragging').count() === 0, 'pointerdown on a note link does not start dragging');
    const opened = page.waitForEvent('popup');
    await page.mouse.up();
    const popup = await opened;
    await popup.waitForLoadState();
    ok(popup.url().startsWith('https://example.com') && await popup.evaluate(() => window.opener === null), 'click opens the link with no opener');
    await popup.close();
    ok(!(await page.isVisible('#panel')) && await page.evaluate(({id, before}) => byId(id).x === before.x && byId(id).y === before.y && selCard === null, {id, before}), 'link click neither opens the panel nor moves the card');

    for (const payload of [
      '<img src=x onerror=alert(1)>', '<script>alert(1)</script>', '[x](javascript:alert(1))',
      '<a href="javascript:alert(1)">y</a>', '<iframe>',
      '<style>body{display:none}</style><form><input><button>bad</button></form>',
    ]) {
      await setNote(payload);
      ok(await md.locator('img,script,iframe,style,form,input,button').count() === 0 && await md.evaluate(el =>
        [...el.querySelectorAll('*')].every(node => [...node.attributes].every(a => !/^on/i.test(a.name) && !/^javascript:/i.test(a.value.trim())))
      ) && dialogs.length === 0, 'sanitizes without executing: ' + payload);
      if (payload.includes('javascript:')) ok(await md.locator('a[href]').count() === 0, 'javascript link has no surviving href');
    }
    await setNote('<a href="https://example.com" target="_self" rel="opener">safe</a>');
    ok(await link.getAttribute('target') === '_blank' && await link.getAttribute('rel') === 'noopener noreferrer', 'hook also protects raw HTML links after repeated renders');

    await setNote('# 標題\n\n**粗體** *斜體* [連結](https://example.com)\n\n> 引言\n\n1. 清單\n\n```\n程式碼\n```\n\n尾行');
    for (const theme of ['moon', 'whiteboard', 'wood', 'paper', 'cork', 'cyber']) {
      await page.selectOption('#theme', theme);
      const colors = await page.evaluate(id => Object.keys(COLORS).map(color => {
        byId(id).color = color; renderCards(); save();
        const el = wall.querySelector(`[data-id="${id}"] .md`), css = getComputedStyle(el);
        return {color, text: css.color, link: getComputedStyle(el.querySelector('a')).color,
          full: el.scrollHeight <= el.clientHeight + 1 && el.clientHeight > 4 * parseFloat(css.lineHeight),  // cards grow with the note instead of clipping it
          selection: getComputedStyle(el.closest('.card')).userSelect};
      }), id);
      ok(colors.every(c => c.text === ({slate: 'rgb(180, 196, 212)', amber: 'rgb(220, 203, 164)', red: 'rgb(220, 180, 184)', green: 'rgb(177, 212, 191)', purple: 'rgb(197, 182, 218)', cream: 'rgb(74, 61, 16)'})[c.color] && c.full && c.selection === 'none'), theme + ': all card colours, full note shown and disabled selection');
      ok(colors.find(c => c.color === 'cream').link === 'rgb(122, 74, 0)', theme + ': cream links use the dark card link colour');
    }

    // Block both libraries and each one separately on fresh pages, before navigation.
    for (const blocked of ['**://cdnjs.cloudflare.com/**', '**/marked/12.0.2/**', '**/dompurify/3.1.6/**']) {
      const offline = await browser.newPage();
      offline.on('pageerror', e => errs.push(e.message));
      offline.on('dialog', async d => { dialogs.push(d.message()); await d.dismiss(); });
      await offline.route(blocked, route => route.abort());
      await offline.goto(PAGE); await ready(offline);
      const note = '**粗體**\n- `code`\n<img src=x onerror=alert(1)>';
      await offline.click('#add-card');
      const offlineId = await offline.evaluate(() => selCard);
      await offline.fill('#f-note', note);
      await offline.click('#f-close');
      const fallback = offline.locator(`.card[data-id="${offlineId}"]`);
      ok(await offline.evaluate(() => !window.marked || !window.DOMPurify) && await fallback.locator('.md').count() === 0 && await fallback.locator(':scope > p').textContent() === note && await fallback.locator('strong,li,code,img').count() === 0, blocked + ': missing library falls back to literal plain text');
      await offline.close();
    }
    ok(dialogs.length === 0, 'no dialogs ' + dialogs.join('; '));
    ok(errs.length === 0, 'no page errors ' + errs.join('; '));
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
