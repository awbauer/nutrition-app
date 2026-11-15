import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/** Build id: short git SHA (+ "-dirty" for uncommitted changes) and UTC build time. */
function buildVersion(): string {
  let sha = 'nogit';
  try {
    sha = execSync('git rev-parse --short HEAD').toString().trim();
    if (execSync('git status --porcelain').toString().trim()) sha += '-dirty';
  } catch {}
  return `${sha}.${new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)}`;
}

const VERSION = process.env.APP_VERSION ?? buildVersion();

/**
 * Stamps the build: writes dist/version.json and puts the version into sw.js,
 * so every deploy ships a byte-different service worker and the browser installs it.
 */
function stampVersion(): Plugin {
  let outDir = '';
  return {
    name: 'stamp-version',
    apply: 'build',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      writeFileSync(resolve(outDir, 'version.json'), JSON.stringify({ version: VERSION }) + '\n');
      const sw = resolve(outDir, 'sw.js');
      writeFileSync(sw, readFileSync(sw, 'utf8').replaceAll('__APP_VERSION__', VERSION));
    },
  };
}

export default defineConfig({
  root: 'web',
  plugins: [preact(), tailwindcss(), stampVersion()],
  define: { __APP_VERSION__: JSON.stringify(VERSION) },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  server: { proxy: { '/api': 'http://localhost:8788' } },
});
