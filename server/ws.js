'use strict';

/**
 * Minimal RFC 6455 WebSocket server.
 *
 * Exists so OpenICQ runs on a bare Node install with no `npm install` step.
 * Supports text/binary frames, fragmentation, ping/pong and close handshakes.
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP = {
  CONT: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

const MAX_FRAME = 1 << 20; // 1 MiB
const MAX_MESSAGE = 4 << 20; // 4 MiB

const CLOSE_NORMAL = 1000;
const CLOSE_PROTOCOL = 1002;
const CLOSE_TOO_BIG = 1009;

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

class WebSocket extends EventEmitter {
  constructor(socket, req, remoteAddress) {
    super();
    this.socket = socket;
    this.remoteAddress = remoteAddress || socket.remoteAddress || 'unknown';
    this.readyState = 'open';
    this.isAlive = true;

    this._buf = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOp = null;
    this._fragmentSize = 0;

    socket.setTimeout(0);
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => this.emit('error', err));
    socket.on('close', () => this._finish());
  }

  _onData(chunk) {
    if (this.readyState === 'closed') return;
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    try {
      while (this._parseFrame()) {
        /* keep draining */
      }
    } catch (err) {
      this.close(err.closeCode || CLOSE_PROTOCOL, err.message);
    }
  }

  /** @returns {boolean} true when a whole frame was consumed. */
  _parseFrame() {
    const buf = this._buf;
    if (buf.length < 2) return false;

    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let length = b1 & 0x7f;
    let offset = 2;

    if ((b0 & 0x70) !== 0) throw protocolError('reserved bits must be clear');

    if (length === 126) {
      if (buf.length < offset + 2) return false;
      length = buf.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buf.length < offset + 8) return false;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(MAX_FRAME)) throw tooBig('frame exceeds limit');
      length = Number(big);
      offset += 8;
    }

    if (length > MAX_FRAME) throw tooBig('frame exceeds limit');

    // A client that does not mask its frames is broken or hostile.
    if (!masked) throw protocolError('client frames must be masked');

    if (buf.length < offset + 4) return false;
    const mask = buf.subarray(offset, offset + 4);
    offset += 4;

    if (buf.length < offset + length) return false;

    const payload = Buffer.allocUnsafe(length);
    buf.copy(payload, 0, offset, offset + length);
    for (let i = 0; i < length; i++) payload[i] ^= mask[i & 3];

    this._buf = buf.subarray(offset + length);
    this._handleFrame(fin, opcode, payload);
    return true;
  }

  _handleFrame(fin, opcode, payload) {
    const isControl = (opcode & 0x8) !== 0;

    if (isControl) {
      if (!fin) throw protocolError('control frames must not be fragmented');
      if (payload.length > 125) throw protocolError('control frame too large');

      switch (opcode) {
        case OP.CLOSE: {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : CLOSE_NORMAL;
          this.close(code === 1005 ? CLOSE_NORMAL : code, '');
          return;
        }
        case OP.PING:
          this._frame(OP.PONG, payload);
          return;
        case OP.PONG:
          this.isAlive = true;
          this.emit('pong');
          return;
        default:
          throw protocolError('unknown control opcode ' + opcode);
      }
    }

    if (opcode === OP.CONT) {
      if (this._fragmentOp === null) throw protocolError('unexpected continuation');
    } else {
      if (this._fragmentOp !== null) throw protocolError('expected continuation');
      if (opcode !== OP.TEXT && opcode !== OP.BINARY) {
        throw protocolError('unknown data opcode ' + opcode);
      }
      this._fragmentOp = opcode;
    }

    this._fragmentSize += payload.length;
    if (this._fragmentSize > MAX_MESSAGE) throw tooBig('message exceeds limit');
    this._fragments.push(payload);

    if (!fin) return;

    const op = this._fragmentOp;
    const data = this._fragments.length === 1 ? this._fragments[0] : Buffer.concat(this._fragments);
    this._fragments = [];
    this._fragmentOp = null;
    this._fragmentSize = 0;

    this.emit('message', op === OP.TEXT ? data.toString('utf8') : data, op === OP.BINARY);
  }

  _frame(opcode, payload) {
    if (this.socket.destroyed || this.readyState === 'closed') return;

    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;

    try {
      this.socket.write(header);
      if (len) this.socket.write(payload);
    } catch {
      this._finish();
    }
  }

  send(data) {
    if (this.readyState !== 'open') return;
    if (typeof data === 'string') {
      this._frame(OP.TEXT, Buffer.from(data, 'utf8'));
    } else {
      this._frame(OP.BINARY, Buffer.from(data));
    }
  }

  sendJSON(obj) {
    this.send(JSON.stringify(obj));
  }

  ping() {
    this.isAlive = false;
    this._frame(OP.PING, Buffer.alloc(0));
  }

  close(code = CLOSE_NORMAL, reason = '') {
    if (this.readyState !== 'open') return;
    this.readyState = 'closing';

    const reasonBuf = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this._frame(OP.CLOSE, payload);

    // Give the peer a moment to echo the close, then drop the socket.
    const timer = setTimeout(() => this.socket.destroy(), 2000);
    if (timer.unref) timer.unref();
    this.socket.end();
  }

  _finish() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.emit('close');
    this.removeAllListeners();
  }
}

