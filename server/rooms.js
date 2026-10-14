'use strict';

/**
 * Chat rooms.
 *
 * Rooms are lightweight: a name, a topic, an owner, and whoever happens to be
 * in them. Membership is not persisted per user — you join a room for the
 * duration of a session, like an IRC channel, rather than accumulating a
 * subscription list. What *is* persisted is the room itself, so it survives a
 * restart, and its messages via the history log.
 *
 * Rooms whose id starts with "mesh:" are owned by the Meshtastic bridge; people
 * can talk in them but not delete them.
 */

const crypto = require('crypto');

const MAX_ROOMS = 200;
const MAX_NAME = 32;
const MIN_NAME = 2;
const MAX_TOPIC = 160;
const MAX_MEMBERS = 200;

/** Room ids are slugs, so they are safe in a storage key and readable in a URL. */
function slugify(name) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_NAME);
  return slug || crypto.randomBytes(4).toString('hex');
}

function isValidRoomId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9:-]{0,47}$/.test(value);
}

class Rooms {
  /**
   * @param {import('./store').Store} store  rooms live in the main database
   */
  constructor(store) {
    this.store = store;
    if (!store.db.rooms || typeof store.db.rooms !== 'object') {
      store.db.rooms = Object.create(null);
    }
    // Sessions currently in each room; rebuilt from scratch on every start.
    this.present = new Map(); // roomId -> Set<Session>
  }

  get all() {
    return Object.values(this.store.db.rooms);
  }

  get(roomId) {
    if (!isValidRoomId(roomId)) return null;
    return this.store.db.rooms[roomId] || null;
  }

  exists(roomId) {
    return !!this.get(roomId);
  }

  /**
   * @param {{name: string, topic?: string, owner: string, managed?: string}} spec
   * @returns {{room?: object, error?: string, code?: string}}
   */
  create({ name, topic = '', owner, managed = null }) {
    const clean = String(name || '').trim().slice(0, MAX_NAME);
    if (clean.length < MIN_NAME) {
      return { code: 'bad-room-name', error: `Room names need at least ${MIN_NAME} characters.` };
    }
    if (this.all.length >= MAX_ROOMS) {
      return { code: 'too-many-rooms', error: 'This server has all the rooms it can hold.' };
    }

    const id = managed ? managed : slugify(clean);
    if (!isValidRoomId(id)) {
      return { code: 'bad-room-name', error: 'That name cannot be used for a room.' };
    }
    if (this.store.db.rooms[id]) {
      return { code: 'room-exists', error: 'A room with that name already exists.' };
    }

    const room = {
      id,
      name: clean,
      topic: String(topic || '').slice(0, MAX_TOPIC),
      owner: owner || null,
      managed: managed ? 'meshtastic' : null,
      created: Date.now(),
    };
    this.store.db.rooms[id] = room;
    this.store.markDirty();
    return { room };
  }

  /** Remove a room. Bridge-managed rooms are not removable by users. */
  remove(roomId, byUin) {
    const room = this.get(roomId);
    if (!room) return { code: 'no-such-room', error: 'No such room.' };
    if (room.managed) {
      return { code: 'room-managed', error: 'That room belongs to a bridge and cannot be removed.' };
    }
    if (byUin && room.owner && room.owner !== byUin) {
      return { code: 'not-room-owner', error: 'Only the person who made the room can remove it.' };
    }
    delete this.store.db.rooms[roomId];
    this.present.delete(roomId);
    this.store.markDirty();
    return { ok: true };
  }

  setTopic(roomId, topic, byUin) {
    const room = this.get(roomId);
    if (!room) return { code: 'no-such-room', error: 'No such room.' };
    if (byUin && room.owner && room.owner !== byUin && !room.managed) {
      return { code: 'not-room-owner', error: 'Only the person who made the room can set the topic.' };
    }
    room.topic = String(topic || '').slice(0, MAX_TOPIC);
    this.store.markDirty();
    return { ok: true, room };
  }

  // --- presence -----------------------------------------------------------

  members(roomId) {
    return this.present.get(roomId) || null;
  }

  /** @returns {{ok?: true, code?: string, error?: string}} */
  join(roomId, session) {
    if (!this.exists(roomId)) return { code: 'no-such-room', error: 'No such room.' };
    let set = this.present.get(roomId);
    if (!set) {
      set = new Set();
      this.present.set(roomId, set);
    }
    if (set.size >= MAX_MEMBERS && !set.has(session)) {
      return { code: 'room-full', error: 'That room is full.' };
    }
    set.add(session);
    return { ok: true };
  }

  leave(roomId, session) {
    const set = this.present.get(roomId);
    if (!set) return;
    set.delete(session);
    if (!set.size) this.present.delete(roomId);
  }

  /** Drop a session from every room, for when a connection goes away. */
  leaveAll(session) {
    const left = [];
    for (const [roomId, set] of this.present) {
      if (set.delete(session)) left.push(roomId);
      if (!set.size) this.present.delete(roomId);
    }
    return left;
  }

  /** Distinct people in a room, rather than distinct connections. */
  occupants(roomId) {
    const set = this.present.get(roomId);
    if (!set) return [];
    const seen = new Map();
    for (const session of set) {
      if (!session.uin || seen.has(session.uin)) continue;
      seen.set(session.uin, { uin: session.uin, nick: session.user ? session.user.nick : `UIN ${session.uin}` });
    }
    return [...seen.values()];
  }

  occupantCount(roomId) {
    return this.occupants(roomId).length;
  }

  /** Room shaped for the client. */
  view(roomId) {
    const room = this.get(roomId);
    if (!room) return null;
    return {
      id: room.id,
      name: room.name,
      topic: room.topic,
      owner: room.owner,
      managed: room.managed,
      created: room.created,
      occupants: this.occupantCount(roomId),
    };
  }

  list() {
    return this.all
      .map((room) => this.view(room.id))
      .filter(Boolean)
      .sort((a, b) => b.occupants - a.occupants || a.name.localeCompare(b.name));
  }
}

module.exports = { Rooms, slugify, isValidRoomId, MAX_NAME, MIN_NAME, MAX_TOPIC };
