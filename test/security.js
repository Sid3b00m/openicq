'use strict';

/**
 * Security regression test.
 *
 * Each check here corresponds to a weakness that was found by auditing the
 * server; they exist to stop those weaknesses coming back. Run with
 * `npm run test:security`.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let failures = 0;
const children = [];
const scratch = [];

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` \u2014 ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PASSWORD = 'hunter22hunter22';

// --- harness --------------------------------------------------------------

/** Ask the OS for a port it is willing to hand out (Windows reserves ranges). */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startServer(args = []) {
  const port = await freePort();
  const data = path.join(os.tmpdir(), `openicq-sec-${process.pid}-${port}.json`);
  scratch.push(data);

  const child = spawn(
    process.execPath,
    [path.join(__dirname, '..', 'server', 'index.js'), '--port', String(port), '--data', data,
      '--host', '127.0.0.1', ...args],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  children.push(child);
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return port;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error('server did not start');
}

class Client {
  constructor(port) {
    this.port = port;
    this.inbox = [];
    this.waiters = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`);
      this.ws.addEventListener('open', () => resolve(this));
      this.ws.addEventListener('error', () => reject(new Error('refused')));
      this.ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        const idx = this.waiters.findIndex((w) => w.match(msg));
        if (idx >= 0) this.waiters.splice(idx, 1)[0].resolve(msg);
        else this.inbox.push(msg);
      });
    });
  }
  send(t, payload) {
    this.ws.send(JSON.stringify({ t, ...payload }));
  }
  waitFor(type, timeout = 8000) {
    const match = typeof type === 'function' ? type : (m) => m.t === type;
    const existing = this.inbox.find(match);
    if (existing) {
      this.inbox.splice(this.inbox.indexOf(existing), 1);
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          reject(new Error(`timed out waiting for ${type}`));
        }
      }, timeout);
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

async function makeAccount(port, nick) {
  const c = new Client(port);
  await c.connect();
  await c.waitFor('hello');
  c.send('register', { nick, password: PASSWORD });
  const reg = await c.waitFor((m) => m.t === 'registered' || m.t === 'error');
  if (reg.t === 'error') throw new Error(`register ${nick}: ${reg.code} ${reg.message}`);
  return { client: c, uin: reg.uin };
}

/** Raw handshake, because the built-in WebSocket client cannot set Origin. */
function handshake(port, origin) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      let req =
        'GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n' +
        'Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n' +
        `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n`;
      if (origin) req += `Origin: ${origin}\r\n`;
      sock.write(req + '\r\n');
    });
    sock.setTimeout(4000, () => {
      sock.destroy();
      resolve(0);
    });
    sock.once('data', (chunk) => {
      const status = Number(chunk.toString('latin1').split('\r\n')[0].split(' ')[1]);
      sock.destroy();
      resolve(status);
    });
    sock.once('error', () => resolve(0));
  });
}

// --- checks ---------------------------------------------------------------

async function testOrigin() {
  console.log('\nwebsocket origin');
  const port = await startServer(['--origin', 'https://icq.example']);

  check('matching origin accepted', (await handshake(port, 'https://icq.example')) === 101);
  check('foreign origin refused', (await handshake(port, 'https://evil.example')) === 403);
  check('non-browser client (no Origin) still accepted', (await handshake(port, null)) === 101);

  const open = await startServer([]);
  check('no --origin means any origin', (await handshake(open, 'https://anywhere.example')) === 101);
}

async function testInvisibleAck() {
  console.log('\ninvisible mode does not leak through delivery acks');
  const port = await startServer(['--registrations-per-hour', '50']);
  const alice = await makeAccount(port, 'Alice');
  const bob = await makeAccount(port, 'Bob');

  alice.client.send('login', { uin: alice.uin, password: PASSWORD });
  await alice.client.waitFor('welcome');
  bob.client.send('login', { uin: bob.uin, password: PASSWORD, status: 'invisible' });
  await bob.client.waitFor('welcome');

  alice.client.send('message', { to: bob.uin, body: 'are you there', id: 'r1' });
  const ack = await alice.client.waitFor('ack');
  check('ack for an invisible recipient reads as queued', ack.state === 'queued', `got "${ack.state}"`);
  check('ack reports the recipient as offline', ack.targetStatus === 'offline');

  // The message must still arrive: invisibility hides presence, not delivery.
  const got = await bob.client.waitFor('message');
  check('invisible recipient still receives the message', got.body === 'are you there');

  // A genuinely offline recipient must look identical.
  bob.client.close();
  await sleep(300);
  alice.client.send('message', { to: bob.uin, body: 'note', id: 'r2' });
  const ack2 = await alice.client.waitFor('ack');
  check('offline recipient is indistinguishable', ack2.state === ack.state && ack2.targetStatus === ack.targetStatus);
  alice.client.close();
}

async function testPrototypeKeys() {
  console.log('\nprototype keys are not UINs');
  const port = await startServer(['--registrations-per-hour', '50']);
  const me = await makeAccount(port, 'Carol');
  me.client.send('login', { uin: me.uin, password: PASSWORD });
  await me.client.waitFor('welcome');

  for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    me.client.send('get-info', { uin: key });
    const r = await me.client.waitFor((m) => m.t === 'user-info' || m.t === 'error');
    check(`get-info rejects "${key}"`, r.t === 'error' && r.code === 'no-such-user');

    me.client.send('remove-contact', { uin: key });
    const r2 = await me.client.waitFor((m) => m.t === 'contact-removed' || m.t === 'error');
    check(`remove-contact rejects "${key}"`, r2.t === 'error' && r2.code === 'no-such-contact');

    me.client.send('add-contact', { uin: key });
    const r3 = await me.client.waitFor((m) => m.t === 'contact-added' || m.t === 'error');
    check(`add-contact rejects "${key}"`, r3.t === 'error' && r3.code === 'no-such-user');
  }
  me.client.close();
}

async function testPasswordPolicy() {
  console.log('\npassword policy');
  const port = await startServer(['--registrations-per-hour', '50']);
  const c = new Client(port);
  await c.connect();
  await c.waitFor('hello');

  c.send('register', { nick: 'Shorty', password: 'short1' });
  check('short password refused', (await c.waitFor('error')).code === 'bad-password');

  c.send('register', { nick: 'Longy', password: 'x'.repeat(300) });
  check('over-long password refused', (await c.waitFor('error')).code === 'bad-password');

  c.send('register', { nick: 'Fine', password: PASSWORD });
  check('acceptable password works', (await c.waitFor('registered')).uin.length > 0);
  c.close();
}

async function testEventLoopUnderLoad() {
  console.log('\nsign-on flood does not block the server');
  const port = await startServer(['--registrations-per-hour', '50', '--max-connections-per-ip', '40']);
  const victim = await makeAccount(port, 'Victim');
  victim.client.close();

  const latency = async () => {
    const t = Date.now();
    await fetch(`http://127.0.0.1:${port}/health`).catch(() => {});
    return Date.now() - t;
  };

  let baseline = 0;
  for (let i = 0; i < 5; i++) baseline += await latency();
  baseline /= 5;

  const floods = [];
  for (let i = 0; i < 20; i++) {
    const c = new Client(port);
    try {
      await c.connect();
      floods.push(c);
    } catch {
      break;
    }
  }
  // Each of these would once have run a blocking scryptSync on the event loop.
  for (let round = 0; round < 10; round++) {
    for (const c of floods) c.send('login', { uin: victim.uin, password: `guess-${round}` });
  }

  await sleep(400);
  const under = [];
  for (let i = 0; i < 6; i++) under.push(await latency());
  const worst = Math.max(...under);

  check(
    'a trivial request still answers promptly under a sign-on flood',
    worst < 2000,
    `baseline ${baseline.toFixed(0)}ms, worst ${worst}ms`
  );
  floods.forEach((c) => c.close());
}

async function testConnectionCap() {
  console.log('\nper-IP limits');
  const port = await startServer(['--max-connections-per-ip', '4', '--registrations-per-hour', '2']);

  const open = [];
  let refused = 0;
  for (let i = 0; i < 10; i++) {
    const c = new Client(port);
    try {
      await c.connect();
      open.push(c);
    } catch {
      refused++;
    }
  }
  check('connections past the per-IP cap are refused', open.length <= 4 && refused > 0,
    `${open.length} accepted, ${refused} refused`);
  check('a handshake over the cap is answered with 429', (await handshake(port, null)) === 429);

  open.forEach((c) => c.close());
  await sleep(300);
  check('the cap frees up once sockets close', (await handshake(port, null)) === 101);

  // registration quota
  const c = new Client(port);
  await c.connect();
  await c.waitFor('hello');
  const codes = [];
  for (let i = 0; i < 4; i++) {
    c.send('register', { nick: `Quota${i}`, password: PASSWORD });
    const r = await c.waitFor((m) => m.t === 'registered' || m.t === 'error');
    codes.push(r.t === 'registered' ? 'ok' : r.code);
  }
  check('registration quota per IP is enforced', codes.filter((x) => x === 'ok').length === 2,
    codes.join(', '));
  c.close();
}

async function testLoginBackoff() {
  console.log('\nsign-on backoff');
  const port = await startServer(['--registrations-per-hour', '50']);
  const victim = await makeAccount(port, 'Target');
  victim.client.close();
  await sleep(200);

  // Fresh connections must not reset the backoff.
  const timings = [];
  for (let i = 0; i < 4; i++) {
    const c = new Client(port);
    await c.connect();
    await c.waitFor('hello');
    const t = Date.now();
    c.send('login', { uin: victim.uin, password: `wrong-${i}` });
    const err = await c.waitFor('error', 30000);
    timings.push(Date.now() - t);
    c.close();
    if (err.code !== 'bad-credentials') {
      check('guesses are rejected', false, err.code);
      return;
    }
  }
  check(
    'each failed guess costs more, even on a new connection',
    timings[3] > timings[0] * 2,
    timings.map((t) => `${t}ms`).join(' -> ')
  );
}

async function testHeaders() {
  console.log('\nhttp responses');
  const port = await startServer([]);
  const res = await fetch(`http://127.0.0.1:${port}/`);

  const csp = res.headers.get('content-security-policy') || '';
  check('content-security-policy is sent', csp.includes("default-src 'none'"));
  check('CSP forbids framing', csp.includes("frame-ancestors 'none'"));
  check('x-frame-options is sent', res.headers.get('x-frame-options') === 'DENY');
  check('referrer-policy is sent', res.headers.get('referrer-policy') === 'no-referrer');
  check('nosniff is sent', res.headers.get('x-content-type-options') === 'nosniff');

  const plain = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  check('/health does not report counts by default', plain.users === undefined, JSON.stringify(plain));

  const detailed = await startServer(['--health-details']);
  const rich = await (await fetch(`http://127.0.0.1:${detailed}/health`)).json();
  check('--health-details opts into counts', typeof rich.users === 'number');

  const hstsPort = await startServer(['--hsts']);
  const hsts = await fetch(`http://127.0.0.1:${hstsPort}/`);
  check('--hsts sends strict-transport-security',
    (hsts.headers.get('strict-transport-security') || '').includes('max-age=31536000'));

  // Path traversal out of public/ must stay shut.
  for (const attempt of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json']) {
    const r = await fetch(`http://127.0.0.1:${port}${attempt}`);
    check(`traversal blocked: ${attempt}`, r.status === 403 || r.status === 404, `status ${r.status}`);
  }
}

/** Open a handshake carrying an X-Forwarded-For, keeping the socket alive. */
function handshakeForwarded(port, forwarded, keep) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(
        'GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n' +
          'Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n' +
          `X-Forwarded-For: ${forwarded}\r\n` +
          `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n\r\n`
      );
    });
    keep.push(sock);
    sock.setTimeout(4000, () => {
      sock.destroy();
      resolve(0);
    });
    sock.once('data', (chunk) => {
      resolve(Number(chunk.toString('latin1').split('\r\n')[0].split(' ')[1]));
    });
    sock.once('error', () => resolve(0));
  });
}

