const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require('playwright-core');
const {ready, openActivity} = require('./wall-ready.cjs');

// Card corner controls and edge ends, checked in every theme and card style:
// the level badge never covers the fold button or the title, and every edge end is a smaller pressed-in pin.
const OUT = process.env.WALL_TEST_OUT || path.resolve(__dirname, '..', 'test-results', 'card-chrome');
const P19_OUT = path.resolve(__dirname, '..', 'test-results', 'p19r2b');
fs.mkdirSync(OUT, {recursive: true});
fs.mkdirSync(P19_OUT, {recursive: true});
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1; };

(async () => {
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    await page.goto(process.env.WALL_TEST_URL); await ready(page);
    await page.evaluate(() => {
      const [a, b, c] = data.cards;
      a.level = 'key'; a.title = '一張標題很長很長的重點卡片，用來確認不會被蓋住'; a.w = 120;
      b.level = 'source'; b.fold = true;
      c.level = 'key';
      render(); save(true);
    });
    const overlaps = () => page.evaluate(() => {
      const hit = (p, q) => p.left < q.right - 1 && q.left < p.right - 1 && p.top < q.bottom - 1 && q.top < p.bottom - 1;
      return [...document.querySelectorAll('.card')].flatMap(card => {
        const badge = card.querySelector('.anchor-badge')?.getBoundingClientRect();
        if (!badge) return [];
        const fold = card.querySelector('.fold')?.getBoundingClientRect(), title = card.querySelector('h3')?.getBoundingClientRect();
        const problems = [];
        if (fold && hit(badge, fold)) problems.push(card.dataset.id + ' badge/fold');
        if (title && title.height && hit(badge, title)) problems.push(card.dataset.id + ' badge/title');
        if (getComputedStyle(card.querySelector('.anchor-badge')).clipPath !== 'none') problems.push(card.dataset.id + ' badge corner is clipped');
        if (badge.left < card.getBoundingClientRect().left || badge.right > card.getBoundingClientRect().right
          || badge.top < card.getBoundingClientRect().top || badge.bottom > card.getBoundingClientRect().bottom) problems.push(card.dataset.id + ' badge box escapes card');
        // A title squeezed to one glyph per line means something still reserves room for the old corner badge.
        if (title && title.height && title.width > 60 && card.querySelector('h3').scrollWidth < 40) problems.push(card.dataset.id + ' title squeezed');
        const h3 = card.querySelector('h3'); if (h3 && h3.textContent.length > 6 && h3.getClientRects().length && h3.getBoundingClientRect().height > 22 * Math.ceil(h3.textContent.length / 3)) problems.push(card.dataset.id + ' title wraps per glyph');
        return problems;
      });
    });
    const ends = () => page.evaluate(() => {
      const pins = [...document.querySelectorAll('#string-ends .string-pin')];
      const layer = z => Number(getComputedStyle(z).zIndex);
      const hit = (a, b) => Boolean(a && b) && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
      const details = pins.map(pin => {
        const card = document.querySelector(`.card[data-id="${CSS.escape(pin.dataset.cardId)}"]`);
        const box = card?.getBoundingClientRect(), pinBox = pin.getBoundingClientRect();
        return {id: pin.dataset.cardId, end: pin.dataset.end, card: Boolean(card), inside: Boolean(box && pinBox.left >= box.left && pinBox.right <= box.right
          && pinBox.top >= box.top && pinBox.bottom <= box.bottom),
          coversTitle: Boolean(card && hit(pinBox, card.querySelector('h3')?.getBoundingClientRect())),
          coversBadge: Boolean(card && hit(pinBox, card.querySelector('.anchor-badge')?.getBoundingClientRect())),
          coversFold: Boolean(card && hit(pinBox, card.querySelector('.fold')?.getBoundingClientRect())),
          coversPin: Boolean(card && hit(pinBox, card.querySelector('.pin')?.getBoundingClientRect()))};
      });
      return {pins: pins.length, edges: data.edges.length, above: layer(document.querySelector('#string-ends')) > layer(document.querySelector('.card')), details};
    });
    for (const style of ['paper', 'tech']) {
      for (const theme of ['whiteboard', 'wood', 'paper', 'cork', 'moon', 'cyber']) {
        await page.evaluate(([t, st]) => { setTheme(t); setCardStyle(st); render(); }, [theme, style]);
        await page.waitForTimeout(50);
        const problems = await overlaps();
        ok(problems.length === 0, `${theme}/${style}: level badges clear the fold button and title ${problems.join(', ')}`);
        const e = await ends();
        const badPins = e.details.filter(pin => !pin.card || !pin.inside || pin.coversTitle || pin.coversBadge || pin.coversFold || pin.coversPin);
        ok(e.pins === e.edges * 2 && e.above && badPins.length === 0,
          `${theme}/${style}: one smaller pin per edge end stays inside its card and clear of title/badge/fold/main pin (${e.pins}/${e.edges * 2})`);
        // Every selected new-edge type keeps its line sample readable against the selection colour.
        // The button background animates (.15s), so measure only after it settles.
        const samples = [];
        for (const type of ['builds', 'uses', 'question']) {
          await page.evaluate(() => selectEdge(data.edges[0].id, {x: 300, y: 300}));
          await page.click(`#edgepop [data-type="${type}"]`);
          await page.waitForTimeout(300);
          samples.push(await page.evaluate(type => {
            const button = document.querySelector(`#edgepop [data-type="${type}"]`), svg = button.querySelector('svg'), line = button.querySelector('line');
            const parse = c => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
            const lum = ([r, g, b]) => [r, g, b].map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
            const own = getComputedStyle(svg).backgroundColor, behind = own === 'rgba(0, 0, 0, 0)' ? getComputedStyle(button).backgroundColor : own;
            const [l1, l2] = [lum(parse(getComputedStyle(line).stroke)), lum(parse(behind))].sort((x, y) => y - x);
            return [type, (l1 + .05) / (l2 + .05)];
          }, type));
        }
        const weak = samples.filter(([, ratio]) => ratio < 1.8).map(([type, ratio]) => type + ' ' + ratio.toFixed(2));
        ok(weak.length === 0, `${theme}/${style}: selected new-edge samples stay visible ${weak.join(', ')}`);
        if (theme === 'cork' || theme === 'whiteboard') await page.screenshot({path: path.join(OUT, `${theme}-${style}.png`)});
      }
    }
    // Dots follow a card while it is dragged (incremental string updates).
    await page.evaluate(() => selectEdge(null));
    const before = await page.evaluate(() => [...document.querySelectorAll('#string-ends .string-pin')].map(c => c.getAttribute('transform')).join(' '));
    const box = await page.locator(`.card[data-id="${await page.evaluate(() => data.edges[0].from)}"] h3`).boundingBox();
    await page.mouse.move(box.x + 10, box.y + 5); await page.mouse.down();
    await page.mouse.move(box.x + 90, box.y + 60, {steps: 5});
    const during = await page.evaluate(() => [...document.querySelectorAll('#string-ends .string-pin')].map(c => c.getAttribute('transform')).join(' '));
    await page.mouse.up();
    ok(during !== before, 'pressed-in edge pins move with a dragged card');
    await page.evaluate(() => { setTheme('cork'); setCardStyle('paper'); fitView(true); });
    await page.waitForTimeout(300);
    const visibleCards = await page.locator('.card').evaluateAll(cards => cards.slice(0, 5).map(card => card.getBoundingClientRect()).reduce((box, next) => box ? {
      left: Math.min(box.left, next.left), top: Math.min(box.top, next.top), right: Math.max(box.right, next.right), bottom: Math.max(box.bottom, next.bottom),
    } : {left: next.left, top: next.top, right: next.right, bottom: next.bottom}, null));
    if (visibleCards) await page.screenshot({path: path.join(P19_OUT, 'pins-close-up-cork.png'), clip: {
      x: Math.max(0, visibleCards.left - 80), y: Math.max(0, visibleCards.top - 80),
      width: Math.min(1400, visibleCards.right - visibleCards.left + 160), height: Math.min(900, visibleCards.bottom - visibleCards.top + 160),
    }});
    // The layout control reads as one bordered button group, like 新連線.
    await openActivity(page, 'files').catch(() => {});
    ok(await page.evaluate(() => {
      const group = getComputedStyle(document.querySelector('#layout-wall-control'));
      return group.borderTopStyle === 'solid' && getComputedStyle(document.querySelector('#layout-wall-control'), '::before').content.includes('整理');
    }), 'layout control is a labelled, bordered button group');
    const stripSpread = await page.evaluate(() => {
      const tops = [...document.querySelector('#topbar #tabrow').children].filter(k => k.offsetParent).map(k => k.getBoundingClientRect().top);
      return tops.length ? Math.max(...tops) - Math.min(...tops) : Infinity;
    });
    ok(stripSpread < 12, `top strip stays on one row at 1400px (${stripSpread.toFixed(1)}px spread)`);
    await page.locator('#topbar').screenshot({path: path.join(OUT, 'header.png')});
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
