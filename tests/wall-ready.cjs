const fs = require('fs');
const path = require('path');
// Test outputs and isolated Firefox profiles stay under the selected artifact directory.
const artifacts = suite => {
  const dir = path.resolve(process.env.WALL_TEST_OUT || path.join(__dirname, 'artifacts', suite));
  fs.mkdirSync(dir, {recursive: true});
  return dir;
};
const profile = () => fs.mkdtempSync(path.join(artifacts('profiles'), 'wall-ffprof-'));
// Tests rewrite walls. tests/run.cjs gives each suite its own server and database on a random port;
// refuse to touch the user's live service on the default port, whoever starts the test.
const ready = page => {
  if (/^https?:\/\/(127\.0\.0\.1|localhost):3000(\/|$)/.test(page.url()))
    throw new Error('refusing to run a test against the live service on port 3000; run it through tests/run.cjs');
  return page.waitForFunction(() => window.wallReady === true && !window.wallBusy && !document.body.inert);
};
const reload = async page => {
  await page.evaluate(() => store.listWalls()); // Wait for the async save to commit before leaving.
  await page.reload();
  await ready(page);
};
const settled = page => page.waitForFunction(() => !wallBusy && !document.body.inert);
const openActivity = async (page, id) => {
  if (await page.getAttribute('#activity-toggle', 'aria-expanded') !== 'true') await page.click('#activity-toggle');
  const button = page.locator(`#activity-${id}`);
  if (await button.getAttribute('aria-pressed') !== 'true') await button.click();
  await page.waitForFunction(id => document.querySelector(`#activity-${id}`)?.getAttribute('aria-pressed') === 'true'
    && !document.querySelector('#rail-panel').hidden, id);
};
const openSidebar = async page => {
  if (await page.getAttribute('#sidebar', 'aria-expanded') !== 'true') await page.click('#clipboard-peek');
  await page.waitForFunction(() => document.querySelector('#sidebar')?.getAttribute('aria-expanded') === 'true'
    && document.querySelector('#sidebar')?.classList.contains('is-open'));
  await page.waitForFunction(() => {
    const r = document.querySelector('#sidebar')?.getBoundingClientRect();
    return r && r.right <= innerWidth + 1;
  });
};
const previewBackup = async (page, id) => {
  await openActivity(page, 'history');
  await page.click('#show-backups');
  await page.waitForSelector('#backups[open]');
  const row = id == null ? page.locator('.backup-row').first() : page.locator(`.backup-row[data-id="${id}"]`);
  await row.getByRole('button', {name: '預覽還原'}).click();
  await page.waitForSelector('#importer[open]');
  await settled(page);
};
const restoreBackup = async (page, id) => {
  await previewBackup(page, id);
  await page.click('#im-replace'); await page.click('#im-replace');
  await settled(page);
};
const chooseWall = async (page, id) => {
  await page.click(`.wall-tab[data-id="${id}"]`);
  await page.waitForFunction(id => currentWall.id === id && !wallBusy, id);
};
const tab = id => id ? `.wall-tab[data-id="${id}"]` : '.wall-tab[aria-selected=true]';
const openTabMenu = (page, id) => page.click(tab(id), {button: 'right'});
const renameWall = async (page, name, id) => {
  await page.dblclick(tab(id));
  await page.fill('.wall-tab input', name);
  await page.press('.wall-tab input', 'Enter');
  await settled(page);
};
module.exports = { ready, reload, settled, openActivity, openSidebar, previewBackup, restoreBackup, artifacts, profile, chooseWall, openTabMenu, renameWall };
