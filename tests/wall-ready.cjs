const fs = require('fs');
const path = require('path');
// Test outputs and isolated Firefox profiles stay under the selected artifact directory.
const artifacts = suite => {
  const dir = path.resolve(process.env.WALL_TEST_OUT || path.join(__dirname, 'artifacts', suite));
  fs.mkdirSync(dir, {recursive: true});
  return dir;
};
const profile = () => fs.mkdtempSync(path.join(artifacts('profiles'), 'wall-ffprof-'));
const ready = page => page.waitForFunction(() => window.wallReady === true);
const reload = async page => {
  await page.evaluate(() => store.listWalls()); // Wait for the async save to commit before leaving.
  await page.reload();
  await ready(page);
};
const settled = page => page.waitForFunction(() => !wallBusy && !document.body.inert && !document.querySelector('[inert]'));
const openActivity = async (page, id) => {
  const button = page.locator(`#activity-${id}`);
  if (await button.getAttribute('aria-pressed') !== 'true') await button.click();
  await page.waitForFunction(id => document.querySelector(`#activity-${id}`)?.getAttribute('aria-pressed') === 'true'
    && !document.querySelector('#activity-panel').hidden, id);
};
const openSidebar = async page => {
  if (await page.getAttribute('#toggle-sidebar', 'aria-expanded') !== 'true') await page.click('#toggle-sidebar');
  await page.waitForFunction(() => document.querySelector('#toggle-sidebar')?.getAttribute('aria-expanded') === 'true'
    && getComputedStyle(document.querySelector('#sidebar')).display !== 'none');
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
