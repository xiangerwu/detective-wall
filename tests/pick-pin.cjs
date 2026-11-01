const { ready, reload, artifacts } = require('./wall-ready.cjs');
const playwright = require('playwright-core');
const path = require('path');
const PAGE = process.env.WALL_TEST_URL || path.join(__dirname, '..', 'index.html');
const OUT = artifacts('pick-pin');
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1; };

(async () => {
    const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    await page.goto(PAGE); await ready(page);
    await page.click('#toggle-sidebar');
    const pickedIds = () => page.locator('.card.picked').evaluateAll(els => els.map(el => el.dataset.id).sort());
    const pos = () => page.evaluate(() => Object.fromEntries(data.cards.map(c => [c.id, [c.x, c.y]])));
    // two cards that sit close together, and the cards a marquee around both should catch
    const plan = await page.evaluate(() => {
      const els = [...document.querySelectorAll('.card')], rects = els.map(el => el.getBoundingClientRect());
      const v = vp.getBoundingClientRect();
      let best;
      for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
        const a = rects[i], b = rects[j];
        const box = {x0: Math.min(a.left, b.left) - 6, y0: Math.min(a.top, b.top) - 6, x1: Math.max(a.right, b.right) + 6, y1: Math.max(a.bottom, b.bottom) + 6};
        if (box.x0 < v.left || box.y0 < v.top || box.x1 > v.right || box.y1 > v.bottom) continue;
        const area = (box.x1 - box.x0) * (box.y1 - box.y0);
        if (!best || area < best.area) best = {area, box, a: els[i].dataset.id, b: els[j].dataset.id};
      }
      const {x0, y0, x1, y1} = best.box;
      best.expected = els.filter((el, k) => rects[k].left < x1 && rects[k].right > x0 && rects[k].top < y1 && rects[k].bottom > y0).map(el => el.dataset.id).sort();
      // marquee must start on blank board: Shift+left only marquees from blank space
      return best;
    });
    const { box } = plan;

    ok(await page.evaluate(() => { const e = new MouseEvent('contextmenu', {bubbles: true, cancelable: true}); bg.dispatchEvent(e); return !e.defaultPrevented; }), 'right-click on the board leaves the browser menu to the browser');
    await page.keyboard.down('Shift'); await page.mouse.move(box.x0, box.y0); await page.mouse.down();
    await page.mouse.move((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, { steps: 3 });
    ok(await page.isVisible('#marquee'), 'Shift+left drag shows the marquee');
    await page.mouse.move(box.x1, box.y1, { steps: 3 }); await page.mouse.up(); await page.keyboard.up('Shift');
    const sel = await pickedIds();
    ok(!(await page.isVisible('#marquee')) && sel.length >= 2 && JSON.stringify(sel) === JSON.stringify(plan.expected), `marquee picks the touched cards (${sel.join(',')})`);
    await page.screenshot({ path: path.join(OUT, 'picked.png') });

    const batchBefore = await page.evaluate(() => ({cards: data.cards.length, edges: data.edges.length}));
    await page.evaluate(() => { clearPicked(); picked.add('mine'); picked.add('dt'); renderCards(); });
    await page.keyboard.press('Delete');
    ok(await page.evaluate(n => data.cards.length === n, batchBefore.cards) && /再按一次刪除 2 張/.test(await page.textContent('#pick-delete')), 'first batch Delete press only arms the floating action');
    await page.keyboard.press('Delete');
    ok(await page.evaluate(({cards, edges}) => data.cards.length === cards - 2 && data.edges.length < edges, batchBefore), 'second batch Delete press removes cards and connected edges');
    await page.keyboard.press('Control+z');
    ok(await page.evaluate(({cards, edges}) => data.cards.length === cards && data.edges.length === edges, batchBefore), 'one undo restores the deleted batch');
    await page.evaluate(ids => { clearPicked(); ids.forEach(id => picked.add(id)); renderCards(); }, sel);

    const before = await pos(), s = await page.evaluate(() => view.s);
    const a = await page.locator(`.card[data-id="${plan.a}"]`).boundingBox();
    await page.mouse.move(a.x + 30, a.y + 20); await page.mouse.down();
    await page.mouse.move(a.x + 30 + 90, a.y + 20 + 45, { steps: 6 }); await page.mouse.up();
    const after = await pos();
    const moved = Object.keys(after).filter(id => after[id][0] !== before[id][0] || after[id][1] !== before[id][1]).sort();
    ok(JSON.stringify(moved) === JSON.stringify(sel) && sel.every(id => Math.abs(after[id][0] - before[id][0] - 90 / s) < 1 && Math.abs(after[id][1] - before[id][1] - 45 / s) < 1), 'dragging one picked card moves the whole group by the same delta');
    ok(JSON.stringify(await pickedIds()) === JSON.stringify(sel) && !(await page.isVisible('#panel')), 'group stays picked after the drag and no editor opens');
    await page.keyboard.press('Control+z');
    ok(JSON.stringify(await pos()) === JSON.stringify(before), 'one undo restores the whole group move');
    await page.keyboard.press('Control+y');
    await reload(page);
    const reloaded = await pos();
    ok(sel.every(id => reloaded[id][0] === after[id][0] && reloaded[id][1] === after[id][1]) && !(await page.locator('.card.picked').count()), 'group move persists; selection does not');

    const blank = await page.evaluate(() => {
      const v = vp.getBoundingClientRect();
      for (let y = v.bottom - 30; y > v.top + 30; y -= 25) for (let x = v.left + 30; x < v.right - 30; x += 25)
        if (document.elementFromPoint(x, y).id === 'bg') return [x, y];
    });
    const pick = async () => {
      const r = await page.evaluate(id => document.querySelector(`.card[data-id="${id}"]`).getBoundingClientRect().toJSON(), plan.a);
      await page.keyboard.down('Shift'); await page.mouse.move(r.left - 8, r.top - 8); await page.mouse.down();
      await page.mouse.move(r.left + 20, r.top + 20, { steps: 3 }); await page.mouse.up(); await page.keyboard.up('Shift');
      return (await pickedIds()).length;
    };
    ok(await pick() >= 1, 're-pick for the clear checks');
    await page.mouse.click(blank[0], blank[1]);
    ok(!(await page.locator('.card.picked').count()), 'clicking blank board clears the selection');
    await pick(); await page.keyboard.press('Escape');
    ok(!(await page.locator('.card.picked').count()), 'Escape clears the selection');
    await pick();
    const other = await page.evaluate(id => [...document.querySelectorAll(".card:not(.picked)")].find(el => { const r = el.getBoundingClientRect(), v = vp.getBoundingClientRect(); return r.top > v.top && r.bottom < v.bottom && r.left > v.left && r.right < v.right - 80; }).dataset.id, plan.a);
    const p0 = await pos(), o = await page.locator(`.card[data-id="${other}"]`).boundingBox();
    await page.mouse.move(o.x + 30, o.y + 20); await page.mouse.down(); await page.mouse.move(o.x + 90, o.y + 60, { steps: 4 }); await page.mouse.up();
    const p1 = await pos();
    ok(!(await page.locator('.card.picked').count()) && Object.keys(p1).filter(id => p1[id][0] !== p0[id][0]).join() === other, 'dragging an unpicked card clears the selection and moves only that card');

    // fixed top pin and mount modes
    const edge = await page.evaluate(() => data.edges[0]);
    const card = await page.locator(`.card[data-id="${edge.from}"]`).boundingBox();
    await page.mouse.click(card.x + card.width / 2, card.y + card.height / 2);
    ok(await page.locator('#f-pin').count() === 0 && await page.locator('#f-mount [data-mount=""]').getAttribute('aria-checked') === 'true', 'editor uses one fixed top-centre pin and offers mount choices');
    const pinCheck = () => page.evaluate(id => {
      const c = byId(id), el = document.querySelector(`.card[data-id="${id}"]`), pin = el.querySelector('.pin').getBoundingClientRect();
      const w = wall.getBoundingClientRect(), centre = {x: (pin.left + pin.width / 2 - w.left) / view.s, y: (pin.top + pin.height / 2 - w.top) / view.s};
      return {pin: centre, card: {x: c.x, y: c.y, w: el.offsetWidth, h: el.offsetHeight}};
    }, edge.from);
    const near = (p, q, tol = 6) => Math.abs(p.x - q.x) <= tol && Math.abs(p.y - q.y) <= tol;
    const r = await pinCheck();
    ok(near(r.pin, {x: r.card.x + r.card.w / 2, y: r.card.y + 1}), 'fixed pin stays at the top centre while line endpoints use card edges');
    await page.click('#f-mount [data-mount="tape"]');
    ok(await page.evaluate(id => byId(id).mount === 'tape' && document.querySelector(`.card[data-id="${id}"]`).classList.contains('mount-tape')
      && getComputedStyle(document.querySelector(`.card[data-id="${id}"]`), '::before').content !== 'none', edge.from), 'tape mode renders the paper tape pseudo-element');
    await page.screenshot({ path: path.join(OUT, 'pin-bottom.png') });
    await reload(page);
    ok(await page.evaluate(id => byId(id).mount === 'tape' && !('pin' in byId(id)), edge.from), 'mount choice persists after reload and old pin data is absent');
    ok(await page.evaluate(() => {
      const n = normalize({cards: [{id: 'p1', mount: 'bad'}, {id: 'p2', mount: 'tape'}, {id: 'p3', pin: 'ne'}], edges: []}).cards;
      return !('mount' in n[0]) && n[1].mount === 'tape' && !('pin' in n[2]);
    }), 'import keeps tape mount and drops invalid mount and old pin fields');
    ok(await page.evaluate(id => cardDiff(byId(id), {...byId(id), mount: undefined}).some(([f]) => f === '固定方式'), edge.from), 'import preview lists a mount change');
    ok(errs.length === 0, 'no page errors ' + errs.join('; '));
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
