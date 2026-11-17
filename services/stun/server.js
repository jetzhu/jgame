// Minimal STUN server (RFC 5389 Binding only) so jgame players' browsers learn their public
// address from us instead of a third party. No TURN, no auth, no state.
//
//   UDP  0.0.0.0:3478   STUN binding requests  -> XOR-MAPPED-ADDRESS response
//   HTTP 127.0.0.1:3479 /healthz               -> counters (for deploy health checks)
//
// Abuse limits: only well-formed Binding requests are answered, responses are 32 bytes
// (barely larger than the 20-byte minimum request), per-IP and global rate limits.
import dgram from 'node:dgram';
import http from 'node:http';

const PORT = Number(process.env.STUN_PORT || 3478);
const HOST = process.env.STUN_HOST || '0.0.0.0';
const HEALTH_PORT = Number(process.env.STUN_HEALTH_PORT || 3479);
const PER_IP_PER_SEC = 20;
const GLOBAL_PER_SEC = 2000;
const MAGIC = 0x2112a442;

const stats = { requests: 0, answered: 0, dropped: 0, started: new Date().toISOString() };
let windowStart = Date.now();
let globalCount = 0;
let perIp = new Map();

function allowed(ip) {
  const now = Date.now();
  if (now - windowStart >= 1000) {
    windowStart = now;
    globalCount = 0;
    perIp = new Map();
  }
  const n = (perIp.get(ip) || 0) + 1;
  perIp.set(ip, n);
  return ++globalCount <= GLOBAL_PER_SEC && n <= PER_IP_PER_SEC;
}

/** Returns the response buffer for a valid IPv4 Binding request, else null. */
export function bindingResponse(msg, rinfo) {
  if (msg.length < 20 || msg.length > 548) return null;
  if ((msg[0] & 0xc0) !== 0) return null; // top two bits must be zero
  if (msg.readUInt16BE(0) !== 0x0001) return null; // Binding Request
  const len = msg.readUInt16BE(2);
  if (len % 4 !== 0 || len + 20 !== msg.length) return null;
  if (msg.readUInt32BE(4) !== MAGIC) return null;
  if (rinfo.family !== 'IPv4' && rinfo.family !== 4) return null;
  const res = Buffer.alloc(32);
  res.writeUInt16BE(0x0101, 0); // Binding Success Response
  res.writeUInt16BE(12, 2); // one 12-byte attribute
  msg.copy(res, 4, 4, 20); // magic cookie + transaction id
  res.writeUInt16BE(0x0020, 20); // XOR-MAPPED-ADDRESS
  res.writeUInt16BE(8, 22);
  res.writeUInt8(0, 24);
  res.writeUInt8(0x01, 25); // IPv4
  res.writeUInt16BE(rinfo.port ^ (MAGIC >>> 16), 26);
  const ip = rinfo.address.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
  res.writeUInt32BE((ip ^ MAGIC) >>> 0, 28);
  return res;
}

export function start() {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    stats.requests++;
    const res = bindingResponse(msg, rinfo);
    if (!res || !allowed(rinfo.address)) {
      stats.dropped++;
      return;
    }
    stats.answered++;
    sock.send(res, rinfo.port, rinfo.address);
  });
  sock.on('error', (e) => {
    console.error('stun socket error', e);
    process.exit(1);
  });
  sock.bind(PORT, HOST, () => console.log(`stun on udp ${HOST}:${sock.address().port}`));
  const health = http.createServer((req, res) => {
    if (req.url !== '/healthz') return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, port: sock.address().port, ...stats }));
  });
  health.listen(HEALTH_PORT, '127.0.0.1', () => console.log(`stun health on http://127.0.0.1:${health.address().port}/healthz`));
  return { sock, health };
}

if (import.meta.url === `file://${process.argv[1]}`) start();
