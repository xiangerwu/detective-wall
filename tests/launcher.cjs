const assert = require('node:assert/strict');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

if (process.platform !== 'win32') {
  console.log('SKIP launcher self-test requires Windows');
} else {
  const script = path.join(__dirname, '..', 'launcher', 'CaseGraph.ps1');
  // -SelfTest drives the service lifecycle headless; -GuiSmoke runs the real window, timer and health polling off screen.
  for (const [mode, minimum] of [['-SelfTest', 8], ['-GuiSmoke', 3]]) {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', script, mode], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8', env: {...process.env}, windowsHide: true,
    });
    const output = (result.stdout || '') + (result.stderr || '');
    process.stdout.write(output);
    assert.equal(result.status, 0, output);
    const passes = output.split(/\r?\n/).filter(line => line.startsWith('PASS '));
    assert.ok(passes.length >= minimum, `launcher ${mode} should report each check`);
    console.log(`PASS Windows launcher ${mode}`);
  }
}
