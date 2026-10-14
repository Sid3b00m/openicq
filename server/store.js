'use strict';

/**
 * Flat-file account store.
 *
 * The whole database lives in memory and is flushed to a single JSON file with
 * debounced atomic writes. ICQ-scale this is not, but it keeps the server a
 * dependency-free single process that anyone can run and back up with `cp`.
 *
 * Every lookup map here has a null prototype. A plain `{}` would answer to
 * "constructor", "__proto__" and friends as if they were registered UINs.
 */

const fs = require('fs');
const path = require('path');

const kdf = require('./kdf');

const FIRST_UIN = 100000;
const MAX_OFFLINE_MESSAGES = 500;
const FLUSH_DELAY_MS = 400;
const UIN_PATTERN = /^[1-9][0-9]{0,17}$/;

const STATUSES = ['online', 'ffc', 'away', 'na', 'occupied', 'dnd', 'invisible', 'offline'];

/** UINs are plain positive integers; anything else is not a UIN. */
function isValidUin(value) {
  return typeof value === 'string' && UIN_PATTERN.test(value);
}

/** Copy own enumerable keys into a null-prototype object, dropping unsafe ones. */
function toSafeMap(source) {
  const out = Object.create(null);
  if (!source || typeof source !== 'object') return out;
  for (const key of Object.getOwnPropertyNames(source)) {
    if (key === '__proto__') continue;
    out[key] = source[key];
  }
  return out;
}

