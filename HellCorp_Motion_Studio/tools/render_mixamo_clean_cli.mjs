#!/usr/bin/env node
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const STUDIO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function portOpen(port) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
  });
}

async function waitForPort(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await portOpen(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function launchBrowser() {
  try {
    return await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    return chromium.launch({ headless: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.vrm || !args.fbx) {
    console.error('Usage: node tools/render_mixamo_clean_cli.mjs --vrm file.vrm --fbx animation.fbx [--out dir] [--view front] [--size 768] [--fps 30] [--root-mode preserve] [--clip 0] [--start 0] [--end sec] [--name output]');
    process.exit(2);
  }

  const vrmPath = path.resolve(args.vrm);
  const fbxPath = path.resolve(args.fbx);
  const outDir = path.resolve(args.out || path.join(STUDIO_DIR, 'mixamo_clean_output'));
  const view = args.view || 'front';
  const size = Math.max(128, Number(args.size || 768));
  const fps = Math.max(1, Number(args.fps || 30));
  const rootMode = args['root-mode'] || 'preserve';
  const clipSelector = args.clip ?? null;
  const start = args.start == null ? 0 : Number(args.start);
  const end = args.end == null ? null : Number(args.end);
  const port = Number(args.port || 8765);
  const defaultName = `${path.basename(vrmPath, path.extname(vrmPath))}_${path.basename(fbxPath, path.extname(fbxPath))}_${view}`;
  const outputName = args.name || defaultName;

  let serverProc = null;
  if (!(await portOpen(port))) {
    serverProc = spawn(
      'python3',
      ['-m', 'http.server', String(port), '--bind', '127.0.0.1'],
      { cwd: STUDIO_DIR, stdio: 'ignore', detached: true },
    );
    if (!(await waitForPort(port))) throw new Error(`Local server did not start on port ${port}.`);
  }

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.setDefaultTimeout(300000);
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('[browser]', msg.text());
  });
  page.on('pageerror', (error) => console.error('[pageerror]', error.stack || error.message));

  await page.addInitScript(() => {
    window.showDirectoryPicker = async () => navigator.storage.getDirectory();
  });

  try {
    await page.goto(`http://127.0.0.1:${port}/mixamo_clean/index.html`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__mixamoClean && document.getElementById('status')?.textContent === 'Ready');

    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      for await (const [name] of root.entries()) await root.removeEntry(name, { recursive: true });
    });

    console.log(`VRM: ${vrmPath}`);
    await page.setInputFiles('#vrmInput', vrmPath);
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'VRM ready');

    console.log(`FBX: ${fbxPath}`);
    await page.setInputFiles('#fbxInput', fbxPath);
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'Mixamo animation ready');

    if (rootMode !== 'preserve' || clipSelector != null) {
      await page.evaluate(async ({ rootMode, clipSelector, view }) => {
        const file = document.getElementById('fbxInput').files[0];
        return window.__mixamoClean.loadFbxFile(file, { rootMode, clip: clipSelector, view });
      }, { rootMode, clipSelector, view });
    }

    const state = await page.evaluate(() => window.__mixamoClean.getState());
    console.log('Retarget diagnostics:');
    console.log(JSON.stringify(state.diagnostics, null, 2));

    if (!state.diagnostics || state.diagnostics.coreCoverage < 0.90) {
      throw new Error(`Strict retarget validation failed: coreCoverage=${state.diagnostics?.coreCoverage}`);
    }

    const manifest = await page.evaluate(async ({ view, size, fps, start, end, outputName }) => {
      return window.__mixamoClean.renderAnimation({ view, size, fps, start, end, name: outputName });
    }, { view, size, fps, start, end, outputName });

    if (manifest?.validation?.status !== 'PASS') {
      throw new Error(`Render validation returned ${manifest?.validation?.status || 'UNKNOWN'}.`);
    }

    const files = await page.evaluate(async () => {
      function toB64(buf) {
        const bytes = new Uint8Array(buf);
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
      }
      async function walk(dir, prefix = '') {
        const out = [];
        for await (const [name, handle] of dir.entries()) {
          const rel = prefix ? `${prefix}/${name}` : name;
          if (handle.kind === 'file') {
            const file = await handle.getFile();
            out.push({ path: rel, data: toB64(await file.arrayBuffer()) });
          } else {
            out.push(...await walk(handle, rel));
          }
        }
        return out;
      }
      return walk(await navigator.storage.getDirectory());
    });

    await mkdir(outDir, { recursive: true });
    await rm(path.join(outDir, outputName), { recursive: true, force: true });
    for (const file of files) {
      const dest = path.join(outDir, file.path);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, Buffer.from(file.data, 'base64'));
    }

    console.log(`Wrote ${files.length} files to ${outDir}`);
    console.log('RESULT_JSON:' + JSON.stringify({ outDir, outputName, manifest, fileCount: files.length }));
  } finally {
    await browser.close();
    if (serverProc) {
      try { process.kill(-serverProc.pid); } catch {}
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
