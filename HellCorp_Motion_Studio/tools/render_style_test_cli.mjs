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
    console.error('Usage: node tools/render_style_test_cli.mjs --vrm file.vrm --fbx animation.fbx --style style.json [--out dir] [--size 1024] [--fps 16] [--frames 0,10,20] [--name output]');
    process.exit(2);
  }

  const vrmPath = path.resolve(args.vrm);
  const fbxPath = path.resolve(args.fbx);
  const outDir = path.resolve(args.out || path.join(STUDIO_DIR, 'style_test_output'));
  const size = Math.max(128, Number(args.size || 1024));
  const fps = Math.max(1, Number(args.fps || 16));
  const frameIdx = String(args.frames || '0').split(',').map(Number);
  const port = Number(args.port || 8766);
  const outputName = args.name || 'style_test';
  const style = args.style ? JSON.parse(await (await import('node:fs/promises')).readFile(path.resolve(args.style), 'utf8')) : {};

  let serverProc = null;
  if (!(await portOpen(port))) {
    serverProc = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: STUDIO_DIR, stdio: 'ignore', detached: true });
    if (!(await waitForPort(port))) throw new Error(`Local server did not start on port ${port}.`);
  }

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.setDefaultTimeout(300000);
  page.on('console', (msg) => { if (msg.type() === 'error') console.error('[browser]', msg.text()); });
  page.on('pageerror', (error) => console.error('[pageerror]', error.stack || error.message));

  try {
    await page.goto(`http://127.0.0.1:${port}/mixamo_clean/index.html`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__mixamoClean && document.getElementById('status')?.textContent === 'Ready');

    await page.setInputFiles('#vrmInput', vrmPath);
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'VRM ready');

    await page.setInputFiles('#fbxInput', fbxPath);
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'Mixamo animation ready');

    const report = await page.evaluate((style) => window.__applyMToonStyle(style), style);
    console.log('STYLE_APPLY:', JSON.stringify(report));

    if (style.textureSwap) {
      const fsp = await import('node:fs/promises');
      for (const [nameSubstring, texPath] of Object.entries(style.textureSwap)) {
        const buf = await fsp.readFile(path.resolve(texPath));
        const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
        const swapResult = await page.evaluate(
          ({ nameSubstring, dataUrl }) => window.__swapMaterialTexture(nameSubstring, dataUrl),
          { nameSubstring, dataUrl },
        );
        console.log('TEXTURE_SWAP:', nameSubstring, JSON.stringify(swapResult));
      }
    }

    const size3d = size;
    for (const idx of frameIdx) {
      const t = idx / fps;
      const manifest = await page.evaluate(async ({ view, size, fps, t, name }) => {
        return window.__mixamoClean.renderAnimation({ view, size, fps, start: t, end: t + 1 / fps, name: `${name}_f${String(Math.round(t*fps)).padStart(6,'0')}` });
      }, { view: 'front', size: size3d, fps, t, name: outputName });

      const files = await page.evaluate(async (folderName) => {
        function toB64(buf) {
          const bytes = new Uint8Array(buf);
          let binary = '';
          const chunk = 0x8000;
          for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
          return btoa(binary);
        }
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle(folderName);
        const framesDir = await dir.getDirectoryHandle('frames');
        const out = [];
        for await (const [name, handle] of framesDir.entries()) {
          const file = await handle.getFile();
          out.push({ path: name, data: toB64(await file.arrayBuffer()) });
        }
        return out;
      }, manifest.output_name);

      await mkdir(path.join(outDir, outputName), { recursive: true });
      for (const file of files) {
        const dest = path.join(outDir, outputName, `frame_${String(idx).padStart(6, '0')}.png`);
        await writeFile(dest, Buffer.from(file.data, 'base64'));
      }
      console.log(`Wrote frame ${idx} -> ${outDir}/${outputName}`);
    }
  } finally {
    await browser.close();
    if (serverProc) { try { process.kill(-serverProc.pid); } catch {} }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
