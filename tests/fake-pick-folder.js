const path = require('node:path');

const mode = process.env.WALL_FAKE_PICK_FOLDER_MODE || 'select';
const selected = process.env.WALL_FAKE_PICK_FOLDER_PATH || path.join(process.cwd(), 'picked-folder');
const delay = Number(process.env.WALL_FAKE_PICK_FOLDER_DELAY_MS || 300);

function finish() {
  if (mode !== 'cancel') process.stdout.write(selected + '\n');
}

if (mode === 'busy') setTimeout(finish, Number.isFinite(delay) && delay > 0 ? delay : 300);
else finish();
