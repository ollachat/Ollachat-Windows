import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const testsDir = path.join(rootDir, 'tests');

const testFiles = fs.readdirSync(testsDir)
  .filter(file => file.endsWith('.test.js'))
  .sort()
  .map(file => path.join('tests', file));

if (testFiles.length === 0) {
  console.error('No test files found in tests directory');
  process.exit(1);
}

const child = spawn(process.execPath, ['--test', ...testFiles], {
  cwd: rootDir,
  stdio: 'inherit'
});

child.on('error', (err) => {
  console.error('Failed to start test runner:', err);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
