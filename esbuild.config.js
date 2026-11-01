import * as esbuild from 'esbuild';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = process.argv.includes('--dev');

async function copyRendererAssets() {
  const srcDir = path.join(__dirname, 'src', 'renderer');
  const destDir = path.join(__dirname, 'dist', 'renderer');

  await fs.mkdir(destDir, { recursive: true });

  const assets = ['index.html', 'styles.css', 'floating-call.html'];
  for (const asset of assets) {
    const src = path.join(srcDir, asset);
    const dest = path.join(destDir, asset);
    try {
      await fs.copyFile(src, dest);
    } catch {
      // File may not exist during early setup
    }
  }
}

async function buildAll() {
  await copyRendererAssets();

  // 1. Main Process (CJS, Node platform, external electron)
  await fs.mkdir(path.join(__dirname, 'dist', 'main'), { recursive: true });
  await fs.writeFile(path.join(__dirname, 'dist', 'main', 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2));
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'src', 'main', 'main.js')],
    outfile: path.join(__dirname, 'dist', 'main', 'main.js'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron', 'undici', 'sqlite3'],
    sourcemap: isDev ? 'inline' : false,
    minify: !isDev,
    logLevel: 'info'
  });

  // 2. Preload Script (CJS output for Electron preload context compatibility)
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'src', 'preload', 'preload.js')],
    outfile: path.join(__dirname, 'dist', 'preload', 'preload.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron'],
    sourcemap: isDev ? 'inline' : false,
    minify: !isDev,
    logLevel: 'info'
  });

  // 3. Renderer Scripts (ESM, Browser platform)
  await esbuild.build({
    entryPoints: [
      path.join(__dirname, 'src', 'renderer', 'app.js'),
      path.join(__dirname, 'src', 'renderer', 'floating-call.js')
    ],
    outdir: path.join(__dirname, 'dist', 'renderer'),
    bundle: true,
    platform: 'browser',
    target: 'chrome130',
    format: 'esm',
    sourcemap: isDev ? 'inline' : false,
    minify: !isDev,
    logLevel: 'info'
  });
}

try {
  await buildAll();
  console.log('[esbuild] Build completed successfully.');
} catch (err) {
  console.error('[esbuild] Build failed:', err);
  process.exit(1);
}
