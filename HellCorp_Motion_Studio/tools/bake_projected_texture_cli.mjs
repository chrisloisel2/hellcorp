#!/usr/bin/env node
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.vrm || !args.fbx || !args.reference || !args.align) {
    console.error('Usage: node tools/bake_projected_texture_cli.mjs --vrm f.vrm --fbx f.fbx --reference img.png --align align.json --out dir [--name-filter substr] [--bake-size 1024] [--canvas-size 1024]');
    process.exit(2);
  }

  const vrmPath = path.resolve(args.vrm);
  const fbxPath = path.resolve(args.fbx);
  const refPath = path.resolve(args.reference);
  const align = JSON.parse(await readFile(path.resolve(args.align), 'utf8'));
  const outDir = path.resolve(args.out || path.join(STUDIO_DIR, 'bake_output'));
  const bakeSize = Number(args['bake-size'] || 1024);
  const canvasSize = Number(args['canvas-size'] || 1024);
  const nameFilter = args['name-filter'] || null;
  const port = Number(args.port || 8768);

  await mkdir(outDir, { recursive: true });

  let serverProc = null;
  if (!(await portOpen(port))) {
    serverProc = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: STUDIO_DIR, stdio: 'ignore', detached: true });
    if (!(await waitForPort(port))) throw new Error(`Local server did not start on port ${port}.`);
  }

  const browser = await chromium.launch({ headless: true });
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

    const refBuf = await readFile(refPath);
    const refImageDataUrl = `data:image/png;base64,${refBuf.toString('base64')}`;

    const cullSign = Number(args['cull-sign'] || 1);
    console.log('Baking...');
    const results = await page.evaluate(
      ({ refImageDataUrl, canvasSize, align, bakeSize, nameFilter, cullSign }) =>
        window.__bakeProjectedTexture({ refImageDataUrl, canvasSize, align, bakeSize, nameFilter, cullSign }),
      { refImageDataUrl, canvasSize, align, bakeSize, nameFilter, cullSign },
    );

    for (const [materialName, info] of Object.entries(results)) {
      const b64 = info.dataUrl.split(',')[1];
      const safeName = materialName.replace(/[^a-zA-Z0-9._-]+/g, '_');
      const dest = path.join(outDir, `${safeName}.png`);
      await writeFile(dest, Buffer.from(b64, 'base64'));
      console.log(`${materialName} (mesh: ${info.meshName}) -> ${info.drawn}/${info.triangles} triangles drawn -> ${dest}`);
    }

    await writeFile(path.join(outDir, '_manifest.json'), JSON.stringify(results, (k, v) => (k === 'dataUrl' ? undefined : v), 2));
    console.log('BAKE_DONE');
  } finally {
    await browser.close();
    if (serverProc) { try { process.kill(-serverProc.pid); } catch {} }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
