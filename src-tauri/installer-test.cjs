// Real installer helper + installed-path WebView2 test, with isolated data and no registry changes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {spawn, spawnSync} = require('node:child_process');
const {chromium} = require('playwright-core');
const base = path.join(__dirname, 'target', 'installer-checks');
fs.mkdirSync(base, {recursive:true});
const run = fs.mkdtempSync(path.join(base, 'run-'));
const install = path.join(run, '安裝 路徑');
const release = process.env.CASEGRAPH_RELEASE_DIR || path.join(__dirname,'target','release');
fs.mkdirSync(install);
for (const name of ['casegraph.exe','casegraph-mcp.exe']) fs.copyFileSync(path.join(release,name), path.join(install,name));
fs.copyFileSync(path.join(__dirname,'hidden-console.js'),path.join(install,'hidden-console.js'));
const env = {...process.env, APPDATA:path.join(run,'AppData'), WEBVIEW2_USER_DATA_FOLDER:path.join(run,'profile')};
env.CODEX_HOME = path.join(run, 'codex-config');
fs.mkdirSync(env.CODEX_HOME);
delete env.CASEGRAPH_USER_DATA;
delete env.WALL_PORT;
const exe = path.join(install,'casegraph.exe');
const request = path.join(run,'request.ini');
function helper(...args) {
  const result = spawnSync(exe, ['--installer',...args], {env,windowsHide:true,encoding:'utf8',timeout:30000});
  assert.ifError(result.error);
  const receipt = args[0] === 'inspect' ? args[2] : args[1];
  const resultFile = receipt.replace(/\.[^.\\/]+$/, '') + '.result.ini';
  assert.equal(result.status,0, fs.existsSync(resultFile) ? fs.readFileSync(resultFile,'utf16le') : result.stderr);
}
function update(changes) {
  let text=fs.readFileSync(request,'utf16le');
  for (const [key,value] of Object.entries(changes)) text=text.replace(new RegExp('^'+key+'=.*$','m'),key+'='+value);
  fs.writeFileSync(request,text,'utf16le');
}
async function freePort() {
  const server=net.createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(action, label) {
  let last;
  for(let i=0;i<200;i++) { try { const result=await action(); if(result)return result; } catch(error){last=error;} await sleep(100); }
  throw new Error(label+': '+last);
}
let child,browser,page;
(async()=>{
  try {
    const port=await freePort(), debug=await freePort();
    helper('inspect',install,request);
    update({port,appearance:1,theme:'moon',cardStyle:'tech',mascotVisible:0,reduceMotion:1,aiProposals:1});
    if (process.env.CASEGRAPH_TEST_CODEX) update({registerMcp:1,codex:process.env.CASEGRAPH_TEST_CODEX,scope:'w-first,w-second'});
    helper('validate',request);
    helper('apply',request);
    if (process.env.CASEGRAPH_TEST_CODEX) {
      const config = fs.readFileSync(path.join(env.CODEX_HOME,'config.toml'),'utf8');
      assert.ok(config.includes('[mcp_servers.detective-wall]') && config.includes('casegraph-mcp.exe') && config.includes('w-first,w-second') && config.includes('WALL_DB'));
      console.log('PASS actual Codex CLI writes the selected MCP connection into an isolated profile');
    }
    const root=path.join(install,'data');
    const settings=JSON.parse(fs.readFileSync(path.join(root,'settings.json'),'utf8'));
    assert.equal(path.resolve(settings.activeProjectFolder),path.join(root,'projects','default'));
    console.log('PASS installer helper creates selected paths, settings, and SQLite before first launch');
    child=spawn(exe,[],{env:{...env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${debug}`},windowsHide:true,stdio:'ignore'});
    child.on('error',error=>{throw error;});
    await until(async()=> (await fetch(`http://127.0.0.1:${debug}/json/version`)).ok,'WebView2 endpoint');
    browser=await chromium.connectOverCDP(`http://127.0.0.1:${debug}`);
    page=await until(()=>browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith(`http://127.0.0.1:${port}`)),'whiteboard');
    await page.waitForFunction(()=>window.wallReady === true);
    const state=await page.evaluate(()=>window.caseGraph.getState());
    assert.equal(path.resolve(state.settingsPath),path.join(root,'settings.json'));
    assert.equal(state.configuredPort,port);
    assert.deepEqual(await page.evaluate(()=>({theme:document.documentElement.dataset.theme,style:document.documentElement.dataset.cardStyle,mascot:mascotVisible,motion:reduceMotion})),{theme:'moon',style:'tech',mascot:false,motion:true});
    assert.equal(await page.evaluate(()=>store.getMeta('aiProposals')),true);
    await page.screenshot({path:path.join(run,'installed-appearance.png')});
    console.log('PASS installed executable uses its locator and applies installer appearance and AI choices');
    await page.evaluate(()=>setTheme('cork'));
    await page.reload();
    await page.waitForFunction(()=>window.wallReady === true);
    assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),'cork');
    await page.evaluate(async()=>{
      const state=await window.caseGraph.getState();
      await window.caseGraph.saveSettings({port:state.configuredPort,activeProjectFolder:state.activeProjectFolder,aiWorkdir:null});
    });
    const saved=JSON.parse(fs.readFileSync(path.join(root,'settings.json'),'utf8'));
    assert.deepEqual(saved.appearance,settings.appearance);
    assert.deepEqual(saved.cliPaths,settings.cliPaths);
    console.log('PASS later user preferences survive reload and launcher settings retain installation options');
  } finally {
    if(page) await page.evaluate(()=>window.caseGraph.service('stop')).catch(()=>{});
    if(browser) await browser.close().catch(()=>{});
    if(child && child.exitCode===null) {child.kill(); await new Promise(resolve=>child.once('exit',resolve));}
    console.log('Artifacts: '+run);
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
