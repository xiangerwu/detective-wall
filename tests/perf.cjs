const {performance} = require('node:perf_hooks');
const playwright = require('playwright-core');
const {ready, artifacts, profile} = require('./wall-ready.cjs');

const OUT = artifacts('perf');
const PROF = profile();
const browserName = process.env.WALL_TEST_BROWSER || 'firefox';
const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
};
const median = values => percentile(values, .5);
const ok = (condition, message) => {
  console.log((condition ? 'PASS ' : 'FAIL ') + message);
  if (!condition) process.exitCode = 1;
};

async function nextFrame(page) {
  return page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve(performance.now()))));
}

async function idleFrameMetrics(page) {
  return page.evaluate(() => new Promise(resolve => {
    const values = [];
    let previous = 0;
    const sample = time => {
      if (previous) values.push(time - previous);
      previous = time;
      if (values.length < 30) requestAnimationFrame(sample);
      else resolve(values);
    };
    requestAnimationFrame(sample);
  }));
}

async function seed(page) {
  await page.evaluate(async () => {
    const cards = Array.from({length: 500}, (_, i) => ({
      id: 'perf-c' + i,
      kind: i % 5 === 0 ? 'note' : 'card',
      x: 20 + (i % 10) * 130,
      y: i < 100 ? 20 + Math.floor(i / 10) * 75 : 1000 + Math.floor(i / 10) * 75,
      title: '效能卡片 ' + i,
      note: '',
      links: [],
    }));
    const edges = Array.from({length: 1000}, (_, i) => ({
      id: 'perf-e' + i,
      from: cards[i % cards.length].id,
      to: cards[(i * 37 + 1) % cards.length].id,
      type: ['builds', 'uses', 'question'][i % 3],
    }));
    data = {
      bands: Array.from({length: 10}, (_, i) => ({id: 'perf-b' + i, title: '分層 ' + i, y: i * 500})),
      tags: [], cards, edges,
    };
    selCard = selEdge = drag = tempLine = null;
    view = {s: 1, x: 0, y: 0};
    render();
    await save(true);
    await store.flushWrites();
  });
}

async function measureDrag(page) {
  await page.evaluate(() => {
    window.__perfRenderTimes = [];
    const originalRenderStrings = window.renderStrings;
    window.renderStrings = function(...args) {
      const start = performance.now();
      const result = originalRenderStrings(...args);
      window.__perfRenderTimes.push(performance.now() - start);
      return result;
    };
    view = {s: 1, x: 0, y: 0};
    applyView();
    picked.clear();
    window.__perfFrames = [];
    window.__perfFrameDone = false;
    window.__perfFrameRecording = true;
    let previous = 0;
    const sample = time => {
      if (window.__perfFrameRecording) {
        if (previous) window.__perfFrames.push(time - previous);
        previous = time;
      }
      if (window.__perfFrameRecording || window.__perfFrames.length < 40) requestAnimationFrame(sample);
      else window.__perfFrameDone = true;
    };
    requestAnimationFrame(sample);
  });
  const box = await page.locator('.card[data-id="perf-c0"]').boundingBox();
  if (!box) throw new Error('performance card is not visible');
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.mouse.down();
  const start = performance.now();
  for (let i = 1; i <= 45; i++) {
    await page.mouse.move(box.x + 30 + i * 3, box.y + 30 + i * 2);
    await page.waitForTimeout(8);
  }
  const dropStart = performance.now();
  await page.mouse.up();
  await nextFrame(page);
  const dropRepaintMs = performance.now() - dropStart;
  await page.evaluate(() => { window.__perfFrameRecording = false; });
  await page.waitForFunction(() => window.__perfFrameDone === true);
  const frames = await page.evaluate(() => window.__perfFrames.slice());
  const renderTimes = await page.evaluate(() => window.__perfRenderTimes.slice());
  return {
    dragMs: performance.now() - start,
    dragFrameP95Ms: percentile(frames, .95),
    dragFrameMaxMs: Math.max(0, ...frames),
    dragFrameMedianMs: median(frames),
    dragFrameCount: frames.length,
    dropRepaintMs,
    renderCalls: renderTimes.length,
    renderMaxMs: Math.max(0, ...renderTimes),
    renderTotalMs: renderTimes.reduce((sum, value) => sum + value, 0),
  };
}

