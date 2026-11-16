// Shared test helpers: run server.js on a random port, and a WebSocket client that records messages.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';

const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startServer(env = {}) {
  const proc = spawn(process.execPath, ['server.js'], { cwd: dir, env: { ...process.env, HOST: '127.0.0.1', PORT: '0', ...env } });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 5000);
    proc.stdout.on('data', (d) => {
      const m = String(d).match(/http:\/\/([\d.]+:\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.on('exit', (code) => reject(new Error(`server exited (${code})`)));
  });
  return { base, proc, stop: () => proc.kill() };
}

/** Client that keeps every message; `until(pred)` waits for a matching state, `waitMsg(pred)` for any message. */
export function makeClient(base) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${base}/ws`);
    ws.msgs = [];
    ws.states = [];
    ws.errors = [];
    ws.chats = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      ws.msgs.push(m);
      if (m.t === 'state') ws.states.push(m);
      if (m.t === 'error') ws.errors.push(m);
      if (m.t === 'chat') ws.chats.push(...m.entries);
      ws.onmsg?.(m);
    });
    ws.cmd = (msg) => ws.send(JSON.stringify(msg));
    ws.last = () => ws.states[ws.states.length - 1];
    ws.until = async (pred, ms = 2000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const s = ws.last();
        if (s && pred(s)) return s;
        await sleep(10);
      }
      throw new Error(`timed out; last state: ${JSON.stringify(ws.last())}`);
    };
    ws.waitMsg = async (pred, ms = 2000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const m = ws.msgs.find(pred);
        if (m) return m;
        await sleep(10);
      }
      throw new Error(`timed out waiting for message; got ${JSON.stringify(ws.msgs.slice(-5))}`);
    };
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
