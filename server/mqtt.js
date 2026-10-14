'use strict';

/**
 * Minimal MQTT 3.1.1 client.
 *
 * Written from scratch for the same reason as the WebSocket server: OpenICQ
 * runs on a bare Node install with no `npm install`. Only what the Meshtastic
 * bridge needs is here — connect, subscribe, publish and keepalive, all at
 * QoS 0. There is no session persistence, no QoS 1/2 and no TLS; put it on a
 * broker you reach over a trusted network, or tunnel it.
 */

const net = require('net');
const tls = require('tls');
const { EventEmitter } = require('events');

const PACKET = {
  CONNECT: 1,
  CONNACK: 2,
  PUBLISH: 3,
  PUBACK: 4,
  SUBSCRIBE: 8,
  SUBACK: 9,
  UNSUBSCRIBE: 10,
  UNSUBACK: 11,
  PINGREQ: 12,
  PINGRESP: 13,
  DISCONNECT: 14,
};

const CONNACK_REASON = {
  0: 'accepted',
  1: 'unacceptable protocol version',
  2: 'client id rejected',
  3: 'server unavailable',
  4: 'bad username or password',
  5: 'not authorized',
};

const MAX_PAYLOAD = 1 << 20; // 1 MiB; mesh packets are tiny

/** MQTT encodes lengths as 1-4 bytes with a continuation bit. */
function encodeLength(value) {
  const out = [];
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    out.push(byte);
  } while (value > 0);
  return Buffer.from(out);
}

function decodeLength(buf, offset) {
  let multiplier = 1;
  let value = 0;
  let bytes = 0;
  let byte;
  do {
    if (offset + bytes >= buf.length) return null; // not all here yet
    byte = buf[offset + bytes];
    value += (byte & 0x7f) * multiplier;
    multiplier *= 128;
    bytes++;
    if (bytes > 4) throw new Error('malformed remaining length');
  } while ((byte & 0x80) !== 0);
  return { value, bytes };
}

function encodeString(value) {
  const body = Buffer.from(String(value), 'utf8');
  const header = Buffer.alloc(2);
  header.writeUInt16BE(body.length, 0);
  return Buffer.concat([header, body]);
}

