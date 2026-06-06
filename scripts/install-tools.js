const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const toolsRoot = path.resolve(__dirname, '..', 'child', 'tools');

if (!fs.existsSync(toolsRoot)) {
  console.error(`Tools directory not found: ${toolsRoot}`);
  process.exit(1);
}

const tools = fs
  .readdirSync(toolsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((toolName) => fs.existsSync(path.join(toolsRoot, toolName, 'package.json')))
  .sort((a, b) => a.localeCompare(b));

if (tools.length === 0) {
  console.log('No tool package.json files found under child/tools.');
  process.exit(0);
}

for (const toolName of tools) {
  const toolPath = path.join(toolsRoot, toolName);
  const displayPath = path.relative(process.cwd(), toolPath);

  console.log(`\n> npm i (${displayPath})`);

  const result = spawnSync('npm', ['i'], {
    cwd: toolPath,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
