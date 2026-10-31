const { ready, reload, openActivity, artifacts } = require('./wall-ready.cjs');
const playwright = require('playwright-core');
const path = require('path');
const PAGE = process.env.WALL_TEST_URL || path.join(__dirname, '..', 'index.html');
const OUT = artifacts('sidebar');
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1; };

(async () => {
    const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    await page.goto(PAGE); await ready(page); await openActivity(page, 'files');
    const header = await page.locator('header').boundingBox(), side = await page.locator('#sidebar').boundingBox();
    ok(header.height < 100, 'header is one toolbar row plus the tab row at 1400px (' + header.height + 'px)');
    ok(await page.isVisible('#sidebar') && Math.round(side.x + side.width) === 1400 && await page.getAttribute('#toggle-sidebar', 'aria-expanded') === 'true', 'sidebar open by default on the right');
    for (const id of ['export', 'export-canvas', 'import', 'reset'])
      if (!await page.locator('#activity-panel #' + id).count()) ok(false, id + ' is in the files activity panel');
    ok(JSON.stringify(await page.locator('#sidebar > section').evaluateAll(sections => sections.map(section => section.id))) === JSON.stringify(['chat-client-panel', 'ai-section', 'ai-audit-section', 'chat-progress', 'chat-section', 'chat-input-panel', 'chat-mascot-panel'])
      && !(await page.locator('#sidebar #export').count()), 'right sidebar rows run model, proposals, audit, progress, conversation, input, image');
    ok(await page.locator('#sidebar > .side-panel').evaluateAll(panels => panels.every(p => getComputedStyle(p).resize === 'vertical')), 'every sidebar row has a vertical resize grip');
    await page.evaluate(() => { $('#chat-section').style.height = '150px'; $('#chat-mascot-panel').style.height = '200px'; });
    await page.waitForTimeout(100);
    await page.reload(); await ready(page);
    ok(await page.evaluate(() => $('#chat-section').offsetHeight === 150), 'a row height set with its grip survives reload');
    ok(await page.evaluate(() => { const panel = $('#chat-mascot-panel'), img = $('#chat-mascot'); return panel.offsetHeight >= 200 && Math.abs(img.offsetHeight - panel.clientHeight) <= 2 * parseFloat(getComputedStyle(panel).paddingTop || 0) + 2; }), 'the image scales to its row height');
    await page.evaluate(() => { $('#chat-section').style.height = $('#chat-mascot-panel').style.height = ''; localStorage.removeItem('thesis-detective-wall-side-panel-heights'); });
    const panelOrderKey = 'thesis-detective-wall-side-panel-order';
    ok(await page.locator('#sidebar > .side-panel > .side-panel-drag').count() === 7
      && await page.locator('#sidebar > .side-panel > .side-panel-drag').evaluateAll(handles => handles.every(handle => handle.title.includes('拖曳調整') && handle.getAttribute('aria-label').includes('拖曳調整'))), 'every sidebar row has a labelled order handle');
    const source = await page.locator('#ai-section .side-panel-drag').boundingBox(), target = await page.locator('#chat-client-panel').boundingBox();
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2); await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + 1, {steps: 5}); await page.mouse.up();
    const draggedOrder = await page.locator('#sidebar > .side-panel').evaluateAll(panels => panels.map(panel => panel.id));
    ok(draggedOrder[0] === 'ai-section' && draggedOrder[1] === 'chat-client-panel', 'dragging a row handle moves it before another row');
    await page.reload(); await ready(page);
    ok((await page.locator('#sidebar > .side-panel').evaluateAll(panels => panels.map(panel => panel.id))).slice(0, 2).join(',') === 'ai-section,chat-client-panel', 'row order survives reload');
    await page.focus('#ai-section .side-panel-drag'); await page.keyboard.press('ArrowDown');
    ok((await page.locator('#sidebar > .side-panel').evaluateAll(panels => panels.map(panel => panel.id))).slice(0, 2).join(',') === 'chat-client-panel,ai-section'
      && await page.evaluate(() => document.activeElement === $('#ai-section .side-panel-drag')), 'arrow key moves a row and keeps focus on its handle');
    await page.evaluate(key => localStorage.removeItem(key), panelOrderKey);
    ok(await page.locator('#activitybar button').count() === 7 && await page.locator('#activitybar button[title][aria-label]').count() === 7
      && await page.locator('#activitybar svg').count() === 7, 'activity bar has seven titled, labelled inline SVG icons');

    const width = () => page.evaluate(() => $('#sidebar').offsetWidth);
    ok(await width() === 300, 'default width 300px');
    const grip = await page.locator('#sidebar-resize').boundingBox();
    await page.mouse.move(grip.x + 2, grip.y + 300); await page.mouse.down();
    await page.mouse.move(grip.x - 198, grip.y + 300, {steps: 5}); await page.mouse.up();
    ok(Math.abs(await width() - 500) <= 3, 'dragging the right edge widens the sidebar (' + await width() + 'px)');
    ok(await page.evaluate(() => vp.clientWidth + activitybar.offsetWidth + activityPanel.offsetWidth + activityResizer.offsetWidth + resizer.offsetWidth + sidebar.offsetWidth === 1400)
      && await page.evaluate(() => Math.abs(parseFloat(bg.style.width) * view.s - vp.clientWidth) < 1), 'viewport and background follow the right drag');
    const grip2 = await page.locator('#sidebar-resize').boundingBox();
    await page.mouse.move(grip2.x + 2, grip2.y + 300); await page.mouse.down(); await page.mouse.move(1390, grip2.y + 300, {steps: 5}); await page.mouse.up();
    ok(await width() === 220, 'width clamps at 220px');
    await page.focus('#sidebar-resize'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
    ok(await width() === 252, 'left arrow widens by 16px');
    await reload(page);
    ok(await width() === 252, 'right width survives reload');

    const leftWidth = () => page.evaluate(() => activityPanel.offsetWidth);
    const leftGrip = await page.locator('#activity-resize').boundingBox();
    await page.mouse.move(leftGrip.x + 2, leftGrip.y + 300); await page.mouse.down();
    await page.mouse.move(leftGrip.x + 202, leftGrip.y + 300, {steps: 5}); await page.mouse.up();
    ok(Math.abs(await leftWidth() - 500) <= 3, 'dragging the left edge widens the activity panel (' + await leftWidth() + 'px)');
    const leftGrip2 = await page.locator('#activity-resize').boundingBox();
    await page.mouse.move(leftGrip2.x + 2, leftGrip2.y + 300); await page.mouse.down(); await page.mouse.move(100, leftGrip2.y + 300, {steps: 5}); await page.mouse.up();
    ok(await leftWidth() === 220, 'left activity panel width clamps at 220px');
    await page.focus('#activity-resize'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
    ok(await leftWidth() === 252, 'right arrow widens the left activity panel by 16px');
    await page.click('#activity-history');
    ok(await page.isVisible('#history-section') && !(await page.isVisible('#files-section')) && await page.getAttribute('#activity-history', 'aria-pressed') === 'true', 'activity icons keep only the active panel open');
    await page.click('#activity-history');
    ok(!(await page.isVisible('#activity-panel')) && await page.getAttribute('#activity-history', 'aria-pressed') === 'false', 'clicking the active activity icon collapses the panel');
    await openActivity(page, 'files');
    await reload(page);
    ok(await leftWidth() === 252 && await page.isVisible('#files-section') && await page.getAttribute('#activity-files', 'aria-pressed') === 'true', 'left panel id and width survive reload');

    await page.click('#zoom-fit');  // the board cannot be scrolled, so bring every card into view before clicking one
    await page.click('.card');
    ok(await page.locator('#panel').isVisible() && await page.evaluate(() => panel.parentElement === $('#main') && getComputedStyle(panel).position === 'fixed'), 'card editor opens as a fixed floating window');
    ok(await page.evaluate(() => document.scrollingElement.scrollTop === 0 && vp.getBoundingClientRect().top > 0), 'opening the editor does not scroll the page');
    const panelBeforeDrag = await page.locator('#panel').boundingBox();
    const titlebar = await page.locator('#panel-titlebar').boundingBox();
    await page.mouse.move(titlebar.x + 70, titlebar.y + titlebar.height / 2); await page.mouse.down();
    await page.mouse.move(titlebar.x + 140, titlebar.y + 70, {steps: 4}); await page.mouse.up();
    const panelAfterDrag = await page.locator('#panel').boundingBox();
    ok(Math.abs(panelAfterDrag.x - panelBeforeDrag.x) > 20 && Math.abs(panelAfterDrag.y - panelBeforeDrag.y) > 20, 'title bar drags the floating editor');
    const titlebar2 = await page.locator('#panel-titlebar').boundingBox();
    await page.mouse.move(titlebar2.x + 70, titlebar2.y + titlebar2.height / 2); await page.mouse.down();
    // Release inside the window: Firefox automation drops a pointerup outside it, which real browsers deliver via capture.
    await page.mouse.move(1, 1, {steps: 5}); await page.mouse.up();
    const clamped = await page.locator('#panel').boundingBox(), viewport = await page.locator('#viewport').boundingBox();
    ok(clamped.x >= viewport.x - 1 && clamped.y >= viewport.y - 1 && clamped.x + clamped.width <= viewport.x + viewport.width + 1
      && clamped.y + clamped.height <= viewport.y + viewport.height + 1, 'floating editor stays inside the viewport when dragged out');
    await page.screenshot({ path: path.join(OUT, 'sidebar-open.png') });
    const blank = {x: 1000, y: 450};
    ok(await page.evaluate(({x, y}) => !document.elementFromPoint(x, y).closest('.card, .hit, .str-label, .band-label'), blank), 'test point is blank board');
    const view0 = await page.evaluate(() => ({...view}));
    await page.mouse.move(blank.x, blank.y); await page.mouse.down();
    await page.mouse.move(blank.x - 120, blank.y - 60, {steps: 4}); await page.mouse.up();
    ok(await page.isVisible('#panel') && await page.evaluate(v => view.x !== v.x, view0), 'panning keeps the editor open');
    await page.mouse.click(blank.x, blank.y);
    ok(!(await page.isVisible('#panel')) && await page.evaluate(() => selCard === null), 'clicking blank board closes the editor');

    await page.click('.card');
    await page.keyboard.press('Escape');
    ok(!(await page.isVisible('#panel')), 'Escape closes the floating editor');
    const vpOpen = await page.evaluate(() => vp.clientWidth);
    await page.click('#toggle-sidebar');
    ok(!(await page.isVisible('#sidebar')) && !(await page.isVisible('#sidebar-resize')) && await page.getAttribute('#toggle-sidebar', 'aria-expanded') === 'false', 'toggle hides the sidebar and its edge');
    await page.waitForFunction(() => Math.abs(parseFloat(bg.style.width) * view.s - vp.clientWidth) < 1);
    ok(await page.evaluate(open => vp.clientWidth + activitybar.offsetWidth + activityPanel.offsetWidth + activityResizer.offsetWidth === 1400
      && vp.clientWidth > open, vpOpen), 'viewport and background widen after hiding the right sidebar');
    await page.click('.card');
    ok(await page.isVisible('#panel') && !(await page.isVisible('#sidebar section')), 'editing with the sidebar hidden shows only the editor');
    await page.screenshot({ path: path.join(OUT, 'editor-only.png') });
    await page.click('#f-close');
    ok(!(await page.isVisible('#sidebar')), 'closing the editor hides the sidebar again');

    await reload(page);
    ok(!(await page.isVisible('#sidebar')), 'hidden state survives reload');
    await page.click('#toggle-sidebar');
    await reload(page);
    ok(await page.isVisible('#sidebar'), 'open state survives reload');
    ok(errs.length === 0, 'no page errors ' + errs.join('; '));
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