class MqttClient extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.host
   * @param {number} [options.port]
   * @param {boolean} [options.tls]
   * @param {string} [options.username]
   * @param {string} [options.password]
   * @param {string} [options.clientId]
   * @param {number} [options.keepalive]  seconds
   */
  constructor(options = {}) {
    super();
    this.host = options.host;
    this.port = options.port || (options.tls ? 8883 : 1883);
    this.useTls = !!options.tls;
    this.username = options.username || null;
    this.password = options.password || null;
    this.clientId =
      options.clientId || `openicq-${Math.random().toString(16).slice(2, 10)}`;
    this.keepalive = options.keepalive || 60;

    this.socket = null;
    this.connected = false;
    this.closed = false;
    this._buf = Buffer.alloc(0);
    this._packetId = 1;
    this._pingTimer = null;
    this._reconnectDelay = 1000;
    this._subscriptions = new Set();
  }

  nextPacketId() {
    this._packetId = (this._packetId % 65535) + 1;
    return this._packetId;
  }

  connect() {
    if (this.closed) return;
    const connector = this.useTls ? tls : net;
    const opts = this.useTls
      ? { host: this.host, port: this.port, servername: this.host }
      : { host: this.host, port: this.port };

    this.socket = connector.connect(opts, () => this._sendConnect());
    this.socket.setNoDelay(true);
    this.socket.on('data', (chunk) => this._onData(chunk));
    this.socket.on('error', (err) => this.emit('error', err));
    this.socket.on('close', () => this._onClose());
  }

  _sendConnect() {
    let flags = 0x02; // clean session
    if (this.username) flags |= 0x80;
    if (this.password) flags |= 0x40;

    const variable = Buffer.concat([
      encodeString('MQTT'),
      Buffer.from([4, flags]), // protocol level 4 = 3.1.1
      (() => {
        const ka = Buffer.alloc(2);
        ka.writeUInt16BE(this.keepalive, 0);
        return ka;
      })(),
    ]);

    const payloadParts = [encodeString(this.clientId)];
    if (this.username) payloadParts.push(encodeString(this.username));
    if (this.password) payloadParts.push(encodeString(this.password));

    this._send(PACKET.CONNECT, 0, Buffer.concat([variable, ...payloadParts]));
  }

  _send(type, flags, body) {
    if (!this.socket || this.socket.destroyed) return;
    const header = Buffer.from([(type << 4) | flags]);
    this.socket.write(Buffer.concat([header, encodeLength(body.length), body]));
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    try {
      while (this._parse()) {
        /* keep draining */
      }
    } catch (err) {
      this.emit('error', err);
      if (this.socket) this.socket.destroy();
    }
  }

  /** @returns {boolean} true when a whole packet was consumed. */
  _parse() {
    if (this._buf.length < 2) return false;

    const type = this._buf[0] >> 4;
    const flags = this._buf[0] & 0x0f;
    const length = decodeLength(this._buf, 1);
    if (!length) return false;

    if (length.value > MAX_PAYLOAD) throw new Error('mqtt packet too large');

    const start = 1 + length.bytes;
    if (this._buf.length < start + length.value) return false;

    const body = this._buf.subarray(start, start + length.value);
    this._buf = this._buf.subarray(start + length.value);
    this._handle(type, flags, body);
    return true;
  }

  _handle(type, flags, body) {
    switch (type) {
      case PACKET.CONNACK: {
        const code = body.length >= 2 ? body[1] : 1;
        if (code !== 0) {
          this.emit('error', new Error(`broker refused the connection: ${CONNACK_REASON[code] || code}`));
          if (this.socket) this.socket.destroy();
          return;
        }
        this.connected = true;
        this._reconnectDelay = 1000;
        this._startPing();
        // Re-subscribe after a reconnect: clean sessions forget everything.
        for (const topic of this._subscriptions) this._sendSubscribe(topic);
        this.emit('connect');
        return;
      }

      case PACKET.PUBLISH: {
        const qos = (flags >> 1) & 0x03;
        if (body.length < 2) return;
        const topicLength = body.readUInt16BE(0);
        let offset = 2 + topicLength;
        const topic = body.subarray(2, offset).toString('utf8');

        let packetId = null;
        if (qos > 0) {
          if (body.length < offset + 2) return;
          packetId = body.readUInt16BE(offset);
          offset += 2;
        }
        const payload = body.subarray(offset);
        if (qos === 1 && packetId !== null) {
          const ack = Buffer.alloc(2);
          ack.writeUInt16BE(packetId, 0);
          this._send(PACKET.PUBACK, 0, ack);
        }
        this.emit('message', topic, payload);
        return;
      }

      case PACKET.SUBACK:
        this.emit('suback');
        return;

      case PACKET.PINGRESP:
        return;

      default:
        return;
    }
  }

  _startPing() {
    clearInterval(this._pingTimer);
    this._pingTimer = setInterval(() => {
      if (this.connected) this._send(PACKET.PINGREQ, 0, Buffer.alloc(0));
    }, this.keepalive * 500); // ping at half the keepalive
    if (this._pingTimer.unref) this._pingTimer.unref();
  }

  _onClose() {
    const wasConnected = this.connected;
    this.connected = false;
    clearInterval(this._pingTimer);
    this.socket = null;
    this._buf = Buffer.alloc(0);

    if (wasConnected) this.emit('disconnect');
    if (this.closed) return;

    const delay = this._reconnectDelay;
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, 60_000);
    this.emit('reconnecting', delay);
    const timer = setTimeout(() => this.connect(), delay);
    if (timer.unref) timer.unref();
  }

  _sendSubscribe(topic) {
    const id = Buffer.alloc(2);
    id.writeUInt16BE(this.nextPacketId(), 0);
    this._send(
      PACKET.SUBSCRIBE,
      0x02, // SUBSCRIBE requires flags 0010
      Buffer.concat([id, encodeString(topic), Buffer.from([0])]) // QoS 0
    );
  }

  subscribe(topic) {
    this._subscriptions.add(topic);
    if (this.connected) this._sendSubscribe(topic);
  }

  /**
   * @param {string} topic
   * @param {string|Buffer} payload
   */
  publish(topic, payload) {
    if (!this.connected) return false;
    const body = Buffer.concat([
      encodeString(topic),
      Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8'),
    ]);
    this._send(PACKET.PUBLISH, 0, body); // QoS 0, no packet id
    return true;
  }

  end() {
    this.closed = true;
    clearInterval(this._pingTimer);
    if (this.socket && this.connected) {
      this._send(PACKET.DISCONNECT, 0, Buffer.alloc(0));
    }
    if (this.socket) this.socket.end();
    this.connected = false;
  }
}

module.exports = { MqttClient, encodeLength, decodeLength, encodeString, PACKET };
