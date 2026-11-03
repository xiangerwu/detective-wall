const { ready, reload, openActivity, openSidebar, artifacts } = require('./wall-ready.cjs');
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
    const header = await page.locator('#topbar').boundingBox();
    ok(header.height < 100, 'header is one toolbar row plus the tab row at 1400px (' + header.height + 'px)');
    ok(await page.getAttribute('#sidebar', 'aria-expanded') === 'false' && await page.locator('#clipboard-peek').isVisible(), 'clipboard starts docked with a visible peek');
    await openSidebar(page);
    const side = await page.locator('#sidebar').boundingBox();
    ok(await page.isVisible('#sidebar') && side.x + side.width <= 1401 && await page.getAttribute('#sidebar', 'aria-expanded') === 'true', 'floating clipboard opens on the right without reserving a column');
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
    ok(await page.locator('#mascot').isVisible() && await page.locator('#mascot').evaluate(el => getComputedStyle(el).position === 'fixed'), 'the character is a fixed mascot outside the clipboard');
    ok(await page.locator('#rail .rail-activity').count() === 8 && await page.locator('#rail .rail-activity[title][aria-label]').count() === 8
      && await page.locator('#rail .rail-activity svg').count() === 8, 'rail has eight titled, labelled inline SVG icons');

    const openWidth = await page.evaluate(() => vp.clientWidth);
    await page.click('#clipboard-close');
    const dockWidth = await page.evaluate(() => vp.clientWidth);
    ok(Math.abs(openWidth - dockWidth) <= 1, 'docking the clipboard leaves the wall at the same full width');
    await page.click('#clipboard-peek'); await page.waitForTimeout(650);
    ok(await page.getAttribute('#sidebar', 'aria-expanded') === 'true', 'the focusable peek opens the clipboard');

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
    await page.keyboard.press('Escape');
    ok(await page.getAttribute('#sidebar', 'aria-expanded') === 'false', 'Escape docks the floating clipboard');
    await page.click('.card');
    ok(await page.isVisible('#panel') && await page.isVisible('#clipboard-peek'), 'editing with the clipboard docked leaves only the editor over the wall');
    await page.screenshot({ path: path.join(OUT, 'editor-with-clipboard-docked.png') });
    await page.click('#f-close');

    await page.keyboard.press('Alt+Shift+A'); await page.waitForTimeout(650);
    await reload(page);
    ok(await page.getAttribute('#sidebar', 'aria-expanded') === 'true', 'open clipboard state survives reload');
    await page.keyboard.press('Escape'); await reload(page);
    ok(await page.getAttribute('#sidebar', 'aria-expanded') === 'false', 'docked clipboard state survives reload');
    ok(errs.length === 0, 'no page errors ' + errs.join('; '));
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
