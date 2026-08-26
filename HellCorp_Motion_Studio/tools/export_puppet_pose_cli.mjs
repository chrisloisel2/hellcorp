#!/usr/bin/env node
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
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
  try { return await chromium.launch({ channel: 'chrome', headless: true }); }
  catch { return chromium.launch({ headless: true }); }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.vrm || !args.fbx || !args.out) {
    console.error('Usage: node tools/export_puppet_pose_cli.mjs --vrm file.vrm --fbx animation.fbx --out pose.json [--view front] [--samples 16] [--root-mode detrend] [--clip 0] [--start 0] [--end sec] [--mirror-x]');
    process.exit(2);
  }

  const vrmPath = path.resolve(args.vrm);
  const fbxPath = path.resolve(args.fbx);
  const outPath = path.resolve(args.out);
  const view = args.view || 'front';
  const samples = Math.max(2, Number(args.samples || 16));
  const rootMode = args['root-mode'] || 'detrend';
  const clipSelector = args.clip ?? null;
  const start = args.start == null ? 0 : Number(args.start);
  const end = args.end == null ? null : Number(args.end);
  const mirrorX = Boolean(args['mirror-x']);
  const port = Number(args.port || 8765);

  let serverProc = null;
  if (!(await portOpen(port))) {
    serverProc = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: STUDIO_DIR, stdio: 'ignore', detached: true });
    if (!(await waitForPort(port))) throw new Error(`Local server did not start on port ${port}.`);
  }

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  page.setDefaultTimeout(300000);
  page.on('console', (msg) => { if (msg.type() === 'error') console.error('[browser]', msg.text()); });
  page.on('pageerror', (error) => console.error('[pageerror]', error.stack || error.message));

  try {
    await page.goto(`http://127.0.0.1:${port}/puppet2d/pose_export.html`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__puppetPose && document.getElementById('status')?.textContent === 'Ready');

    console.log(`VRM: ${vrmPath}`);
    await page.setInputFiles('#vrmInput', vrmPath);
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'VRM ready');

    console.log(`FBX: ${fbxPath}`);
    await page.setInputFiles('#fbxInput', fbxPath);
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'Mixamo animation ready');

    if (rootMode !== 'detrend' || clipSelector != null) {
      await page.evaluate(async ({ rootMode, clipSelector }) => {
        const file = document.getElementById('fbxInput').files[0];
        return window.__puppetPose.loadFbxFile(file, { rootMode, clip: clipSelector });
      }, { rootMode, clipSelector });
    }

    const state = await page.evaluate(() => window.__puppetPose.getState());
    console.log('Retarget diagnostics:');
    console.log(JSON.stringify(state.diagnostics, null, 2));

    const pose = await page.evaluate(async ({ view, samples, start, end, mirrorX }) => {
      return window.__puppetPose.exportPoseClip({ view, samples, start, end, mirrorX });
    }, { view, samples, start, end, mirrorX });

    if (pose?.validation?.status !== 'PASS') throw new Error(`Pose export validation returned ${pose?.validation?.status || 'UNKNOWN'}.`);

    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(pose, null, 2) + '\n', 'utf8');
    console.log(`Pose clip -> ${outPath}`);
    console.log('RESULT_JSON:' + JSON.stringify({ outPath, samples: pose.samples, view: pose.view, validation: pose.validation }));
  } finally {
    await browser.close();
    if (serverProc) { try { process.kill(-serverProc.pid); } catch {} }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
