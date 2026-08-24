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
    await new Promise((r) => setTimeout(r, 250));
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
  if (!args.vrm || !args.clip || !args.profile) {
    console.error('Usage: node tools/render_authored_cli.mjs --vrm file.vrm --clip clip.json --profile character.json [--out dir] [--view front] [--size 512] [--cycles 1] [--fps 30] [--name result]');
    process.exit(2);
  }

  const vrmPath = path.resolve(args.vrm);
  const clipPath = path.resolve(args.clip);
  const profilePath = path.resolve(args.profile);
  const outDir = path.resolve(args.out || path.join(STUDIO_DIR, 'v3_authored_output'));
  const view = args.view || 'front';
  const size = Number(args.size || 512);
  const cycles = Math.max(1, Number(args.cycles || 1));
  const fps = args.fps ? Number(args.fps) : undefined;
  const port = Number(args.port || 8765);
  const outputName = args.name || `${path.basename(profilePath, '.json')}_${path.basename(clipPath, '.json')}_${view}`;
  const preRollFrames = Number(args['pre-roll'] ?? 12);

  const clip = JSON.parse(await readFile(clipPath, 'utf8'));
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));

  let serverProc = null;
  if (!(await portOpen(port))) {
    serverProc = spawn('python3', ['launch.py'], { cwd: STUDIO_DIR, stdio: 'ignore', detached: true });
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
    await page.goto(`http://127.0.0.1:${port}/index_v3.html`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes('Pret'), undefined, { timeout: 30000 });

    console.log(`VRM: ${vrmPath}`);
    await page.setInputFiles('#vrmInput', vrmPath);
    await page.waitForFunction(() => document.getElementById('vrmInfo')?.textContent?.includes('Bones essentiels'), undefined, { timeout: 30000 });
    console.log('  ' + (await page.textContent('#vrmInfo')));

    // Clear OPFS to prevent a previous run from being extracted together with this one.
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      for await (const [name] of root.entries()) await root.removeEntry(name, { recursive: true });
    });

    console.log(`Clip: ${clip.name || path.basename(clipPath)}`);
    console.log(`Profile: ${profile.name || path.basename(profilePath)}`);
    console.log(`Render: view=${view}, size=${size}, cycles=${cycles}, fps=${fps || clip.fps || 30}`);

    const manifest = await page.evaluate(async ({ clip, profile, options }) => {
      if (typeof window.__renderAuthoredClip !== 'function') throw new Error('__renderAuthoredClip is not available. Did you run v3/build_v3.py?');
      return window.__renderAuthoredClip(clip, profile, options);
    }, {
      clip,
      profile,
      options: { view, size, cycles, fps, outputName, preRollFrames },
    });

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

    console.log(`Wrote ${files.length} files to ${outDir}`);
    console.log('RESULT_JSON:' + JSON.stringify({ outDir, outputName, manifest, fileCount: files.length }));
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