async function testForwardedFor() {
  console.log('\nx-forwarded-for');
  const socks = [];

  // Without --trust-proxy, spoofing XFF must not buy extra connections.
  const plain = await startServer(['--max-connections-per-ip', '3']);
  let accepted = 0;
  for (let i = 0; i < 8; i++) {
    if ((await handshakeForwarded(plain, `10.0.0.${i}`, socks)) === 101) accepted++;
  }
  check('spoofed X-Forwarded-For does not raise the per-IP cap', accepted <= 3,
    `${accepted} accepted`);

  // With --trust-proxy, the header decides the identity, so distinct clients
  // behind one proxy each get their own allowance.
  const trusted = await startServer(['--max-connections-per-ip', '2', '--trust-proxy', 'loopback']);
  let distinct = 0;
  for (let i = 0; i < 6; i++) {
    if ((await handshakeForwarded(trusted, `203.0.113.${i}`, socks)) === 101) distinct++;
  }
  check('a trusted proxy lets each forwarded client have its own allowance', distinct === 6,
    `${distinct}/6 accepted`);

  let sameClient = 0;
  for (let i = 0; i < 5; i++) {
    if ((await handshakeForwarded(trusted, '198.51.100.7', socks)) === 101) sameClient++;
  }
  check('one forwarded client is still capped', sameClient === 2, `${sameClient} accepted`);

  // Only the rightmost entry counts; the client-supplied prefix is ignored.
  let spoofPrefix = 0;
  for (let i = 0; i < 5; i++) {
    if ((await handshakeForwarded(trusted, `1.2.3.${i}, 198.51.100.7`, socks)) === 101) {
      spoofPrefix++;
    }
  }
  check('entries left of the proxy hop are ignored', spoofPrefix === 0, `${spoofPrefix} accepted`);

  socks.forEach((s) => s.destroy());
}

// --- runner ---------------------------------------------------------------

async function main() {
  if (typeof WebSocket === 'undefined') {
    console.error('This test needs Node 22+ (global WebSocket client). Skipping.');
    process.exit(0);
  }
  console.log('OpenICQ security regression test\n');

  await testOrigin();
  await testInvisibleAck();
  await testPrototypeKeys();
  await testPasswordPolicy();
  await testEventLoopUnderLoad();
  await testConnectionCap();
  await testLoginBackoff();
  await testHeaders();
  await testForwardedFor();

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
}

function cleanup() {
  for (const child of children) child.kill();
  for (const file of scratch) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* nothing to remove */
    }
  }
}

main()
  .then(() => {
    cleanup();
    process.exit(failures ? 1 : 0);
  })
  .catch((err) => {
    console.error('\nSecurity test crashed:', err.message);
    cleanup();
    process.exit(1);
  });
