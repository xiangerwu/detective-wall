const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require('playwright-core');
const {ready, reload} = require('./wall-ready.cjs');

const PAGE = process.env.WALL_TEST_URL;
const OUT = process.env.WALL_TEST_OUT || path.resolve(__dirname, '..', 'test-results', 'p19r2l');
const THEMES = ['whiteboard', 'wood', 'paper', 'cork', 'moon', 'cyber'];
const SIZES = [[1400, 900], [1280, 720]];
const GAP_MIN = 6, GAP_MAX = 12, BOTTOM_TOLERANCE = 2;
const failures = [];

function check(condition, message) {
  if (condition) console.log('PASS ' + message);
  else { console.log('FAIL ' + message); failures.push(message); }
}

async function settle(page) { await page.waitForTimeout(700); }

async function setClipboard(page, open) {
  await page.evaluate(value => showClipboard(value, false), open);
  await settle(page);
}

async function geometry(page) {
  return page.evaluate(() => {
    const rect = selector => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return {left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height};
    };
    return {mascot: rect('#mascot'), board: rect('#sidebar'), viewport: {width: innerWidth, height: innerHeight}};
  });
}

function mascotGeometryOk(value) {
  if (!value.mascot || !value.board) return false;
  const gap = value.board.left - value.mascot.right;
  const bottomDelta = Math.abs(value.board.bottom - value.mascot.bottom);
  const inside = value.mascot.left >= -1 && value.mascot.top >= -1
    && value.mascot.right <= value.viewport.width + 1 && value.mascot.bottom <= value.viewport.height + 1;
  const noOverlap = value.mascot.right <= value.board.left && value.mascot.bottom <= value.board.bottom;
  return gap >= GAP_MIN && gap <= GAP_MAX && bottomDelta <= BOTTOM_TOLERANCE && inside && noOverlap;
}

async function setMascotState(page, state) {
  await page.evaluate(next => {
    chatBusy = next === 'thinking';
    $('#chat-progress').hidden = next !== 'thinking';
    chatMessages = next === 'thinking' ? [{role: 'user', text: 'x'}]
      : next === 'happy' ? [{role: 'assistant', text: 'done'}]
      : next === 'sweat' ? [{role: 'assistant', error: 'bad'}]
      : next === 'idle' ? [{role: 'user', text: 'x'}]
      : [];
    updateChatMascot();
  }, state);
  await page.waitForFunction(next => document.querySelector('#mascot-image .rig')?.dataset.mood === next, state);
}

