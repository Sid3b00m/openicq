'use strict';

/**
 * History, rooms and Meshtastic bridge tests.
 *
 * The unit checks exercise the stores directly; the live checks run a real
 * server and talk to it over the wire, because the interesting failures are in
 * the handlers rather than the data structures.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const { History, dmKey, roomKey } = require('../server/history');
const { Rooms, slugify, isValidRoomId } = require('../server/rooms');
const { Store } = require('../server/store');
const { MqttClient, encodeLength, decodeLength, encodeString, PACKET } = require('../server/mqtt');
const { nodeIdToHex, truncateUtf8 } = require('../server/meshtastic');

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

function section(title) {
  console.log(`\n${title}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PASSWORD = 'hunter22hunter22';

/**
 * A directory of its own per server.
 *
 * The history log lives next to the database, so servers sharing a directory
 * would share each other's messages.
 */
function tempDir() {
  const dir = path.join(os.tmpdir(), `openicq-rooms-${process.pid}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  scratch.push(dir);
  return dir;
}

function tempPath(suffix) {
  return path.join(tempDir(), `openicq.${suffix}`);
}

// --- harness --------------------------------------------------------------

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
  const data = tempPath('json');

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
  const hello = await c.waitFor('hello');
  c.send('register', { nick, password: PASSWORD });
  const reg = await c.waitFor((m) => m.t === 'registered' || m.t === 'error');
  if (reg.t === 'error') throw new Error(`register ${nick}: ${reg.code} ${reg.message}`);

  // Registering hands out a UIN; it does not sign you on.
  c.send('login', { uin: reg.uin, password: PASSWORD });
  const on = await c.waitFor((m) => m.t === 'welcome' || m.t === 'error');
  if (on.t === 'error') throw new Error(`login ${nick}: ${on.code} ${on.message}`);
  return { client: c, uin: reg.uin, hello };
}

// --- history store ---------------------------------------------------------

function testHistoryStore() {
  section('history store');

  const file = tempPath('jsonl');
  const h = new History({ file, maxPerConversation: 5 });

  check('a conversation key is the same whichever way it was sent',
    dmKey('100001', '100002') === dmKey('100002', '100001'));
  check('room keys are namespaced apart from direct ones',
    roomKey('lobby') !== dmKey('lobby', 'lobby'));

  h.recordDirect({ id: 'a', from: '100001', to: '100002', body: 'first', ts: 1000 });
  h.recordDirect({ id: 'b', from: '100002', to: '100001', body: 'second', ts: 2000 });

  const read = h.readDirect('100001', '100002');
  check('both sides land in one conversation', read.length === 2, `got ${read.length}`);
  check('oldest first', read[0].body === 'first');
  check('either direction reads the same', h.readDirect('100002', '100001').length === 2);
  check('an unrelated pair sees nothing', h.readDirect('100001', '100003').length === 0);

  for (let i = 0; i < 10; i++) {
    h.recordDirect({ id: `x${i}`, from: '100001', to: '100002', body: `m${i}`, ts: 3000 + i });
  }
  const capped = h.readDirect('100001', '100002');
  check('the per-conversation cap is enforced', capped.length === 5, `got ${capped.length}`);
  check('the cap keeps the newest', capped[capped.length - 1].body === 'm9');

  check('limit trims the result', h.readDirect('100001', '100002', { limit: 2 }).length === 2);
  check('before() pages backwards',
    h.readDirect('100001', '100002', { before: 3005 }).every((e) => e.ts < 3005));

  h.recordRoom({ id: 'r1', room: 'lobby', from: '100001', fromNick: 'alice', body: 'hi room', ts: 5000 });
  check('room messages are kept separately', h.readRoom('lobby').length === 1);
  check('a room message keeps the nickname', h.readRoom('lobby')[0].nick === 'alice');
  check('a direct read does not see room traffic', h.readDirect('100001', 'lobby').length === 0);

  h.forgetDirect('100001', '100002');
  check('clearing a conversation empties it', h.readDirect('100001', '100002').length === 0);
  check('clearing one conversation leaves others alone', h.readRoom('lobby').length === 1);
  h.close();

  // Reopen: the whole point of writing to disk.
  const reopened = new History({ file, maxPerConversation: 5 });
  check('history survives a restart', reopened.readRoom('lobby').length === 1);
  check('a cleared conversation stays cleared', reopened.readDirect('100001', '100002').length === 0,
    'the tombstone was not applied on load');
  reopened.close();

  // Retention by age.
  const aged = new History({ file, maxAgeDays: 1 });
  check('anything past the retention window is dropped', aged.readRoom('lobby').length === 0);
  aged.close();

  // Switched off entirely.
  const off = new History({ file: tempPath('jsonl'), enabled: false });
  off.recordDirect({ id: 'z', from: '1', to: '2', body: 'nope', ts: Date.now() });
  check('with history off nothing is recorded', off.readDirect('1', '2').length === 0);
  check('and no file is created', !fs.existsSync(off.file));
  off.close();

  // Compaction rewrites the log without the dead weight.
  const compactFile = tempPath('jsonl');
  const c = new History({ file: compactFile, maxPerConversation: 3 });
  for (let i = 0; i < 20; i++) {
    c.recordDirect({ id: `c${i}`, from: '1', to: '2', body: `m${i}`, ts: 1000 + i });
  }
  c.compact();
  const lines = fs.readFileSync(compactFile, 'utf8').trim().split('\n').filter(Boolean);
  check('compaction drops everything trimmed away', lines.length === 3, `${lines.length} lines left`);
  check('compaction keeps the live tail', c.readDirect('1', '2').length === 3);
  c.close();
}

// --- rooms store -----------------------------------------------------------

function testRoomsStore() {
  section('rooms store');

  check('names become readable slugs', slugify('The Lobby') === 'the-lobby');
  check('punctuation is stripped', slugify('C++ & Friends!') === 'c-friends');
  check('an unusable name still gets an id', slugify('\u2603\u2603').length > 0);
  check('room ids are validated', isValidRoomId('the-lobby') && isValidRoomId('mesh:longfast'));
  check('a path traversal is not a room id', !isValidRoomId('../etc/passwd'));
  check('an empty string is not a room id', !isValidRoomId(''));
  check('a prototype key is not a room id', !isValidRoomId('__proto__'));

  const store = new Store(tempPath('json'));
  const rooms = new Rooms(store);

  check('a new server has no rooms', rooms.all.length === 0);

  const made = rooms.create({ name: 'The Lobby', topic: 'Anything goes', owner: '100001' });
  check('a room can be created', !!made.room && made.room.id === 'the-lobby');
  check('the topic is kept', made.room.topic === 'Anything goes');
  check('the same name twice is refused', rooms.create({ name: 'The Lobby', owner: '100002' }).code === 'room-exists');
  check('a one-character name is refused', rooms.create({ name: 'x', owner: '100001' }).code === 'bad-room-name');

  const fakeSession = (uin, nick) => ({ uin, user: { nick } });
  const alice = fakeSession('100001', 'alice');
  const bob = fakeSession('100002', 'bob');

  check('joining a missing room fails', rooms.join('nowhere', alice).code === 'no-such-room');
  rooms.join('the-lobby', alice);
  rooms.join('the-lobby', bob);
  check('occupants are listed', rooms.occupantCount('the-lobby') === 2);

  // A second connection for the same person is one occupant, not two.
  rooms.join('the-lobby', fakeSession('100001', 'alice'));
  check('two devices count as one person', rooms.occupantCount('the-lobby') === 2,
    `${rooms.occupantCount('the-lobby')} occupants`);

  rooms.leave('the-lobby', bob);
  check('leaving removes an occupant', rooms.occupantCount('the-lobby') === 1);
  check('leaveAll reports what was left', rooms.leaveAll(alice).includes('the-lobby'));

  check('only the owner may set the topic',
    rooms.setTopic('the-lobby', 'mine now', '100099').code === 'not-room-owner');
  check('the owner may set the topic', !!rooms.setTopic('the-lobby', 'new topic', '100001').ok);

  check('a stranger cannot remove a room', rooms.remove('the-lobby', '100099').code === 'not-room-owner');

  const mesh = rooms.create({ name: 'LongFast (mesh)', owner: null, managed: 'mesh:longfast' });
  check('a bridge room keeps its given id', mesh.room.id === 'mesh:longfast');
  check('a bridge room is marked managed', mesh.room.managed === 'meshtastic');
  check('a bridge room cannot be removed by a user',
    rooms.remove('mesh:longfast', '100001').code === 'room-managed');

  check('the owner may remove their own room', !!rooms.remove('the-lobby', '100001').ok);
  check('and it is gone', !rooms.exists('the-lobby'));

  // Rooms live in the database, so they have to come back.
  store.flushSync();
  const reopened = new Rooms(new Store(store.file));
  check('rooms survive a restart', reopened.exists('mesh:longfast'),
    'the store dropped db.rooms on load');
  check('but nobody is in them', reopened.occupantCount('mesh:longfast') === 0);
}

// --- MQTT codec ------------------------------------------------------------

function testMqttCodec() {
  section('mqtt codec');

  check('a short length is one byte', encodeLength(64).equals(Buffer.from([64])));
  check('127 is still one byte', encodeLength(127).length === 1);
  check('128 needs two', encodeLength(128).equals(Buffer.from([0x80, 0x01])));
  check('16383 is the two-byte maximum', encodeLength(16383).length === 2);
  check('16384 rolls to three', encodeLength(16384).length === 3);

  for (const value of [0, 1, 127, 128, 8192, 16383, 16384, 2097151]) {
    const encoded = encodeLength(value);
    const decoded = decodeLength(Buffer.concat([Buffer.from([0]), encoded]), 1);
    check(`length ${value} round-trips`, decoded && decoded.value === value,
      decoded ? `got ${decoded.value}` : 'no decode');
  }

  check('a truncated length decodes to nothing', decodeLength(Buffer.from([0x80]), 0) === null);

  const str = encodeString('hello');
  check('strings are length-prefixed', str.readUInt16BE(0) === 5 && str.subarray(2).toString() === 'hello');
  check('multi-byte characters count as bytes', encodeString('\u00e9').readUInt16BE(0) === 2);
}

async function testMqttAgainstStubBroker() {
  section('mqtt client');

  const port = await freePort();
  const seen = { connect: null, subscribe: [], publish: [] };

  // A broker just real enough to CONNACK, accept a SUBSCRIBE and push a PUBLISH.
  const broker = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const type = buf[0] >> 4;
        const len = decodeLength(buf, 1);
        if (!len || buf.length < 1 + len.bytes + len.value) return;
        const body = buf.subarray(1 + len.bytes, 1 + len.bytes + len.value);
        buf = buf.subarray(1 + len.bytes + len.value);

        if (type === PACKET.CONNECT) {
          seen.connect = body;
          socket.write(Buffer.from([PACKET.CONNACK << 4, 2, 0, 0]));
        } else if (type === PACKET.SUBSCRIBE) {
          const topicLength = body.readUInt16BE(2);
          seen.subscribe.push(body.subarray(4, 4 + topicLength).toString('utf8'));
          socket.write(Buffer.from([PACKET.SUBACK << 4, 3, body[0], body[1], 0]));

          // Push a message back on that topic.
          const payload = Buffer.concat([encodeString('test/topic'), Buffer.from('from broker')]);
          socket.write(Buffer.concat([Buffer.from([PACKET.PUBLISH << 4]), encodeLength(payload.length), payload]));
        } else if (type === PACKET.PUBLISH) {
          const topicLength = body.readUInt16BE(0);
          seen.publish.push({
            topic: body.subarray(2, 2 + topicLength).toString('utf8'),
            payload: body.subarray(2 + topicLength).toString('utf8'),
          });
        }
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((r) => broker.listen(port, '127.0.0.1', r));

  const client = new MqttClient({ host: '127.0.0.1', port, username: 'u', password: 'p', clientId: 'tester' });
  const received = [];
  client.on('message', (topic, payload) => received.push({ topic, payload: payload.toString('utf8') }));

  const connected = new Promise((resolve) => client.on('connect', resolve));
  client.connect();
  await connected;

  check('the client connects', client.connected);
  check('the protocol name is MQTT', seen.connect.subarray(2, 6).toString() === 'MQTT');
  check('the protocol level is 3.1.1', seen.connect[6] === 4);
  check('credentials set the username and password flags', (seen.connect[7] & 0xc0) === 0xc0);
  check('the client id is sent', seen.connect.includes(Buffer.from('tester')));

  client.subscribe('test/topic');
  await sleep(200);
  check('a subscription reaches the broker', seen.subscribe.includes('test/topic'));
  check('an inbound publish is delivered', received.length === 1, `got ${received.length}`);
  check('with its topic', received[0] && received[0].topic === 'test/topic');
  check('with its payload', received[0] && received[0].payload === 'from broker');

  client.publish('out/topic', 'hello mesh');
  await sleep(200);
  check('an outbound publish reaches the broker', seen.publish.length === 1);
  check('with its topic', seen.publish[0] && seen.publish[0].topic === 'out/topic');
  check('with its payload', seen.publish[0] && seen.publish[0].payload === 'hello mesh');

  // A packet split across two TCP reads has to reassemble.
  received.length = 0;
  client._onData(Buffer.from([PACKET.PUBLISH << 4, 14, 0, 4]));
  client._onData(Buffer.from('splitpayload'));
  check('a split packet is reassembled', received.length === 1 && received[0].topic === 'spli',
    JSON.stringify(received));

  client.end();
  await new Promise((r) => broker.close(r));
}

function testMeshHelpers() {
  section('meshtastic helpers');

  check('node numbers render as hex ids', nodeIdToHex(0xa1b2c3d4) === '!a1b2c3d4');
  check('small numbers are padded', nodeIdToHex(1) === '!00000001');
  check('a non-number has no id', nodeIdToHex('abc') === null);

  check('short text is untouched', truncateUtf8('hello', 190) === 'hello');
  const long = truncateUtf8('x'.repeat(300), 20);
  check('long text is cut to the radio limit', Buffer.byteLength(long, 'utf8') <= 23, `${long.length} chars`);
  check('a cut is marked with an ellipsis', long.endsWith('\u2026'));
  const multi = truncateUtf8('\u00e9'.repeat(50), 11);
  check('a cut never splits a character', Buffer.from(multi.replace('\u2026', ''), 'utf8').length % 2 === 0,
    'cut mid-sequence');
}

// --- live server -----------------------------------------------------------

async function testHistoryOverTheWire() {
  section('history over the wire');

  const port = await startServer();
  const a = await makeAccount(port, 'alice');
  const b = await makeAccount(port, 'bob');

  check('the server advertises history', a.hello.serverHistory === true);
  check('the server advertises rooms', a.hello.rooms === true);

  a.client.send('message', { to: b.uin, body: 'first message', id: 'm1' });
  await a.client.waitFor('ack');
  b.client.send('message', { to: a.uin, body: 'reply', id: 'm2' });
  await b.client.waitFor('ack');

  a.client.send('get-history', { with: b.uin });
  const h = await a.client.waitFor('history');
  check('history comes back for the right conversation', h.with === b.uin);
  check('both messages are there', h.entries.length === 2, `got ${h.entries.length}`);
  check('oldest first', h.entries[0].body === 'first message');
  check('the sender is recorded', h.entries[0].from === a.uin);

  // The other side must see the same conversation, which is the whole point.
  b.client.send('get-history', { with: a.uin });
  const h2 = await b.client.waitFor('history');
  check('the other side sees the same conversation', h2.entries.length === 2);

  // A different device for the same account, which is the actual complaint.
  const a2 = new Client(port);
  await a2.connect();
  await a2.waitFor('hello');
  a2.send('login', { uin: a.uin, password: PASSWORD });
  await a2.waitFor('welcome');
  a2.send('get-history', { with: b.uin });
  const h3 = await a2.waitFor('history');
  check('a second device sees the same history', h3.entries.length === 2, `got ${h3.entries.length}`);
  a2.close();

  // Messages sent while the recipient is away are still recorded.
  b.client.close();
  await sleep(200);
  a.client.send('message', { to: b.uin, body: 'while you were out', id: 'm3' });
  const ack = await a.client.waitFor('ack');
  check('an offline message is queued', ack.state === 'queued');
  a.client.send('get-history', { with: b.uin });
  const h4 = await a.client.waitFor('history');
  check('an undelivered message is still recorded', h4.entries.length === 3, `got ${h4.entries.length}`);

  check('a junk UIN is rejected',
    await (async () => {
      a.client.send('get-history', { with: '__proto__' });
      const err = await a.client.waitFor('error');
      return err.code === 'no-such-user';
    })());

  const limited = await (async () => {
    a.client.send('get-history', { with: b.uin, limit: 1 });
    return a.client.waitFor('history');
  })();
  check('limit is honoured', limited.entries.length === 1);

  a.client.send('clear-history', { with: b.uin });
  await a.client.waitFor('history-cleared');
  a.client.send('get-history', { with: b.uin });
  const h5 = await a.client.waitFor('history');
  check('clearing really clears', h5.entries.length === 0, `${h5.entries.length} left`);

  a.client.close();
}

async function testHistoryCanBeSwitchedOff() {
  section('history switched off');

  const port = await startServer(['--no-history']);
  const a = await makeAccount(port, 'alice');
  const b = await makeAccount(port, 'bob');

  check('the server says it keeps nothing', a.hello.serverHistory === false);

  a.client.send('message', { to: b.uin, body: 'not recorded', id: 'm1' });
  await a.client.waitFor('ack');
  a.client.send('get-history', { with: b.uin });
  const err = await a.client.waitFor('error');
  check('asking for history is refused', err.code === 'no-history', err.code);

  a.client.close();
  b.client.close();
}

async function testRoomsOverTheWire() {
  section('rooms over the wire');

  const port = await startServer();
  const a = await makeAccount(port, 'alice');
  const b = await makeAccount(port, 'bob');

  a.client.send('list-rooms', {});
  const empty = await a.client.waitFor('room-list');
  check('a new server has no rooms', empty.rooms.length === 0);
  check('and anyone may create one', empty.canCreate === true);

  a.client.send('create-room', { name: 'The Lobby', topic: 'Anything goes' });
  const created = await a.client.waitFor('room-created');
  check('a room can be created', created.room.id === 'the-lobby');

  const added = await b.client.waitFor('room-added');
  check('others are told about a new room', added.room.id === 'the-lobby');

  a.client.send('join-room', { room: 'the-lobby' });
  const joined = await a.client.waitFor('room-joined');
  check('joining returns the room', joined.room.id === 'the-lobby');
  check('and its topic', joined.room.topic === 'Anything goes');
  check('and who is in it', joined.occupants.length === 1);

  b.client.send('join-room', { room: 'the-lobby' });
  await b.client.waitFor('room-joined');
  const entered = await a.client.waitFor('room-entered');
  check('the room is told when someone arrives', entered.nick === 'bob');
  // Matched on the count rather than the packet type: alice's own join already
  // put a one-occupant presence update in her inbox.
  const presence = await a.client.waitFor((m) => m.t === 'room-presence' && m.occupants.length === 2);
  check('and the occupant list is updated', presence.occupants.length === 2);

  b.client.send('room-message', { room: 'the-lobby', body: 'hello everyone', id: 'r1' });
  const heard = await a.client.waitFor('room-message');
  check('a room message reaches the others', heard.body === 'hello everyone');
  check('with the sender attached', heard.from === b.uin && heard.fromNick === 'bob');
  const ack = await b.client.waitFor('room-ack');
  check('the sender gets an acknowledgement', ack.room === 'the-lobby');
  check('and is not sent their own message',
    !b.client.inbox.some((m) => m.t === 'room-message' && m.id === heard.id));

  // Someone who never joined must not be able to talk or listen.
  const lurker = await makeAccount(port, 'lurker');
  lurker.client.send('room-message', { room: 'the-lobby', body: 'intruding', id: 'r2' });
  const refused = await lurker.client.waitFor('error');
  check('talking in a room you have not joined is refused', refused.code === 'not-in-room');
  await sleep(200);
  check('and nothing leaked to them',
    !lurker.client.inbox.some((m) => m.t === 'room-message'));

  check('a junk room id is refused',
    await (async () => {
      a.client.send('join-room', { room: '../../etc/passwd' });
      const err = await a.client.waitFor('error');
      return err.code === 'no-such-room';
    })());

  // Room history has to come back on a later join.
  b.client.send('leave-room', { room: 'the-lobby' });
  await b.client.waitFor('room-left');
  await a.client.waitFor('room-exited');
  b.client.send('join-room', { room: 'the-lobby' });
  const rejoined = await b.client.waitFor('room-joined');
  check('rejoining replays what was said', rejoined.history.length === 1, `got ${rejoined.history.length}`);
  check('the replay keeps the nickname', rejoined.history[0].nick === 'bob');

  a.client.send('set-room-topic', { room: 'the-lobby', topic: 'new topic' });
  const topic = await b.client.waitFor('room-topic');
  check('the owner can set the topic', topic.topic === 'new topic');

  b.client.send('set-room-topic', { room: 'the-lobby', topic: 'hijacked' });
  const notOwner = await b.client.waitFor('error');
  check('someone else cannot', notOwner.code === 'not-room-owner');

  // A disconnect has to clear the occupant list, or rooms fill with ghosts.
  b.client.close();
  const afterDrop = await a.client.waitFor((m) => m.t === 'room-presence' && m.occupants.length === 1);
  check('a dropped connection leaves the room', afterDrop.occupants.length === 1,
    `${afterDrop.occupants.length} still listed`);

  a.client.send('remove-room', { room: 'the-lobby' });
  const removed = await a.client.waitFor('room-removed');
  check('the owner can remove the room', removed.room === 'the-lobby');

  a.client.close();
  lurker.client.close();
}

async function testRoomsCanBeSwitchedOff() {
  section('rooms switched off');

  const port = await startServer(['--no-rooms']);
  const a = await makeAccount(port, 'alice');
  check('the server says it has no rooms', a.hello.rooms === false);

  a.client.send('list-rooms', {});
  const err = await a.client.waitFor('error');
  check('listing rooms is refused', err.code === 'no-rooms', err.code);
  a.client.close();

  const locked = await startServer(['--no-room-creation']);
  const c = await makeAccount(locked, 'alice');
  c.client.send('list-rooms', {});
  const list = await c.client.waitFor('room-list');
  check('creation can be locked down', list.canCreate === false);
  c.client.send('create-room', { name: 'Sneaky' });
  const denied = await c.client.waitFor('error');
  check('and creating one is refused', denied.code === 'rooms-closed');
  c.client.close();
}

async function testRoomsSurviveRestart() {
  section('rooms survive a restart');

  const port = await freePort();
  const data = tempPath('json');
  const args = [path.join(__dirname, '..', 'server', 'index.js'), '--port', String(port),
    '--data', data, '--host', '127.0.0.1'];

  const run = async () => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    children.push(child);
    child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return child;
      } catch {
        /* not up yet */
      }
      await sleep(100);
    }
    throw new Error('server did not start');
  };

  const first = await run();
  const a = await makeAccount(port, 'alice');
  a.client.send('create-room', { name: 'Persistent' });
  await a.client.waitFor('room-created');
  a.client.send('join-room', { room: 'persistent' });
  await a.client.waitFor('room-joined');
  a.client.send('room-message', { room: 'persistent', body: 'still here?', id: 'r1' });
  await a.client.waitFor('room-ack');
  a.client.close();

  // Windows cannot deliver a real SIGINT, so the graceful shutdown that would
  // flush on exit never runs. Wait for the periodic flush instead, which is
  // also the case that matters: a server that is killed outright.
  await sleep(1200);
  first.kill();
  await sleep(600);

  await run();
  const b = new Client(port);
  await b.connect();
  await b.waitFor('hello');
  b.send('login', { uin: a.uin, password: PASSWORD });
  await b.waitFor('welcome');
  b.send('list-rooms', {});
  const list = await b.waitFor('room-list');
  check('the room is still there', list.rooms.some((r) => r.id === 'persistent'),
    JSON.stringify(list.rooms));
  check('and nobody is in it', list.rooms.every((r) => r.occupants === 0));

  b.send('join-room', { room: 'persistent' });
  const joined = await b.waitFor('room-joined');
  check('and what was said is still there', joined.history.length === 1, `got ${joined.history.length}`);
  b.close();
}

async function testMeshtasticBridge() {
  section('meshtastic bridge');

  // A broker that records what the bridge publishes and can push mesh traffic
  // back at it. Enough of MQTT to be indistinguishable from the real thing.
  const brokerPort = await freePort();
  const published = [];
  let client = null;
  const sockets = new Set();

  const broker = net.createServer((socket) => {
    client = socket;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const type = buf[0] >> 4;
        const len = decodeLength(buf, 1);
        if (!len || buf.length < 1 + len.bytes + len.value) return;
        const body = buf.subarray(1 + len.bytes, 1 + len.bytes + len.value);
        buf = buf.subarray(1 + len.bytes + len.value);

        if (type === PACKET.CONNECT) {
          socket.write(Buffer.from([PACKET.CONNACK << 4, 2, 0, 0]));
        } else if (type === PACKET.SUBSCRIBE) {
          socket.write(Buffer.from([PACKET.SUBACK << 4, 3, body[0], body[1], 0]));
        } else if (type === PACKET.PUBLISH) {
          const topicLength = body.readUInt16BE(0);
          published.push({
            topic: body.subarray(2, 2 + topicLength).toString('utf8'),
            payload: body.subarray(2 + topicLength).toString('utf8'),
          });
        }
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((r) => broker.listen(brokerPort, '127.0.0.1', r));

  /** Push a JSON packet at the bridge as a Meshtastic gateway would. */
  const fromMesh = (channel, node, packet) => {
    const topic = `msh/TEST/2/json/${channel}/${node}`;
    const payload = Buffer.concat([encodeString(topic), Buffer.from(JSON.stringify(packet))]);
    client.write(Buffer.concat([Buffer.from([PACKET.PUBLISH << 4]), encodeLength(payload.length), payload]));
  };

  const port = await startServer([
    '--mqtt-host', '127.0.0.1',
    '--mqtt-port', String(brokerPort),
    '--mesh-root', 'msh/TEST',
    '--mesh-channel', 'LongFast',
  ]);
  await sleep(800); // let the bridge connect and subscribe

  const a = await makeAccount(port, 'alice');
  a.client.send('list-rooms', {});
  const list = await a.client.waitFor('room-list');
  const meshRoom = list.rooms.find((r) => r.id === 'mesh:longfast');
  check('the bridge creates a room for its channel', !!meshRoom, JSON.stringify(list.rooms));
  check('and marks it as managed', meshRoom && meshRoom.managed === 'meshtastic');

  a.client.send('remove-room', { room: 'mesh:longfast' });
  const guard = await a.client.waitFor('error');
  check('a bridged room cannot be removed by a user', guard.code === 'room-managed');

  a.client.send('join-room', { room: 'mesh:longfast' });
  await a.client.waitFor('room-joined');

  // Learn a node name first, so the mesh sender shows up readably.
  fromMesh('LongFast', '!a1b2c3d4', {
    from: 0xa1b2c3d4,
    type: 'nodeinfo',
    payload: { shortname: 'BEAR', longname: 'Bear Node' },
  });
  await sleep(150);

  fromMesh('LongFast', '!a1b2c3d4', {
    from: 0xa1b2c3d4,
    to: 4294967295,
    type: 'text',
    payload: { text: 'hello from the woods' },
  });
  const heard = await a.client.waitFor('room-message');
  check('radio text arrives in the room', heard.body === 'hello from the woods');
  check('the node name is used as the nickname', heard.fromNick === 'BEAR', heard.fromNick);
  check('the sender is marked as a mesh node', heard.from === 'mesh:!a1b2c3d4', heard.from);
  check('and tagged with where it came from', heard.source === 'meshtastic');

  const before = published.length;
  await sleep(300);
  check('a mesh message is not echoed back to the mesh', published.length === before,
    JSON.stringify(published.slice(before)));

  // The other direction.
  a.client.send('room-message', { room: 'mesh:longfast', body: 'hello from the internet', id: 'r1' });
  await a.client.waitFor('room-ack');
  await sleep(400);

  const out = published.find((p) => p.payload.includes('hello from the internet'));
  check('a room message is sent out over the radio', !!out, JSON.stringify(published));
  check('on the downlink topic', out && out.topic === 'msh/TEST/2/json/mqtt/', out && out.topic);

  const downlink = out && JSON.parse(out.payload);
  check('as a sendtext packet', downlink && downlink.type === 'sendtext');
  check('with the speaker named', downlink && downlink.payload.startsWith('alice: '));
  check('on the right channel index', downlink && downlink.channel === 0);

  // Traffic the bridge should ignore rather than relay.
  fromMesh('LongFast', '!a1b2c3d4', {
    from: 0xa1b2c3d4, to: 123456, type: 'text', payload: { text: 'private note' },
  });
  fromMesh('LongFast', '!a1b2c3d4', { from: 0xa1b2c3d4, type: 'position', payload: { latitude_i: 1 } });
  fromMesh('Unbridged', '!a1b2c3d4', {
    from: 0xa1b2c3d4, to: 4294967295, type: 'text', payload: { text: 'other channel' },
  });
  await sleep(400);
  const leaked = a.client.inbox.filter((m) => m.t === 'room-message');
  check('a direct mesh message is not published to the room', !leaked.some((m) => m.body === 'private note'));
  check('a position report is not published to the room', leaked.length === 0, JSON.stringify(leaked));
  check('an unbridged channel is ignored', !leaked.some((m) => m.body === 'other channel'));

  // Malformed input must not take the server down.
  client.write(
    Buffer.concat([
      Buffer.from([PACKET.PUBLISH << 4]),
      (() => {
        const p = Buffer.concat([encodeString('msh/TEST/2/json/LongFast/!a1b2c3d4'), Buffer.from('{not json')]);
        return Buffer.concat([encodeLength(p.length), p]);
      })(),
    ])
  );
  await sleep(300);
  const alive = await fetch(`http://127.0.0.1:${port}/health`);
  check('malformed mesh traffic does not take the server down', alive.ok);

  // History has to include what came off the radio.
  a.client.send('get-history', { room: 'mesh:longfast' });
  const h = await a.client.waitFor('history');
  check('mesh traffic is recorded in history', h.entries.length === 2, `got ${h.entries.length}`);
  check('and keeps its source', h.entries.some((e) => e.src === 'meshtastic'));

  a.client.close();

  // close() only refuses new connections; it waits on the ones already open.
  // The bridge holds its MQTT socket open until the server is killed, and that
  // does not happen until the finally block below, so drop it here instead.
  for (const socket of sockets) socket.destroy();
  await new Promise((r) => broker.close(r));
}

// --- run -------------------------------------------------------------------

(async () => {
  try {
    testHistoryStore();
    testRoomsStore();
    testMqttCodec();
    await testMqttAgainstStubBroker();
    testMeshHelpers();
    await testHistoryOverTheWire();
    await testHistoryCanBeSwitchedOff();
    await testRoomsOverTheWire();
    await testRoomsCanBeSwitchedOff();
    await testRoomsSurviveRestart();
    await testMeshtasticBridge();
  } catch (err) {
    failures++;
    console.log(`\n  FAIL unexpected error: ${err.stack}`);
  } finally {
    for (const child of children) child.kill();
    await sleep(300);
    for (const dir of scratch) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* never existed */
      }
    }
  }

  if (failures) {
    console.log(`\n${failures} check${failures === 1 ? '' : 's'} failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll checks passed.');
  }
})();
