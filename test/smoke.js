'use strict';

/**
 * End-to-end smoke test: boots a real server on a scratch database and drives
 * it with two clients over the wire. Run with `npm test`.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 55190 + (process.pid % 300);
const DATA = path.join(os.tmpdir(), `openicq-smoke-${process.pid}.json`);
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
let child = null;

function check(label, condition) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(name) {
    this.name = name;
    this.inbox = [];
    this.waiters = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      this.ws.addEventListener('open', () => resolve(this));
      this.ws.addEventListener('error', reject);
      this.ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        const waiting = this.waiters.findIndex((w) => w.type === msg.t);
        if (waiting >= 0) {
          this.waiters.splice(waiting, 1)[0].resolve(msg);
        } else {
          this.inbox.push(msg);
        }
      });
    });
  }

  send(t, payload) {
    this.ws.send(JSON.stringify(Object.assign({ t }, payload)));
  }

  waitFor(type, timeout = 5000) {
    const existing = this.inbox.find((m) => m.t === type);
    if (existing) {
      this.inbox.splice(this.inbox.indexOf(existing), 1);
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
          reject(new Error(`${this.name}: timed out waiting for "${type}"`));
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

async function startServer() {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), OPENICQ_DATA: DATA, HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error('server did not start');
}

async function main() {
  if (typeof WebSocket === 'undefined') {
    console.error('This test needs Node 22+ (global WebSocket client). Skipping.');
    process.exit(0);
  }

  console.log(`OpenICQ smoke test on port ${PORT}\n`);
  await startServer();

  // --- registration -------------------------------------------------------
  console.log('registration');
  const alice = await new Client('alice').connect();
  const bob = await new Client('bob').connect();

  const hello = await alice.waitFor('hello');
  check('server sends hello', hello.server === 'OpenICQ');

  alice.send('register', { nick: 'Alice', password: 'hunter22' });
  const aliceReg = await alice.waitFor('registered');
  bob.send('register', { nick: 'Bob', password: 'hunter22' });
  const bobReg = await bob.waitFor('registered');

  check('first UIN is 100000', aliceReg.uin === '100000');
  check('second UIN is 100001', bobReg.uin === '100001');

  bob.send('register', { nick: 'Alice', password: 'whatever1' });
  const dup = await bob.waitFor('error');
  check('duplicate nickname rejected', dup.code === 'nick-taken');

  // --- sign on ------------------------------------------------------------
  console.log('\nsign on');
  alice.send('login', { uin: aliceReg.uin, password: 'wrong-password' });
  const badLogin = await alice.waitFor('error');
  check('wrong password rejected', badLogin.code === 'bad-credentials');

  alice.send('login', { uin: aliceReg.uin, password: 'hunter22' });
  const aliceWelcome = await alice.waitFor('welcome');
  check('sign on by UIN works', aliceWelcome.user.uin === aliceReg.uin);

  bob.send('login', { uin: 'Bob', password: 'hunter22', status: 'away' });
  const bobWelcome = await bob.waitFor('welcome');
  check('sign on by nickname works', bobWelcome.user.uin === bobReg.uin);
  check('requested status is honoured', bobWelcome.status === 'away');

  // --- directory ----------------------------------------------------------
  console.log('\ndirectory and authorization');
  alice.send('search', { query: 'bob' });
  const results = await alice.waitFor('search-result');
  check('search finds Bob', results.results.some((r) => r.uin === bobReg.uin));
  check('search excludes self', !results.results.some((r) => r.uin === aliceReg.uin));

  alice.send('add-contact', { uin: bobReg.uin, reason: 'hi from the test suite' });
  const added = await alice.waitFor('contact-added');
  check('contact added pending authorization', added.pendingAuth === true);
  check('unauthorized contact reads as offline', added.contact.status === 'offline');

  const request = await bob.waitFor('auth-request');
  check('authorization request delivered', request.from === aliceReg.uin);
  check('request carries the reason', request.reason === 'hi from the test suite');

  bob.send('auth-response', { uin: aliceReg.uin, accept: true });
  const authResult = await alice.waitFor('auth-result');
  check('authorization accepted', authResult.accepted === true);

  const presence = await alice.waitFor('presence');
  check('presence revealed after authorization', presence.status === 'away');

  // --- messaging ----------------------------------------------------------
  console.log('\nmessaging');
  alice.send('message', { to: bobReg.uin, body: 'Uh-oh!', id: 'ref-1' });
  const delivered = await bob.waitFor('message');
  check('message delivered', delivered.body === 'Uh-oh!');
  check('message carries sender nick', delivered.fromNick === 'Alice');

  const ack = await alice.waitFor('ack');
  check('sender acked as delivered', ack.state === 'delivered' && ack.ref === 'ref-1');

  bob.send('typing', { to: aliceReg.uin, state: 'start' });
  const typing = await alice.waitFor('typing');
  check('typing notification relayed', typing.from === bobReg.uin && typing.state === 'start');

  // --- offline store-and-forward -----------------------------------------
  console.log('\noffline messages');
  bob.close();
  await sleep(300);

  const offlinePresence = await alice.waitFor('presence');
  check('sign-off broadcast to contacts', offlinePresence.status === 'offline');

  alice.send('message', { to: bobReg.uin, body: 'left you a note', id: 'ref-2' });
  const queuedAck = await alice.waitFor('ack');
  check('message queued for offline user', queuedAck.state === 'queued');

  const bob2 = await new Client('bob2').connect();
  await bob2.waitFor('hello');
  bob2.send('login', { uin: bobReg.uin, password: 'hunter22' });
  await bob2.waitFor('welcome');

  const stored = await bob2.waitFor('message');
  check('offline message replayed on sign on', stored.body === 'left you a note');
  check('offline message flagged', stored.offline === true);

  const backOnline = await alice.waitFor('presence');
  check('sign-on broadcast to contacts', backOnline.status === 'online');

  // --- invisible ----------------------------------------------------------
  console.log('\ninvisible mode');
  bob2.send('set-status', { status: 'invisible' });
  await bob2.waitFor('status-changed');
  const invisiblePresence = await alice.waitFor('presence');
  check('invisible reads as offline to contacts', invisiblePresence.status === 'offline');

  // --- housekeeping -------------------------------------------------------
  console.log('\nvalidation');
  alice.send('message', { to: '999999', body: 'ghost' });
  const noUser = await alice.waitFor('error');
  check('message to unknown UIN rejected', noUser.code === 'no-such-user');

  alice.send('nonsense-packet', {});
  const unknown = await alice.waitFor('error');
  check('unknown packet rejected', unknown.code === 'unknown-packet');

  if (process.env.DEBUG) {
    console.log('\nalice leftover inbox:', JSON.stringify(alice.inbox, null, 1));
    console.log('\nbob2 leftover inbox:', JSON.stringify(bob2.inbox, null, 1));
  }

  alice.close();
  bob2.close();

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
}

function cleanup() {
  if (child) child.kill();
  try {
    fs.unlinkSync(DATA);
  } catch {
    /* nothing to remove */
  }
}

main()
  .then(() => {
    cleanup();
    process.exit(failures ? 1 : 0);
  })
  .catch((err) => {
    console.error('\nSmoke test crashed:', err.message);
    cleanup();
    process.exit(1);
  });
