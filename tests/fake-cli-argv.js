// Stands in for an npm-installed CLI: records the argv and cwd it received, then exits.
const fs = require('node:fs');

fs.writeFileSync(process.env.CASEGRAPH_FAKE_CLI_LOG, JSON.stringify({argv: process.argv.slice(2), cwd: process.cwd()}));
