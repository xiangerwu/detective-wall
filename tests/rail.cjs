const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require('playwright-core');
const {ready, reload, settled, openActivity, openSidebar} = require('./wall-ready.cjs');

const PAGE = process.env.WALL_TEST_URL || path.join(__dirname, '..', 'index.html');
const OUT = path.resolve(__dirname, '..', 'test-results', 'p19r1');
fs.mkdirSync(OUT, {recursive: true});

function contrast(page, type) {
  return page.evaluate(type => {
    const parse = value => (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const lum = ([r, g, b]) => [r, g, b].map(value => { value /= 255; return value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; })
      .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    const button = document.querySelector(`#types [data-type="${type}"]`), line = button.querySelector('line'), svg = button.querySelector('svg');
    const background = getComputedStyle(svg).backgroundColor === 'rgba(0, 0, 0, 0)' ? getComputedStyle(button).backgroundColor : getComputedStyle(svg).backgroundColor;
    const [light, dark] = [lum(parse(getComputedStyle(line).stroke)), lum(parse(background))].sort((a, b) => b - a);
    return (light + .05) / (dark + .05);
  }, type);
}

async function snap(page, theme, width, height, state) {
  await page.setViewportSize({width, height});
  await page.evaluate(({theme, state}) => { setTheme(theme); setCardStyle('tech'); showSidebar(true); showActivity(null); closePanel(); setRailState(state); }, {theme, state});
  await page.waitForTimeout(260);
  await page.screenshot({path: path.join(OUT, `rail-${state}-${theme}-${width}x${height}.png`)});
}

(async () => {
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'firefox'].launch();
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 900}});
    await page.goto(PAGE); await ready(page);

    assert.equal(await page.locator('#activitybar').count(), 0, 'old activity bar is removed');
    assert.equal(await page.locator('#rail').getAttribute('data-state'), 'icon');
    assert.equal(await page.locator('#rail').evaluate(el => Math.round(el.getBoundingClientRect().width)), 78, 'default rail is the icon rail');
    assert.equal(await page.getAttribute('#rail-toggle', 'aria-expanded'), 'true');

    await page.click('#rail-toggle');
    assert.equal(await page.locator('#rail').isVisible(), false, 'rail toggle hides the rail');
    assert.equal(await page.getAttribute('#rail-toggle', 'aria-expanded'), 'false');
    await page.click('#rail-toggle');
    assert.equal(await page.locator('#rail').getAttribute('data-state'), 'icon', 'rail toggle restores the icon rail');

    const drag = async (delta, expected) => {
      const grip = await page.locator('#rail-resize').boundingBox();
      await page.mouse.move(grip.x + 2, grip.y + 260); await page.mouse.down();
      await page.mouse.move(grip.x + 2 + delta, grip.y + 260, {steps: 6}); await page.mouse.up();
      await page.waitForTimeout(240);
      assert.equal(await page.locator('#rail').getAttribute('data-state'), expected);
      assert.equal(await page.locator('#rail').evaluate(el => Math.round(el.getBoundingClientRect().width)), expected === 'full' ? 232 : 78);
    };
    await drag(110, 'full');
    await drag(-110, 'icon');
    await page.focus('#rail-resize'); await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#rail').getAttribute('data-state'), 'full', 'rail edge ArrowRight selects full rail');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.locator('#rail').getAttribute('data-state'), 'icon', 'rail edge ArrowLeft selects icon rail');
    await page.evaluate(() => setRailState('full'));
    await reload(page);
    assert.equal(await page.locator('#rail').getAttribute('data-state'), 'full', 'rail state survives reload');
    await page.evaluate(() => setRailState('icon'));
    await reload(page);
    assert.equal(await page.locator('#rail').getAttribute('data-state'), 'icon');

    const named = await page.locator('#rail button:visible').evaluateAll(buttons => buttons.map(button => ({id: button.id, name: button.getAttribute('aria-label') || button.title || button.innerText.trim()})));
    assert.ok(named.length >= 12 && named.every(button => button.name), 'every visible rail control has an accessible name');
    assert.ok(await page.locator('#rail-resize').getAttribute('aria-label'));
    for (const type of ['builds', 'uses', 'question']) {
      await page.click(`#types [data-type="${type}"]`); await page.waitForTimeout(300);
      assert.ok(await contrast(page, type) >= 1.8, `${type} selected sample keeps contrast >= 1.8`);
    }

    const panels = {files: 'files-section', history: 'history-section', templates: 'template-section', sources: 'source-section', tags: 'tags-section', theme: 'theme-section', help: 'help-section'};
    for (const [id, section] of Object.entries(panels)) {
      await openActivity(page, id);
      assert.equal(await page.locator(`#${section}`).isVisible(), true, `${id} opens beside the rail`);
    }
    await page.evaluate(() => showActivity(null));

    await openSidebar(page);
    for (const [tab, pane] of [['chat', 'case-pane-chat'], ['proposals', 'case-pane-proposals'], ['audit', 'case-pane-audit'], ['model', 'case-pane-model']]) {
      await page.click(`#ai-tab-${tab}`);
      assert.equal(await page.getAttribute(`#ai-tab-${tab}`, 'aria-selected'), 'true');
      assert.equal(await page.locator(`#${pane}`).isVisible(), true, `${tab} case-folder pane is visible`);
    }
    assert.ok(await page.locator('#chat-input').count() && await page.locator('#chat-stop').count());
    assert.ok(await page.locator('#ai-proposals-toggle').count() && await page.locator('#ai-review-open').count() && await page.locator('#ai-proposal-list').count());
    assert.ok(await page.locator('#ai-audit-list').count());
    assert.ok(await page.locator('#chat-client').count() && await page.locator('#chat-new').count() && await page.locator('#chat-client-state').count());

    const cards = await page.evaluate(() => data.cards.length);
    await page.click('#add-card'); await page.waitForFunction(count => data.cards.length === count + 1, cards);
    await page.click('#layout-wall-arrow');
    assert.equal(await page.locator('#layout-wall-menu [data-mode]').count(), 3, 'layout menu keeps its three modes');
    await page.click('#layout-wall-menu [data-mode="grid"]'); await page.click('#layout-wall'); await settled(page);
    await page.click('#zoom-in'); await page.click('#zoom-out'); await page.click('#zoom-fit');
    assert.match(await page.textContent('#zoom-pct'), /%$/);

    for (const theme of ['cork', 'moon']) for (const size of [[1400, 900], [1280, 720]]) {
      for (const state of ['icon', 'full', 'hidden']) await snap(page, theme, size[0], size[1], state);
      await page.setViewportSize({width: size[0], height: size[1]});
      await page.evaluate(() => { closePanel(); setRailState('icon'); });
      for (const tab of ['chat', 'proposals', 'audit', 'model']) {
        await page.click(`#ai-tab-${tab}`); await page.waitForTimeout(120);
        await page.screenshot({path: path.join(OUT, `ai-${tab}-${theme}-${size[0]}x${size[1]}.png`)});
      }
    }
    console.log(`PASS P19-R1 rail, activity panels, AI case-folder tabs, moved controls, and screenshots in ${OUT}`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
