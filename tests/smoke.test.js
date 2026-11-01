import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

test('Smoke Test: package.json is valid and configured for ES modules', () => {
  const pkgPath = path.join(projectRoot, 'package.json');
  assert.ok(fs.existsSync(pkgPath), 'package.json must exist');

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  assert.equal(pkg.type, 'module', 'package.json must have "type": "module"');
  assert.equal(pkg.name, 'ollachat-windows', 'package name must be ollachat-windows');
  assert.ok(pkg.devDependencies.electron, 'electron must be in devDependencies');
  assert.ok(pkg.devDependencies['electron-builder'], 'electron-builder must be in devDependencies');
  assert.ok(pkg.devDependencies.esbuild, 'esbuild must be in devDependencies');
});

test('Smoke Test: electron-builder.yml exists and targets Windows x64 NSIS + Portable', () => {
  const builderConfigPath = path.join(projectRoot, 'electron-builder.yml');
  assert.ok(fs.existsSync(builderConfigPath), 'electron-builder.yml must exist');

  const content = fs.readFileSync(builderConfigPath, 'utf8');
  assert.match(content, /nsis/, 'electron-builder.yml must configure nsis');
  assert.match(content, /portable/, 'electron-builder.yml must configure portable');
  assert.match(content, /x64/, 'electron-builder.yml must configure x64 architecture');
  assert.match(content, /forceCodeSigning:\s*false/, 'Code signing must be explicitly false');
});

test('Smoke Test: source entrypoints exist', () => {
  const mainPath = path.join(projectRoot, 'src', 'main', 'main.js');
  const preloadPath = path.join(projectRoot, 'src', 'preload', 'preload.js');
  const indexPath = path.join(projectRoot, 'src', 'renderer', 'index.html');
  const appPath = path.join(projectRoot, 'src', 'renderer', 'app.js');
  const stylesPath = path.join(projectRoot, 'src', 'renderer', 'styles.css');

  assert.ok(fs.existsSync(mainPath), 'src/main/main.js must exist');
  assert.ok(fs.existsSync(preloadPath), 'src/preload/preload.js must exist');
  assert.ok(fs.existsSync(indexPath), 'src/renderer/index.html must exist');
  assert.ok(fs.existsSync(appPath), 'src/renderer/app.js must exist');
  assert.ok(fs.existsSync(stylesPath), 'src/renderer/styles.css must exist');
});
