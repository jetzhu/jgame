// Start the STUN server on random ports and check binding responses and request validation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { bindingResponse } from '../server.js';

const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let proc;
let port;
let health;

before(async () => {
  proc = spawn(process.execPath, ['server.js'], { cwd: dir, env: { ...process.env, STUN_PORT: '0', STUN_HOST: '127.0.0.1', STUN_HEALTH_PORT: '0' } });
  await new Promise((resolve, reject) => {
    let out = '';
    proc.stdout.on('data', (d) => {
      out += d;
      const u = out.match(/udp 127\.0\.0\.1:(\d+)/);
      const h = out.match(/127\.0\.0\.1:(\d+)\/healthz/);
      if (u && h) {
        port = Number(u[1]);
        health = Number(h[1]);
        resolve();
      }
    });
    proc.on('exit', (c) => reject(new Error(`exited ${c}`)));
    setTimeout(() => reject(new Error('stun did not start')), 5000);
  });
});
after(() => proc?.kill());

function request(txid = crypto.randomBytes(12)) {
  const b = Buffer.alloc(20);
  b.writeUInt16BE(0x0001, 0);
  b.writeUInt16BE(0, 2);
  b.writeUInt32BE(0x2112a442, 4);
  txid.copy(b, 8);
  return b;
}

function ask(buf, ms = 800) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    const t = setTimeout(() => (s.close(), resolve(null)), ms);
    s.on('message', (m) => {
      clearTimeout(t);
      const local = s.address();
      s.close();
      resolve({ m, local });
    });
    s.send(buf, port, '127.0.0.1');
  });
}

test('answers a binding request with our address (XOR-MAPPED-ADDRESS)', async () => {
  const txid = crypto.randomBytes(12);
  const { m, local } = await ask(request(txid));
  assert.equal(m.readUInt16BE(0), 0x0101);
  assert.deepEqual(m.subarray(8, 20), txid);
  assert.equal(m.readUInt16BE(20), 0x0020);
  const xport = m.readUInt16BE(26) ^ 0x2112;
  const ip = (m.readUInt32BE(28) ^ 0x2112a442) >>> 0;
  assert.equal(xport, local.port);
  assert.equal([ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.'), '127.0.0.1');
});

test('ignores garbage and non-binding messages', async () => {
  assert.equal(await ask(Buffer.from('hello world, not stun!!')), null);
  const wrongType = request();
  wrongType.writeUInt16BE(0x0003, 0); // Allocate (TURN) is not supported
  assert.equal(await ask(wrongType), null);
  assert.equal(bindingResponse(Buffer.alloc(19), { address: '1.2.3.4', port: 1, family: 'IPv4' }), null);
});

test('health endpoint reports counters', async () => {
  const r = await fetch(`http://127.0.0.1:${health}/healthz`);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.ok(j.answered >= 1);
});
