// The static server: pages, health check, no path traversal.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let proc;
let base;

before(async () => {
  proc = spawn(process.execPath, ['server.js'], { cwd: dir, env: { ...process.env, HOST: '127.0.0.1', PORT: '0' } });
  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 5000);
    proc.stdout.on('data', (d) => {
      const m = String(d).match(/http:\/\/([\d.]+:\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(`http://${m[1]}`);
      }
    });
  });
});
after(() => proc.kill());

test('serves the game page and the health check', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /Horde Gate/);
  const h = await fetch(`${base}/healthz`);
  assert.equal(h.status, 200);
});

test('404 for missing files, no escaping public/', async () => {
  assert.equal((await fetch(`${base}/nope.js`)).status, 404);
  const r = await fetch(`${base}/..%2fserver.js`);
  assert.ok(r.status === 403 || r.status === 404);
  assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
});