function protocolError(message) {
  const err = new Error(message);
  err.closeCode = CLOSE_PROTOCOL;
  return err;
}

function tooBig(message) {
  const err = new Error(message);
  err.closeCode = CLOSE_TOO_BIG;
  return err;
}

function reject(socket, status, reason) {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/**
 * Attach a WebSocket endpoint to an existing http.Server.
 *
 * @param {import('http').Server} server
 * @param {object} options
 * @param {string} [options.path]
 * @param {(ws: WebSocket, req) => void} options.onConnection
 * @param {(req, socket) => string} options.clientAddress  resolves the peer IP
 * @param {string[]|null} [options.origins]  allowed browser origins, or null for any
 * @param {import('./limits').Limits} [options.limits]
 * @param {number} [options.maxClients]  hard ceiling across all addresses
 */
function attach(server, {
  path = '/ws',
  onConnection,
  clientAddress = (req, socket) => socket.remoteAddress || 'unknown',
  origins = null,
  limits = null,
  maxClients = 2000,
}) {
  const clients = new Set();

  server.on('upgrade', (req, socket) => {
    socket.on('error', () => socket.destroy());

    const url = (req.url || '').split('?')[0];
    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();

    if (url !== path || upgrade !== 'websocket' || !key || version !== '13') {
      return reject(socket, 400, 'Bad Request');
    }

    // A browser always sends Origin on a WebSocket handshake, so checking it
    // keeps other sites from driving this server with someone else's browser.
    // Non-browser clients send none, and they are not the ones at risk.
    const origin = req.headers.origin;
    if (origins && origin && !origins.includes(origin)) {
      console.warn(`[ws] refused handshake from origin ${origin}`);
      return reject(socket, 403, 'Forbidden');
    }

    if (clients.size >= maxClients) {
      return reject(socket, 503, 'Service Unavailable');
    }

    const address = clientAddress(req, socket);
    if (limits && !limits.openConnection(address)) {
      console.warn(`[ws] too many connections from ${address}`);
      return reject(socket, 429, 'Too Many Requests');
    }

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
    );

    const ws = new WebSocket(socket, req, address);
    clients.add(ws);
    ws.on('close', () => {
      clients.delete(ws);
      if (limits) limits.closeConnection(address);
    });
    ws.on('error', () => socket.destroy());
    onConnection(ws, req);
  });

  // Reap connections whose peer vanished without a FIN (sleeping laptops, dead wifi).
  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (!ws.isAlive) {
        ws.socket.destroy();
        clients.delete(ws);
        continue;
      }
      ws.ping();
    }
  }, 30000);
  if (heartbeat.unref) heartbeat.unref();

  return clients;
}

module.exports = { attach, WebSocket };
