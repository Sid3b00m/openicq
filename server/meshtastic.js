'use strict';

/**
 * Meshtastic bridge.
 *
 * Maps Meshtastic channels onto OpenICQ chat rooms over the mesh's MQTT
 * uplink, so text on the radio appears in a room and vice versa.
 *
 * This expects the Meshtastic MQTT module to have JSON output switched on,
 * which makes the device publish to:
 *
 *   <root>/2/json/<channel>/<node id>
 *
 * and accept downlink messages on:
 *
 *   <root>/2/json/mqtt/
 *
 * Caveat worth knowing before switching this on: anything said in a bridged
 * room goes out over the radio, where it is readable by anyone in range with
 * the channel key. Treat bridged rooms as public.
 */

const { MqttClient } = require('./mqtt');

const DEFAULTS = {
  root: 'msh/US',
  channels: ['LongFast'],
  roomPrefix: 'mesh:',
  // Meshtastic text payloads are capped around 200 bytes; longer room messages
  // are truncated rather than silently dropped by the firmware.
  maxTextBytes: 190,
  // Our own node number for downlink packets. 0 lets the gateway decide.
  fromNode: 0,
};

const BROADCAST = 4294967295;

/** "!a1b2c3d4" from a numeric node id, which is how Meshtastic shows them. */
function nodeIdToHex(num) {
  if (typeof num !== 'number' || !Number.isFinite(num)) return null;
  return '!' + (num >>> 0).toString(16).padStart(8, '0');
}

function truncateUtf8(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  // Cut on a character boundary, not mid-sequence.
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8') + '\u2026';
}

class MeshtasticBridge {
  /**
   * @param {object} options
   * @param {import('./protocol').Hub} options.hub
   * @param {import('./rooms').Rooms} options.rooms
   * @param {string} options.host  MQTT broker
   */
  constructor(options) {
    this.opts = { ...DEFAULTS, ...options };
    this.hub = options.hub;
    this.rooms = options.rooms;

    this.nodeNames = new Map(); // node id -> short name
    this.roomToChannel = new Map(); // room id -> channel name
    this.channelToRoom = new Map(); // channel name -> room id
    this.stats = { received: 0, sent: 0, dropped: 0 };

    this.client = new MqttClient({
      host: options.host,
      port: options.port,
      tls: options.tls,
      username: options.username,
      password: options.password,
      clientId: options.clientId,
    });
  }

  start() {
    this._ensureRooms();

    this.client.on('connect', () => {
      console.log(`[mesh] connected to ${this.opts.host}:${this.client.port}`);
      for (const channel of this.opts.channels) {
        const topic = `${this.opts.root}/2/json/${channel}/+`;
        this.client.subscribe(topic);
        console.log(`[mesh] listening on ${topic} -> room ${this.channelToRoom.get(channel)}`);
      }
    });

    this.client.on('message', (topic, payload) => this._onMeshMessage(topic, payload));
    this.client.on('error', (err) => console.error('[mesh] broker error:', err.message));
    this.client.on('disconnect', () => console.warn('[mesh] lost the broker connection'));
    this.client.on('reconnecting', (delay) => {
      console.log(`[mesh] reconnecting to the broker in ${Math.round(delay / 1000)}s`);
    });

    // Anything said in a bridged room goes out over the radio.
    this.hub.onRoomMessage = (packet) => this._onRoomMessage(packet);

    this.client.connect();
  }

  /** One managed room per bridged channel, created if it is not there yet. */
  _ensureRooms() {
    for (const channel of this.opts.channels) {
      const roomId = this.opts.roomPrefix + channel.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      this.channelToRoom.set(channel, roomId);
      this.roomToChannel.set(roomId, channel);

      if (!this.rooms.exists(roomId)) {
        const result = this.rooms.create({
          name: `${channel} (mesh)`,
          topic: `Bridged to the Meshtastic channel "${channel}". Everything here goes out over the radio.`,
          owner: null,
          managed: roomId,
        });
        if (result.error) {
          console.error(`[mesh] could not create room for ${channel}: ${result.error}`);
        }
      }
    }
  }

  // --- mesh -> OpenICQ ------------------------------------------------------

  _onMeshMessage(topic, payload) {
    let packet;
    try {
      packet = JSON.parse(payload.toString('utf8'));
    } catch {
      this.stats.dropped++;
      return;
    }
    if (!packet || typeof packet !== 'object') return;

    // Learn node names so mesh senders show up as something readable.
    if (packet.type === 'nodeinfo' && packet.payload) {
      const id = packet.from;
      const name = packet.payload.shortname || packet.payload.longname;
      if (id && name) this.nodeNames.set(id, String(name).slice(0, 24));
      return;
    }

    if (packet.type !== 'text') return;

    const text = packet.payload && typeof packet.payload.text === 'string'
      ? packet.payload.text
      : typeof packet.payload === 'string'
        ? packet.payload
        : null;
    if (!text || !text.trim()) return;

    // Direct messages between nodes are not ours to publish into a room.
    if (typeof packet.to === 'number' && packet.to !== BROADCAST) {
      this.stats.dropped++;
      return;
    }

    // The channel name is the second-to-last segment of the topic.
    const segments = topic.split('/');
    const channel = segments[segments.length - 2];
    const roomId = this.channelToRoom.get(channel);
    if (!roomId || !this.rooms.exists(roomId)) {
      this.stats.dropped++;
      return;
    }

    const hex = nodeIdToHex(packet.from);
    const nick = this.nodeNames.get(packet.from) || hex || 'mesh node';

    this.stats.received++;
    this.hub.deliverRoomMessage({
      room: roomId,
      from: hex ? `mesh:${hex}` : 'mesh:unknown',
      fromNick: nick,
      body: text.slice(0, 500),
      // Marks where this came from, which is also what stops it being sent
      // straight back out to the radio.
      source: 'meshtastic',
    });
  }

  // --- OpenICQ -> mesh ------------------------------------------------------

  _onRoomMessage(packet) {
    // Never echo a mesh message back to the mesh.
    if (packet.source === 'meshtastic') return;

    const channel = this.roomToChannel.get(packet.room);
    if (!channel) return;

    const text = truncateUtf8(`${packet.fromNick}: ${packet.body}`, this.opts.maxTextBytes);
    const downlink = {
      from: this.opts.fromNode,
      type: 'sendtext',
      payload: text,
      channel: this.opts.channels.indexOf(channel),
    };

    const sent = this.client.publish(
      `${this.opts.root}/2/json/mqtt/`,
      JSON.stringify(downlink)
    );
    if (sent) this.stats.sent++;
    else this.stats.dropped++;
  }

  stop() {
    this.hub.onRoomMessage = null;
    this.client.end();
  }
}

/**
 * Read bridge settings from flags and the environment.
 * @returns {object|null} null when no broker was configured
 */
function configFromOptions({ host, port, username, password, root, channels, tls }) {
  if (!host) return null;
  return {
    host,
    port: port || (tls ? 8883 : 1883),
    tls: !!tls,
    username: username || null,
    password: password || null,
    root: root || DEFAULTS.root,
    channels: channels && channels.length ? channels : DEFAULTS.channels,
  };
}

module.exports = { MeshtasticBridge, configFromOptions, nodeIdToHex, truncateUtf8, DEFAULTS };