async function measureZoomPan(page) {
  const viewport = await page.locator('#viewport').boundingBox();
  if (!viewport) throw new Error('viewport is not visible');
  await page.evaluate(() => {
    view = {s: 1, x: 0, y: 0};
    applyView();
  });
  const zoom = [];
  for (let i = 0; i < 12; i++) {
    const start = performance.now();
    await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
    await page.mouse.wheel(0, i % 2 ? -80 : 80);
    await nextFrame(page);
    zoom.push(performance.now() - start);
  }
  const panStart = performance.now();
  await page.mouse.move(viewport.x + viewport.width - 10, viewport.y + viewport.height - 10);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(viewport.x + viewport.width - 10 - i * 2, viewport.y + viewport.height - 10 - i * 2);
    await page.waitForTimeout(8);
  }
  await page.mouse.up();
  await nextFrame(page);
  return {zoomMedianMs: median(zoom), panMs: performance.now() - panStart};
}

async function measureMarquee(page) {
  const viewport = await page.locator('#viewport').boundingBox();
  if (!viewport) throw new Error('viewport is not visible');
  await page.evaluate(() => {
    view = {s: .5, x: 0, y: 0};
    applyView();
    clearPicked();
  });
  const start = performance.now();
  await page.mouse.move(viewport.x + 2, viewport.y + 2);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(viewport.x + 750, viewport.y + 470, {steps: 3});
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await nextFrame(page);
  return {marquee100Ms: performance.now() - start, picked: await page.evaluate(() => picked.size)};
}

(async () => {
  const context = await playwright[browserName].launchPersistentContext(PROF, {
    viewport: {width: 1400, height: 900},
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(process.env.WALL_TEST_URL || 'http://127.0.0.1:3000');
    await ready(page);
    await seed(page);
    const idleFrames = await idleFrameMetrics(page);

    const loadStart = performance.now();
    await page.reload({waitUntil: 'domcontentloaded'});
    await ready(page);
    const initialLoadMs = performance.now() - loadStart;
    const renderMs = await page.evaluate(() => {
      const start = performance.now();
      render();
      return performance.now() - start;
    });
    const incrementalRenderMs = await page.evaluate(() => {
      const start = performance.now();
      for (let i = 0; i < 5; i++) renderStrings(new Set(['perf-c0']));
      return (performance.now() - start) / 5;
    });
    const drag = await measureDrag(page);
    const zoomPan = await measureZoomPan(page);
    const saveStart = performance.now();
    await page.evaluate(async () => {
      data.cards[0].title += ' save';
      await save(true);
      await store.flushWrites();
    });
    const saveMs = performance.now() - saveStart;
    const marquee = await measureMarquee(page);
    const metrics = {
      initialLoadMs, renderMs, incrementalRenderMs, ...drag, ...zoomPan, saveMs, ...marquee,
      idleFrameMedianMs: median(idleFrames), idleFrameP95Ms: percentile(idleFrames, .95),
      wall: {cards: 500, edges: 1000, bands: 10},
    };
    console.log('PERF ' + JSON.stringify(metrics));
    ok(metrics.picked >= 95, 'marquee selects about 100 cards');
    // ponytail: the sandbox's pointer automation adds jitter; allow up to 3x its idle p95, with a 100ms floor.
    const frameLimitMs = Math.max(100, metrics.idleFrameP95Ms * 3);
    ok(metrics.dragFrameP95Ms < frameLimitMs, `drag p95 frame < ${frameLimitMs.toFixed(2)}ms (${metrics.dragFrameP95Ms.toFixed(2)}ms)`);
    console.log('Artifacts: ' + OUT);
  } finally {
    await context.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