(async () => {
  fs.mkdirSync(OUT, {recursive: true});
  const browser = await playwright[process.env.WALL_TEST_BROWSER || 'chromium'].launch();
  try {
    const context = await browser.newContext({viewport: {width: 1400, height: 900}});
    const page = await context.newPage();
    await page.addInitScript(() => {
      globalThis.__MASCOT_TEST_TIMING = {idleSwitchMs: 500, blinkDelayMs: 200};
    });
    await page.clock.install({time: new Date('2026-11-04T12:00:00Z')});
    await page.clock.pauseAt(new Date('2026-11-04T12:00:01Z'));
    await page.goto(PAGE); await ready(page);
    await page.waitForFunction(() => document.querySelector('#mascot-image .rig')?.dataset.ready === 'true');

    await page.evaluate(() => { setTheme('cork'); showMascotBubble(''); });
    await setClipboard(page, true);
    await page.screenshot({path: path.join(OUT, 'mascot-clipboard-open-cork-1400x900.png')});
    await setClipboard(page, false);
    await page.screenshot({path: path.join(OUT, 'mascot-clipboard-docked-cork-1400x900.png')});

    await check((await page.locator('#mascot').getAttribute('aria-label'))?.includes('可拖曳') === false,
      'mascot is not advertised as draggable');
    const initial = await page.locator('#mascot').boundingBox();
    const image = await page.locator('#mascot-image').boundingBox();
    await page.mouse.move(image.x + image.width / 2, image.y + image.height / 2);
    await page.mouse.down(); await page.mouse.move(image.x + 160, image.y - 120, {steps: 5}); await page.mouse.up();
    const afterDrag = await page.locator('#mascot').boundingBox();
    check(initial && afterDrag && Math.abs(initial.x - afterDrag.x) <= 1 && Math.abs(initial.y - afterDrag.y) <= 1,
      'dragging the mascot does not move it');

    await setMascotState(page, 'happy');
    await page.waitForFunction(() => document.querySelector('#mascot-image .rig')?.dataset.mood === 'happy');
    await page.clock.runFor(4999);
    check(await page.locator('#mascot-image .rig').getAttribute('data-mood') === 'happy',
      'happy state remains until the named five-second return delay');
    await page.clock.runFor(1);
    const returnedToIdle = await page.waitForFunction(() => document.querySelector('#mascot-image .rig')?.dataset.mood === 'idle', null, {timeout: 1000})
      .then(() => true).catch(() => false);
    check(returnedToIdle && await page.locator('#mascot-image .rig').getAttribute('data-mood') === 'idle',
      'happy returns to the idle carousel after 5 seconds');

    await page.evaluate(() => cancelMascotHappyReturn());
    await setMascotState(page, 'happy');
    await page.waitForFunction(() => document.querySelector('#mascot-image .rig')?.dataset.mood === 'happy');
    await page.clock.runFor(1000);
    await setMascotState(page, 'thinking');
    await page.clock.runFor(5000);
    const newMessageMood = await page.locator('#mascot-image .rig').getAttribute('data-mood');
    check(newMessageMood === 'thinking', `a new message cancels the pending happy-to-idle return (mood ${newMessageMood})`);
    await setMascotState(page, 'sweat');
    await page.clock.runFor(5000);
    const errorMood = await page.locator('#mascot-image .rig').getAttribute('data-mood');
    check(errorMood === 'sweat', `an error cancels the pending happy-to-idle return and keeps sweat (mood ${errorMood})`);

    for (const [width, height] of SIZES) {
      await page.setViewportSize({width, height});
      for (const theme of THEMES) for (const open of [true, false]) {
        await page.evaluate(({theme: nextTheme}) => {
          setTheme(nextTheme); showMascotBubble('');
        }, {theme});
        await setClipboard(page, open);
        const value = await geometry(page);
        check(mascotGeometryOk(value), `${theme}/${width}x${height}/${open ? 'open' : 'docked'}: mascot follows board geometry (${JSON.stringify(value)})`);
        if (theme === 'cork' || theme === 'moon') {
          await page.screenshot({path: path.join(OUT, `mascot-clipboard-${open ? 'open' : 'docked'}-${theme}-${width}x${height}.png`)});
        }
      }
    }

    await page.setViewportSize({width: 1400, height: 900});
    await page.evaluate(() => { setTheme('cork'); });
    await setClipboard(page, false);
    const docked = await geometry(page);
    await page.evaluate(() => showClipboard(true));
    await page.waitForTimeout(280);
    const mid = await geometry(page);
    const boardProgress = (mid.board.left - docked.board.left) / (docked.board.left - (mid.board?.left || docked.board.left));
    const midGap = mid.board.left - mid.mascot.right;
    check(midGap >= GAP_MIN && midGap <= GAP_MAX && Math.abs(mid.board.bottom - mid.mascot.bottom) <= BOTTOM_TOLERANCE,
      `mascot follows the clipboard during its slide (mid-gap ${midGap.toFixed(1)}px)`);
    check(mid.board.left < docked.board.left && mid.mascot.right < docked.mascot.right,
      `mascot and clipboard move in the same direction during the slide (${boardProgress.toFixed(3)})`);
    await settle(page);

    const beforeResize = await page.locator('#mascot').boundingBox();
    const grip = await page.locator('#mascot-resize').boundingBox();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down(); await page.mouse.move(grip.x - 36, grip.y - 36, {steps: 4}); await page.mouse.up();
    const afterResize = await page.locator('#mascot').boundingBox();
    check(afterResize.height > beforeResize.height
      && Math.abs(afterResize.x + afterResize.width - beforeResize.x - beforeResize.width) <= 2
      && Math.abs(afterResize.y + afterResize.height - beforeResize.y - beforeResize.height) <= 2,
      `top-left resize keeps the mascot bottom-right corner anchored (${JSON.stringify({beforeResize, afterResize})})`);
    await reload(page);
    await setClipboard(page, true);
    const persistedSize = await page.locator('#mascot').boundingBox();
    check(Math.abs(persistedSize.height - afterResize.height) <= 3,
      'mascot resize persists across reload');

    await page.click('#ai-tab-model');
    await settle(page);
    await page.screenshot({path: path.join(OUT, 'model-sheet-show-ai-mascot.png')});
    const visibleToggle = page.locator('#mascot-visible');
    const hasToggle = await visibleToggle.count() === 1;
    check(hasToggle && await visibleToggle.isChecked(), 'model sheet has the default-on 顯示 AI 人物 checkbox');
    if (hasToggle) {
      await setMascotState(page, 'idle');
      await page.waitForFunction(() => document.querySelector('#mascot-image .rig')?.dataset.mood === 'idle');
      await visibleToggle.uncheck();
      check(await page.locator('#mascot').isHidden() && await page.evaluate(() => ({
        tabIndex: document.querySelector('#mascot')?.tabIndex,
        ariaHidden: document.querySelector('#mascot')?.getAttribute('aria-hidden'),
        idle: mascotIdleTimer,
        blink: mascotBlinkTimer,
      })).then(value => value.tabIndex === -1 && value.ariaHidden === 'true' && value.idle === 0 && value.blink === 0),
      'hiding AI 人物 hides it, removes focusability, and stops idle/blink timers');
      await visibleToggle.check();
      await page.waitForFunction(() => !document.querySelector('#mascot').hidden && document.querySelector('#mascot-image .rig')?.dataset.mood === 'idle');
      check(await page.locator('#mascot').isVisible() && await page.evaluate(() => mascotIdleTimer !== 0),
        'turning AI 人物 back on restores the current idle state and restarts idle timing');
      await visibleToggle.uncheck();
      await reload(page);
      await page.click('#ai-tab-model');
      check(!(await page.locator('#mascot-visible').isChecked()) && await page.locator('#mascot').isHidden(),
        'AI 人物 visibility persists across reload');
      await page.locator('#mascot-visible').check();
      await page.waitForFunction(() => !document.querySelector('#mascot').hidden && document.querySelector('#mascot-image .rig')?.dataset.ready === 'true');
      check(await page.locator('#mascot').isVisible() && await page.locator('#mascot').getAttribute('aria-hidden') !== 'true'
        && await page.locator('#mascot-image .rig').getAttribute('data-mood') === 'sleep',
      'turning AI 人物 back on restores the current current chat state');
    } else {
      for (const message of [
        'hiding AI 人物 hides it, removes focusability, and stops idle/blink timers',
        'AI 人物 visibility persists across reload',
        'turning AI 人物 back on restores the current state and restarts idle timing',
      ]) check(false, message);
    }
  } finally {
    await browser.close();
  }
  if (failures.length) throw new Error(`${failures.length} P19-R2l checks failed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
