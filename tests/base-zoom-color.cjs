const { ready, reload, openActivity, artifacts, profile } = require('./wall-ready.cjs');
const playwright = require('playwright-core');
const fs = require('fs');
const path = require('path');
const PAGE = process.env.WALL_TEST_URL || path.join(__dirname, '..', 'index.html');
// Keep test artifacts in the authorized task directory; retain them for review.
const OUT = artifacts('base-zoom-color');
const PROF = profile();
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1; };

(async () => {
  const ctx = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launchPersistentContext(PROF, { viewport: { width: 1400, height: 900 } });
  const page = ctx.pages()[0] || await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(PAGE); await ready(page); await openActivity(page, 'theme');
  await page.selectOption('#theme', 'paper');
  await page.click('#activity-theme');
  await page.click('#toggle-sidebar');  // canvas geometry below assumes the full 1400px viewport
  const view = () => page.evaluate(() => ({ ...view }));
  const box = id => page.locator(`.card[data-id="${id}"]`).boundingBox();

  // wheel zoom keeps the point under the cursor fixed
  const v0 = await view();
  const b0 = await box('eskm');
  await page.mouse.move(b0.x + 20, b0.y + 20);
  await page.mouse.wheel(0, -300);
  const v1 = await view(), b1 = await box('eskm');
  ok(v1.s > v0.s, `wheel zoom in ${v0.s.toFixed(2)} -> ${v1.s.toFixed(2)}`);
  const wx0 = (b0.x + 20), wx1 = b1.x + 20 * v1.s / v0.s;
  ok(Math.abs(wx0 - wx1) < 6, `point under cursor stays (dx=${(wx0 - wx1).toFixed(1)})`);
  ok((await page.textContent('#zoom-pct')) === Math.round(v1.s * 100) + '%', 'zoom % label updates');

  // pan by dragging empty wall (point between bands, no card)
  const vp = await page.locator('#viewport').boundingBox();
  const grid = [];
  for (let y = vp.height - 40; y > 40; y -= 30) for (let x = 40; x < vp.width - 160; x += 30) grid.push([vp.x + x, vp.y + y]);
  const [sx, sy] = await page.evaluate(pts => pts.find(([x, y]) => document.elementFromPoint(x, y).id === 'bg'), grid);
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y).id || document.elementFromPoint(x, y).className, [sx, sy]);
  await page.mouse.move(sx, sy); await page.mouse.down(); await page.mouse.move(sx + 120, sy - 80, { steps: 5 }); await page.mouse.up();
  const v2 = await view();
  ok(Math.abs(v2.x - v1.x - 120) < 1 && Math.abs(v2.y - v1.y + 80) < 1, `pan moves view by (120,-80) from ${hit}: got (${(v2.x - v1.x).toFixed(0)},${(v2.y - v1.y).toFixed(0)})`);

  // card drag at zoomed scale moves by screen delta / scale
  const c0 = await page.evaluate(() => ({ ...data.cards.find(c => c.id === 'dt') }));
  const bd = await box('dt');
  await page.mouse.move(bd.x + 60, bd.y + 30); await page.mouse.down(); await page.mouse.move(bd.x + 60 + 100, bd.y + 30 + 50, { steps: 5 }); await page.mouse.up();
  const c1 = await page.evaluate(() => ({ ...data.cards.find(c => c.id === 'dt') }));
  ok(Math.abs((c1.x - c0.x) - 100 / v2.s) < 2 && Math.abs((c1.y - c0.y) - 50 / v2.s) < 2, `card drag at zoom: moved (${(c1.x - c0.x).toFixed(1)},${(c1.y - c0.y).toFixed(1)}) expected (${(100 / v2.s).toFixed(1)},${(50 / v2.s).toFixed(1)})`);

  // buttons
  await page.click('#zoom-fit');
  const vf = await view();
  const inside = await page.evaluate(([vx, vy, vw, vh]) => [...document.querySelectorAll('.card')].every(e => {
    const r = e.getBoundingClientRect(); return r.left >= vx - 1 && r.top >= vy - 1 && r.right <= vx + vw + 1 && r.bottom <= vy + vh + 1;
  }), [vp.x, vp.y, vp.width, vp.height]);
  ok(inside, `全覽 fits all cards (s=${vf.s.toFixed(2)})`);

  await page.click('#zoom-in'); ok(Math.abs((await view()).s - vf.s * 1.25) < 1e-6, '＋ button zooms 1.25x');
  await page.click('#zoom-pct'); ok(Math.abs((await view()).s - 1) < 1e-6, '% button resets to 100%');
  await page.click('#zoom-fit');

  // double-click on a card must not add a card; on empty space it does
  const n0 = await page.evaluate(() => data.cards.length);
  const bm = await box('mine');
  await page.mouse.dblclick(bm.x + 50, bm.y + 30);
  await page.click('#f-close');
  ok(await page.evaluate(() => data.cards.length) === n0, 'dblclick on card adds nothing');

  // color: open q2 note (click), pick red, check class and persistence
  const bq = await box('q2');
  await page.mouse.click(bq.x + 40, bq.y + 30);
  ok(await page.isVisible('#panel'), 'panel opens on click');
  ok(await page.getAttribute('#f-color [data-color="amber"]', 'aria-checked') === 'true', 'note default color is amber');
  await page.click('#f-color [data-color="red"]');
  ok(await page.locator('.card[data-id="q2"]').evaluate(e => e.classList.contains('c-red')), 'note recolored red');
  await page.click('#f-close');
  const bmi = await box('mine');
  await page.mouse.click(bmi.x + 50, bmi.y + 30);
  await page.click('#f-color [data-color="cream"]');
  await page.click('#f-close');
  await page.screenshot({ path: path.join(OUT, 'zoom_color.png') });
  await reload(page);
  ok(await page.locator('.card[data-id="q2"]').evaluate(e => e.classList.contains('c-red')), 'red persists after reload');
  ok(await page.locator('.card[data-id="mine"]').evaluate(e => e.classList.contains('c-cream')), 'cream clue card persists after reload');
  const bg = await page.locator('.card[data-id="mine"]').evaluate(e => getComputedStyle(e).backgroundColor);
  ok(bg === 'rgb(219, 238, 255)', `cream bg computed ${bg}`);

  // link creation still works after zoom
  await page.click('#zoom-fit');
  const e0 = await page.evaluate(() => data.edges.length);
  const pin = await page.locator('.card[data-id="pss"] .pin').boundingBox();
  const tq = await box('q2');
  await page.mouse.move(pin.x + pin.width / 2, pin.y + pin.height / 2); await page.mouse.down(); await page.mouse.move(tq.x + tq.width / 2, tq.y + tq.height / 2, { steps: 8 }); await page.mouse.up();
  ok(await page.evaluate(() => data.edges.length) === e0 + 1, 'pin-to-card link created at fit zoom');

  // infinite board: zoom far out and pan far away, background and bands still fill the viewport
  for (let i = 0; i < 6; i++) await page.click('#zoom-out');
  await page.mouse.move(vp.x + 30, vp.y + 30); await page.mouse.down(); await page.mouse.move(vp.x + 30 + 600, vp.y + 30 + 400, { steps: 5 }); await page.mouse.up();
  const cover = await page.evaluate(() => {
    const v = vp.getBoundingClientRect(), b = bg.getBoundingClientRect(), d = document.querySelector('.band:nth-of-type(3)').getBoundingClientRect();
    return Math.abs(b.left - v.left) < 1 && Math.abs(b.top - v.top) < 1 && Math.abs(b.width - v.width) < 1 && Math.abs(b.height - v.height) < 1
      && Math.abs(d.left - v.left) < 1 && Math.abs(d.width - v.width) < 1;
  });
  ok(cover, `background and band lines fill viewport at s=${(await view()).s.toFixed(2)} after far pan`);
  // drag a card into negative wall coordinates (outside the old 1000x1500 board)
  const bs = await box('shoup');
  await page.mouse.move(bs.x + bs.width / 4, bs.y + bs.height / 2); await page.mouse.down(); await page.mouse.move(bs.x - 400, bs.y - 300, { steps: 6 }); await page.mouse.up();
  const sh = await page.evaluate(() => ({ ...data.cards.find(c => c.id === 'shoup') }));
  ok(sh.x < -500 && sh.y < -500, `card moved past old edge to (${sh.x.toFixed(0)},${sh.y.toFixed(0)})`);
  const strOk = await page.evaluate(() => { const r = [...document.querySelectorAll('.str')][0].getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  ok(strOk, 'string to far card still drawn');
  await page.screenshot({ path: path.join(OUT, 'infinite.png') });
  ok(errs.length === 0, 'no page errors ' + errs.join('; '));
  await ctx.close();
})();
