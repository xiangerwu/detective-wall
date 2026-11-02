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
    const header = await page.locator('#topbar').boundingBox(), side = await page.locator('#sidebar').boundingBox();
    ok(header.height < 100, 'header is one toolbar row plus the tab row at 1400px (' + header.height + 'px)');
    ok(await page.isVisible('#sidebar') && Math.round(side.x + side.width) === 1400 && await page.getAttribute('#toggle-sidebar', 'aria-expanded') === 'true', 'sidebar open by default on the right');
    ok((await page.locator('#case-folder-header').textContent()).includes('AI 案件夾')
      && !(await page.locator('#sidebar .theme-picker, #sidebar #theme').count()), 'AI case-folder header is present without a theme dropdown');
    for (const id of ['export', 'export-canvas', 'import', 'reset'])
      if (!await page.locator('#rail-panel #' + id).count()) ok(false, id + ' is in the files rail panel');
    ok(await page.locator('#case-folder-tabs [role=tab]').count() === 4
      && !(await page.locator('#sidebar #export').count()) && !(await page.locator('#chat-mascot-panel').count()), 'AI case-folder exposes model, proposals, audit, and chat tabs');
    for (const [tab, pane] of [['chat', '#case-pane-chat'], ['proposals', '#case-pane-proposals'], ['audit', '#case-pane-audit'], ['model', '#case-pane-model']]) {
      await page.click(`#ai-tab-${tab}`);
      ok(await page.locator(pane).isVisible() && await page.getAttribute(`#ai-tab-${tab}`, 'aria-selected') === 'true', `AI case-folder switches to ${tab}`);
    }
    await page.click('#ai-tab-chat');
    ok(await page.locator('#mascot').isVisible() && await page.locator('#mascot').evaluate(el => getComputedStyle(el).position === 'fixed'), 'the character is a fixed mascot outside the sidebar');
    ok(await page.locator('#rail .rail-activity').count() === 8 && await page.locator('#rail .rail-activity[title][aria-label]').count() === 8
      && await page.locator('#rail .rail-activity svg').count() === 8, 'rail has eight titled, labelled inline SVG icons');

    const width = () => page.evaluate(() => $('#sidebar').offsetWidth);
    ok(await width() === 300, 'default width 300px');
    const grip = await page.locator('#sidebar-resize').boundingBox();
    await page.mouse.move(grip.x + 2, grip.y + 300); await page.mouse.down();
    await page.mouse.move(grip.x - 198, grip.y + 300, {steps: 5}); await page.mouse.up();
    ok(Math.abs(await width() - 500) <= 3, 'dragging the right edge widens the sidebar (' + await width() + 'px)');
    ok(await page.evaluate(() => vp.clientWidth + rail.offsetWidth + activityPanel.offsetWidth + railResizer.offsetWidth + resizer.offsetWidth + sidebar.offsetWidth === 1400)
      && await page.evaluate(() => Math.abs(parseFloat(bg.style.width) * view.s - vp.clientWidth) < 1), 'viewport and background follow the right drag');
    const grip2 = await page.locator('#sidebar-resize').boundingBox();
    await page.mouse.move(grip2.x + 2, grip2.y + 300); await page.mouse.down(); await page.mouse.move(1390, grip2.y + 300, {steps: 5}); await page.mouse.up();
    ok(await width() === 220, 'width clamps at 220px');
    await page.focus('#sidebar-resize'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
    ok(await width() === 252, 'left arrow widens by 16px');
    await reload(page);
    ok(await width() === 252, 'right width survives reload');

    await openActivity(page, 'files');
    ok(await page.evaluate(() => activityPanel.offsetWidth === 300 && !localStorage.getItem('thesis-detective-wall-activity-width')), 'rail panel keeps its fixed shell width and ignores the old width key');
    await page.click('#activity-history');
    ok(await page.isVisible('#history-section') && !(await page.isVisible('#files-section')) && await page.getAttribute('#activity-history', 'aria-pressed') === 'true', 'activity icons keep only the active panel open');
    await page.click('#activity-history');
    ok(!(await page.isVisible('#rail-panel')) && await page.getAttribute('#activity-history', 'aria-pressed') === 'false', 'clicking the active activity icon collapses the panel');
    await openActivity(page, 'files');
    await reload(page);
    ok(!(await page.isVisible('#rail-panel')) && await page.getAttribute('#activity-files', 'aria-pressed') === 'false', 'activity panel state is transient and old activity values are ignored');

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
    ok(await page.evaluate(open => vp.clientWidth + rail.offsetWidth + (activityPanel.hidden ? 0 : activityPanel.offsetWidth) + railResizer.offsetWidth === 1400
      && vp.clientWidth > open, vpOpen), 'viewport and background widen after hiding the right sidebar');
    await page.click('.card');
    ok(await page.isVisible('#panel') && !(await page.isVisible('#case-folder')), 'editing with the sidebar hidden shows only the editor');
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
