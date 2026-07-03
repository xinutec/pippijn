#!/usr/bin/env node
// Local preview for iterating on scenes/house.json — the 3D house model.
//
// Serves the dev (no-SW) frontend build, fakes /api/me (so the app shows
// logged-in) and serves /api/house by reading scenes/house.json FRESH every
// request — so editing the scene + reloading shows the change instantly. No DB,
// no backend, no auth. Everything else under /api returns [] (the House tab
// ignores it).
//
//   1. Build the dev frontend once:  (cd frontend && npm run build)   # dev config, no SW
//   2. node scripts/house-preview.mjs [port]                          # default 4280
//   3. Open http://<this-machine>:<port>/house                        # LAN-reachable → phone
//
// Red-estimate convention while measuring collaboratively: give a *guessed*
// furniture box "color": "#ff5252" (bright red) and swap it to the real colour
// once measured. `?red=14,5` on /house tints those WALLS (global index) red too.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize, dirname } from 'node:path';

const LIFE = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(LIFE, 'frontend/dist/life-web/browser');
const SCENE = join(LIFE, 'scenes/house.json');
const PORT = Number(process.argv[2] ?? 4280);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};
const noStore = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0];

  if (path === '/api/me') {
    res.writeHead(200, noStore);
    return res.end(JSON.stringify({ userId: 'pippijn', displayName: 'Pippijn', avatarUrl: '', nextcloud: 'not_linked' }));
  }
  if (path === '/api/house') {
    try {
      res.writeHead(200, noStore);
      return res.end(await readFile(SCENE, 'utf8')); // fresh every time
    } catch {
      res.writeHead(500, noStore);
      return res.end('{"error":"scene read failed"}');
    }
  }
  if (path.startsWith('/api/')) {
    res.writeHead(200, noStore);
    return res.end('[]'); // items/locations/recipes/etc: empty, the House tab ignores them
  }

  // static frontend; SPA fallback ONLY for extensionless (navigation) paths —
  // a missing .js/.css must 404, not return index.html (which would execute as
  // broken JS and silently fail a lazy route).
  const clean = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, '');
  let file = join(DIST, clean);
  let ok = true;
  try {
    ok = (await stat(file)).isFile();
  } catch {
    ok = false;
  }
  if (!ok) {
    if (extname(clean)) {
      console.log(`404 ${path}`);
      res.writeHead(404).end('not found');
      return;
    }
    file = join(DIST, 'index.html'); // navigation route → SPA shell
  }
  try {
    const body = await readFile(file);
    console.log(`200 ${path}`);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    console.log(`404 ${path}`);
    res.writeHead(404).end('not found');
  }
}).listen(PORT, () => console.log(`house preview → http://localhost:${PORT}  (scene: ${SCENE})`));
