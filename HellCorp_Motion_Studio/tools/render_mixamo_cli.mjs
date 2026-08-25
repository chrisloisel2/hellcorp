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
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await portOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 200));
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

async function extractOpfs(page, outDir) {
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
  for (const file of files) {
    const dest = path.join(outDir, file.path);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, Buffer.from(file.data, 'base64'));
  }
  return files.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.vrm || !args.fbx) {
    console.error(
      'Usage: node tools/render_mixamo_cli.mjs --vrm character.vrm --fbx animation.fbx ' +
      '[--clip 0] [--out dir] [--view front] [--size 768] [--fps 30] [--root-mode inplace]'
    );
    process.exit(2);
  }

  const vrmPath = path.resolve(args.vrm);
  const fbxPath = path.resolve(args.fbx);
  const outDir = path.resolve(args.out || path.join(STUDIO_DIR, 'v5_mixamo_output'));
  const view = args.view || 'front';
  const size = Number(args.size || 768);
  const fps = Number(args.fps || 30);
  const port = Number(args.port || 8765);
  const clipSelector = args.clip ?? 0;
  const rootMode = args['root-mode'] || 'inplace';
  const rotationStrength = Number(args['rotation-strength'] ?? 1.0);
  const rootStrength = Number(args['root-strength'] ?? 1.0);
  const preRollFrames = Number(args['pre-roll'] ?? Math.round(fps * 0.5));
  const start = args.start == null ? undefined : Number(args.start);
  const end = args.end == null ? undefined : Number(args.end);
  const outputName = args.name || `${path.basename(vrmPath, '.vrm')}_${path.basename(fbxPath, '.fbx')}_${view}`;

  let serverProc = null;
  if (!(await portOpen(port))) {
    serverProc = spawn('python3', ['launch.py'], {
      cwd: STUDIO_DIR,
      stdio: 'ignore',
      detached: true,
    });
    if (!(await waitForPort(port))) throw new Error(`Local server did not start on port ${port}`);
  }

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  page.setDefaultTimeout(300000);
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('[browser]', m.text());
  });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));

  await page.addInitScript(() => {
    window.showDirectoryPicker = async () => navigator.storage.getDirectory();
  });

  try {
    await page.goto(`http://127.0.0.1:${port}/index_v5.html`, { waitUntil: 'networkidle' });
    await page.waitForFunction(
      () => document.getElementById('status')?.textContent?.includes('Pret'),
      undefined,
      { timeout: 30000 },
    );

    console.log(`VRM: ${vrmPath}`);
    await page.setInputFiles('#vrmInput', vrmPath);
    await page.waitForFunction(
      () => document.getElementById('vrmInfo')?.textContent?.includes('Bones essentiels'),
      undefined,
      { timeout: 30000 },
    );

    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      for await (const [name] of root.entries()) {
        await root.removeEntry(name, { recursive: true });
      }
    });

    console.log(`FBX: ${fbxPath}`);
    await page.setInputFiles('#mixamoFbxInput', fbxPath);
    const fbxSummary = await page.evaluate(async () => {
      if (typeof window.__loadMixamoFbxFromInput !== 'function') {
        throw new Error('__loadMixamoFbxFromInput is unavailable. Run v5/build_v5.py.');
      }
      return window.__loadMixamoFbxFromInput();
    });

    console.log('FBX clips:');
    for (const clip of fbxSummary.clips || []) {
      console.log(`  [${clip.index}] ${clip.name} duration=${clip.duration.toFixed(3)}s tracks=${clip.tracks}`);
    }

    const options = {
      view,
      size,
      fps,
      clipSelector,
      rootMode,
      rotationStrength,
      rootStrength,
      preRollFrames,
      outputName,
    };
    if (start !== undefined) options.start = start;
    if (end !== undefined) options.end = end;

    console.log(
      `Render: clip=${clipSelector}, view=${view}, size=${size}, fps=${fps}, ` +
      `root=${rootMode}, rotationStrength=${rotationStrength}`
    );

    const manifest = await page.evaluate(async (opts) => {
      if (typeof window.__renderMixamoClip !== 'function') {
        throw new Error('__renderMixamoClip is unavailable. Run v5/build_v5.py.');
      }
      return window.__renderMixamoClip(opts);
    }, options);

    const fileCount = await extractOpfs(page, outDir);
    console.log(`Wrote ${fileCount} files to ${outDir}`);
    console.log('RESULT_JSON:' + JSON.stringify({
      outDir,
      outputName,
      manifest,
      fbxSummary,
      fileCount,
    }));
  } finally {
    await browser.close();
    if (serverProc) {
      try { process.kill(-serverProc.pid); } catch {}
    }
  }
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
