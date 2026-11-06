// Exercise the real NSIS uninstall check against two isolated, connected MCPs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {Client} = require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport} = require('@modelcontextprotocol/sdk/client/stdio.js');
const base = path.join(__dirname, 'target', 'installer-checks');
fs.mkdirSync(base, {recursive:true});
const run = fs.mkdtempSync(path.join(base, 'mcp-uninstall-'));
const release = process.env.CASEGRAPH_RELEASE_DIR || path.join(__dirname,'target','installer-build','release');
const nsis = path.join(process.env.LOCALAPPDATA,'tauri','NSIS');
const includes = path.join(release,'nsis','x64');
const install = path.join(run, '安裝 路徑');
const other = path.join(run, 'other');
const clients=[];
async function connect(folder) {
  fs.mkdirSync(folder);
  fs.copyFileSync(path.join(release,'casegraph-mcp.exe'),path.join(folder,'casegraph-mcp.exe'));
  const setupEnv={...process.env,APPDATA:path.join(folder,'AppData')};
  delete setupEnv.CASEGRAPH_USER_DATA;
  const request=path.join(folder,'request.ini');
  for(const args of [['inspect',folder,request],['apply',request]]) {
    const result=spawnSync(path.join(release,'casegraph.exe'),['--installer',...args],{env:setupEnv,windowsHide:true,encoding:'utf8',timeout:30000});
    assert.ifError(result.error); assert.equal(result.status,0,result.stderr);
  }
  const transport = new StdioClientTransport({command:path.join(folder,'casegraph-mcp.exe'),args:[],env:{...process.env,WALL_DB:path.join(folder,'data','projects','default','wall.db'),WALL_PORT:'31415'},stderr:'pipe'});
  const client = new Client({name:'installer-mcp-test',version:'1.0.0'});
  clients.push(client);
  transport.stderr?.on('data',chunk=>process.stderr.write(chunk));
  await client.connect(transport);
  return client;
}
function execute(command,args) {
  const result=spawnSync(command,args,{encoding:'utf8',windowsHide:true,timeout:60000});
  assert.ifError(result.error);
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  return result;
}
(async()=>{
  try {
    await connect(install);
    const control=await connect(other);
    const macro = path.join(__dirname,'installer-mcp.nsh');
    fs.writeFileSync(path.join(run,'test.nsi'), `\uFEFFUnicode true
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
!include MUI2.nsh
!include LogicLib.nsh
!include "Win\\RestartManager.nsh"
!include "${macro}"
!addplugindir "${nsis}\\Plugins\\x86-unicode\\additional"
UninstPage instfiles
!insertmacro MUI_LANGUAGE "TradChinese"
!include "${includes}\\TradChinese.nsh"
Var PassiveMode
Name "CaseGraph isolated uninstall regression"
OutFile "${run}\\test.exe"
Section
  WriteUninstaller "${install}\\uninstall.exe"
SectionEnd
Section Uninstall
  !insertmacro CGStopMcp "$INSTDIR"
  Delete "$INSTDIR\\casegraph-mcp.exe"
  IfFileExists "$INSTDIR\\casegraph-mcp.exe" 0 +3
    SetErrorLevel 9
    Quit
  FileOpen $0 "$INSTDIR\\removed.txt" w
  FileWrite $0 "removed"
  FileClose $0
SectionEnd
`, 'utf8');
    execute(path.join(nsis,'makensis.exe'),['/V2',path.join(run,'test.nsi')]);
    execute(path.join(run,'test.exe'),[]);
    // NSIS requires the final _?= path unquoted, including spaces.
    const runUninstall=()=>spawnSync(path.join(install,'uninstall.exe'),['/S',`_?=${install}`],{encoding:'utf8',windowsHide:true,windowsVerbatimArguments:true,timeout:60000});
    const uninstall=runUninstall();
    assert.ifError(uninstall.error);
    assert.ok(fs.existsSync(path.join(install,'removed.txt')),`uninstall did not remove active MCP (exit ${uninstall.status}): ${uninstall.stdout} ${uninstall.stderr}`);
    assert.equal(fs.existsSync(path.join(install,'casegraph-mcp.exe')),false);
    await control.listTools();
    assert.ok(fs.existsSync(path.join(install,'data','projects','default','wall.db')));
    console.log('PASS real NSIS uninstall stops only its installed MCP, removes the unlocked executable, and retains the database');
    console.log('PASS another installation with the same MCP executable name remains connected');
    const noMcp=runUninstall();
    assert.ifError(noMcp.error); assert.equal(noMcp.status,0);
    await control.listTools();
    console.log('PASS uninstall also succeeds when its MCP has already exited');
  } finally {
    await Promise.all(clients.map(client=>client.close().catch(()=>{})));
    console.log('Artifacts: '+run);
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