class Store {
  constructor(file) {
    this.file = file;
    this.db = {
      version: 1,
      nextUin: FIRST_UIN,
      users: Object.create(null),
      rooms: Object.create(null),
    };
    this.nickIndex = new Map(); // lowercase nick -> uin
    this._flushTimer = null;
    this._writing = false;
    this._dirty = false;
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.users) {
        this.db.version = parsed.version || 1;
        this.db.nextUin = Number(parsed.nextUin) || FIRST_UIN;
        this.db.users = toSafeMap(parsed.users);
        if (parsed.rooms && typeof parsed.rooms === 'object') {
          this.db.rooms = toSafeMap(parsed.rooms);
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[store] could not read ${this.file}: ${err.message}`);
        console.error('[store] refusing to start so an existing database is not overwritten');
        process.exit(1);
      }
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
    }

    for (const uin of Object.keys(this.db.users)) {
      if (!isValidUin(uin)) {
        console.error(`[store] ignoring entry with invalid UIN ${JSON.stringify(uin)}`);
        delete this.db.users[uin];
        continue;
      }
      const user = this.db.users[uin];
      user.contacts = toSafeMap(user.contacts);
      user.pendingAuth = toSafeMap(user.pendingAuth);
      if (!Array.isArray(user.offline)) user.offline = [];
      this.nickIndex.set(user.nick.toLowerCase(), user.uin);
    }
  }

  markDirty() {
    this._dirty = true;
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush();
    }, FLUSH_DELAY_MS);
    if (this._flushTimer.unref) this._flushTimer.unref();
  }

  flush() {
    if (this._writing || !this._dirty) return;
    this._writing = true;
    this._dirty = false;

    const tmp = `${this.file}.${process.pid}.tmp`;
    const payload = JSON.stringify(this.db);
    fs.writeFile(tmp, payload, { mode: 0o600 }, (err) => {
      if (err) {
        this._writing = false;
        this._dirty = true;
        console.error('[store] write failed:', err.message);
        return;
      }
      fs.rename(tmp, this.file, (renameErr) => {
        this._writing = false;
        if (renameErr) {
          this._dirty = true;
          console.error('[store] rename failed:', renameErr.message);
        } else if (this._dirty) {
          this.markDirty();
        }
      });
    });
  }

  flushSync() {
    if (!this._dirty) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.db), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this._dirty = false;
    } catch (err) {
      console.error('[store] final write failed:', err.message);
    }
  }

  // --- accounts -----------------------------------------------------------

  nickTaken(nick) {
    return this.nickIndex.has(String(nick).toLowerCase());
  }

  getUser(uin) {
    if (!isValidUin(uin)) return null;
    return this.db.users[uin] || null;
  }

  findByNick(nick) {
    const uin = this.nickIndex.get(String(nick).toLowerCase());
    return uin ? this.getUser(uin) : null;
  }

  async createUser({ nick, password, email, firstName, lastName, profile }) {
    const uin = String(this.db.nextUin++);
    const { salt, hash } = await kdf.hashPassword(password);

    const user = {
      uin,
      nick,
      firstName: firstName || '',
      lastName: lastName || '',
      email: email || '',
      salt,
      hash,
      created: Date.now(),
      lastSeen: 0,
      status: 'offline',
      statusMessage: '',
      profile: normalizeProfile(profile),
      contacts: Object.create(null), // uin -> { added, authorized, group }
      pendingAuth: Object.create(null), // uin -> { reason, ts }  (requests waiting on *me*)
      offline: [], // queued messages
      requireAuth: true,
      hideIp: true,
    };

    this.db.users[uin] = user;
    this.nickIndex.set(nick.toLowerCase(), uin);
    this.markDirty();
    return user;
  }

  /** @returns {Promise<boolean>} */
  verifyPassword(user, password) {
    return kdf.verifyPassword(user, password);
  }

  async setPassword(user, password) {
    const { salt, hash } = await kdf.hashPassword(password);
    user.salt = salt;
    user.hash = hash;
    this.markDirty();
  }

  // --- contacts -----------------------------------------------------------

  hasContact(user, targetUin) {
    return isValidUin(targetUin) && Object.hasOwn(user.contacts, targetUin);
  }

  getContact(user, targetUin) {
    return this.hasContact(user, targetUin) ? user.contacts[targetUin] : null;
  }

  hasPendingAuth(user, fromUin) {
    return isValidUin(fromUin) && Object.hasOwn(user.pendingAuth, fromUin);
  }

  addContact(user, targetUin, { authorized = false, group = 'General' } = {}) {
    if (!isValidUin(targetUin)) return null;
    if (!user.contacts[targetUin]) {
      user.contacts[targetUin] = { added: Date.now(), authorized, group };
    } else if (authorized) {
      user.contacts[targetUin].authorized = true;
    }
    this.markDirty();
    return user.contacts[targetUin];
  }

  removeContact(user, targetUin) {
    delete user.contacts[targetUin];
    delete user.pendingAuth[targetUin];
    this.markDirty();
  }

  // --- offline messages ---------------------------------------------------

  queueOffline(user, message) {
    user.offline.push(message);
    if (user.offline.length > MAX_OFFLINE_MESSAGES) {
      user.offline.splice(0, user.offline.length - MAX_OFFLINE_MESSAGES);
    }
    this.markDirty();
  }

  drainOffline(user) {
    if (!user.offline.length) return [];
    const messages = user.offline;
    user.offline = [];
    this.markDirty();
    return messages;
  }

  /**
   * Directory search across nick, name and exact UIN.
   *
   * Email is deliberately not searchable: matching on it would turn the
   * directory into an oracle for "is this address registered here?".
   */
  search(query, limit = 40) {
    const q = String(query).trim().toLowerCase();
    if (!q) return [];

    const results = [];
    const exact = isValidUin(q) ? this.getUser(q) : null;
    if (exact) results.push(exact);

    for (const user of Object.values(this.db.users)) {
      if (results.length >= limit) break;
      if (exact && user.uin === exact.uin) continue;

      const haystack = [user.nick, user.firstName, user.lastName].join(' ').toLowerCase();
      if (haystack.includes(q)) results.push(user);
    }
    return results;
  }

  get userCount() {
    return Object.keys(this.db.users).length;
  }
}

function normalizeProfile(profile = {}) {
  if (!profile || typeof profile !== 'object') profile = {};
  const str = (v, max) => String(v == null ? '' : v).slice(0, max);
  return {
    age: str(profile.age, 3),
    gender: str(profile.gender, 16),
    city: str(profile.city, 64),
    country: str(profile.country, 64),
    homepage: str(profile.homepage, 160),
    about: str(profile.about, 1000),
  };
}

module.exports = { Store, STATUSES, normalizeProfile, isValidUin, FIRST_UIN };
