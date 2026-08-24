#!/usr/bin/env node
// CLI headless pour HellCorp Motion Studio.
// Pilote l'app reelle (Three.js/three-vrm/MediaPipe) dans Chrome via Playwright :
// aucune interaction manuelle requise. showDirectoryPicker() est remplace par
// l'Origin Private File System (meme interface FileSystemDirectoryHandle que
// l'app utilise deja pour ecrire les PNG/JSON), ce qui rend le rendu
// automatisable en headless sans dialogue OS. Les fichiers sont ensuite
// extraits de l'OPFS vers le disque reel.

import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile, copyFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

async function folderWithSingleFile(filePath, tag) {
  const dir = await mkdtemp(path.join(os.tmpdir(), `hcms-${tag}-`));
  const dest = path.join(dir, path.basename(filePath));
  await copyFile(filePath, dest);
  return dir;
}

const STUDIO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { args[key] = true; }
      else { args[key] = next; i++; }
    }
  }
  return args;
}

function portOpen(port) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host: '127.0.0.1' });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
  });
}

async function waitForPort(port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await portOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.vrm || !args.body) {
    console.error('Usage: node render_cli.mjs --vrm <fichier.vrm> --body <video.mp4> [--face <video.mp4>] [--out <dossier>] [--fps-mode body|max|custom] [--custom-fps N] [--size 512] [--views front,threequarter,side,back] [--port 8765]');
    process.exit(1);
  }

  const vrm = path.resolve(args.vrm);
  const body = path.resolve(args.body);
  const face = args.face ? path.resolve(args.face) : null;
  const outDir = path.resolve(args.out || path.join(STUDIO_DIR, 'cli_output'));
  const fpsMode = args['fps-mode'] || 'body';
  const port = Number(args.port || 8765);
  const size = String(args.size || '512');
  const views = (args.views || 'front,threequarter,side,back').split(',').map((v) => v.trim()).filter(Boolean);

  let serverProc = null;
  const alreadyUp = await portOpen(port);
  if (!alreadyUp) {
    console.log(`Demarrage du serveur local (port ${port})...`);
    serverProc = spawn('python3', ['launch.py'], { cwd: STUDIO_DIR, stdio: 'ignore', detached: true });
    const ok = await waitForPort(port, 15000);
    if (!ok) throw new Error(`Le serveur local n a pas demarre sur le port ${port}.`);
  } else {
    console.log(`Serveur deja actif sur le port ${port}, reutilisation.`);
  }

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  page.on('console', (m) => { if (m.type() === 'error') console.error('[navigateur]', m.text()); });
  page.on('pageerror', (e) => console.error('[erreur page]', e.message));

  await page.addInitScript(() => {
    window.showDirectoryPicker = async () => navigator.storage.getDirectory();
  });

  let bodyDirCleanup = null;
  let faceDirCleanup = null;
  try {
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes('Pret'), undefined, { timeout: 20000 });

    console.log(`Chargement VRM: ${path.basename(vrm)}`);
    await page.setInputFiles('#vrmInput', vrm);
    await page.waitForFunction(
      () => document.getElementById('vrmInfo')?.textContent?.includes('Bones essentiels'), undefined,
      { timeout: 30000 },
    );
    console.log('  ' + (await page.textContent('#vrmInfo')));

    console.log(`Chargement video body: ${path.basename(body)}`);
    const bodyDir = await folderWithSingleFile(body, 'body');
    bodyDirCleanup = bodyDir;
    await page.setInputFiles('#bodyFolder', bodyDir);
    await page.waitForFunction(() => document.getElementById('bodySelect').options.length > 0, undefined, { timeout: 10000 });

    if (face) {
      console.log(`Chargement video face: ${path.basename(face)}`);
      const faceDir = await folderWithSingleFile(face, 'face');
      faceDirCleanup = faceDir;
      await page.setInputFiles('#faceFolder', faceDir);
      await page.waitForFunction(() => document.getElementById('faceSelect').options.length > 1, undefined, { timeout: 10000 });
    }

    await page.selectOption('#bodySelect', '0');
    if (face) await page.selectOption('#faceSelect', '0');
    await page.selectOption('#outputFpsMode', fpsMode);
    if (fpsMode === 'custom' && args['custom-fps']) {
      await page.fill('#customFps', String(args['custom-fps']));
    }
    await page.selectOption('#sizeSelect', size);

    await page.$$eval('.viewExport', (boxes, wanted) => {
      boxes.forEach((b) => { b.checked = wanted.includes(b.value); });
    }, views);

    async function waitForLogMarkers(markers, timeout) {
      const sincePos = (await page.textContent('#log')).length;
      await page.waitForFunction(
        ({ markers, sincePos }) => {
          const text = document.getElementById('log').textContent;
          const tail = text.slice(sincePos);
          return markers.some((m) => tail.includes(m)) || tail.includes('ERREUR:');
        },
        { markers, sincePos },
        { timeout, polling: 250 },
      );
    }

    console.log('Analyse du clip (tracking pose + face)...');
    await page.click('#analyzeBtn');
    await waitForLogMarkers(['Clip pret:'], 240000);
    if ((await page.textContent('#status')) === 'Erreur') {
      const tail = (await page.textContent('#log')).trim().split('\n').slice(-6).join('\n');
      throw new Error(`Analyse echouee.\n${tail}`);
    }
    console.log('Analyse OK.');

    console.log('Rendu des sprites (OPFS)...');
    await page.click('#renderBtn');
    await waitForLogMarkers(['EXPORT termine:'], 300000);
    if ((await page.textContent('#status')) === 'Erreur') {
      const tail = (await page.textContent('#log')).trim().split('\n').slice(-6).join('\n');
      throw new Error(`Rendu echoue.\n${tail}`);
    }
    console.log('Rendu termine. Extraction OPFS -> disque...');

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
      async function walk(dir, prefix) {
        const out = [];
        for await (const [name, handle] of dir.entries()) {
          const p = prefix ? `${prefix}/${name}` : name;
          if (handle.kind === 'file') {
            const f = await handle.getFile();
            out.push({ path: p, data: toB64(await f.arrayBuffer()) });
          } else {
            out.push(...(await walk(handle, p)));
          }
        }
        return out;
      }
      const root = await navigator.storage.getDirectory();
      return walk(root, '');
    });

    await mkdir(outDir, { recursive: true });
    for (const f of files) {
      const dest = path.join(outDir, f.path);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, Buffer.from(f.data, 'base64'));
    }
    console.log(`${files.length} fichiers ecrits dans ${outDir}`);

    let videoPaths = [];
    if (args.video) {
      const clipJsonFile = files.find((f) => f.path.endsWith('clip.json'));
      if (clipJsonFile) {
        const clipDir = path.join(outDir, path.dirname(clipJsonFile.path));
        const clip = JSON.parse(Buffer.from(clipJsonFile.data, 'base64').toString('utf8'));
        for (const view of views) {
          const framesDir = path.join(clipDir, view, 'frames');
          const videoOut = path.join(clipDir, view, 'preview.mp4');
          const r = spawnSync('ffmpeg', [
            '-y', '-framerate', String(clip.fps), '-i', path.join(framesDir, 'frame_%06d.png'),
            '-vf', 'format=yuv420p', '-c:v', 'libx264', '-crf', '18', videoOut,
          ], { stdio: 'ignore' });
          if (r.status === 0) { videoPaths.push(videoOut); console.log(`Video: ${videoOut}`); }
          else console.error(`ffmpeg a echoue pour la vue ${view} (code ${r.status}). ffmpeg est-il installe ?`);
        }
      }
    }

    console.log('RESULT_JSON:' + JSON.stringify({ outDir, fileCount: files.length, views, fpsMode, videoPaths }));
  } finally {
    await browser.close();
    if (serverProc) { try { process.kill(-serverProc.pid); } catch {} }
    if (bodyDirCleanup) await rm(bodyDirCleanup, { recursive: true, force: true }).catch(() => {});
    if (faceDirCleanup) await rm(faceDirCleanup, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
