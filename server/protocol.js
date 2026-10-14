'use strict';

/**
 * OpenICQ session hub.
 *
 * Speaks a small JSON protocol over WebSocket, loosely modelled on the parts of
 * OSCAR that users actually noticed: UIN logins, a server-side contact list,
 * authorization requests, presence broadcast and store-and-forward messaging.
 */

const crypto = require('crypto');
const { STATUSES, normalizeProfile, isValidUin } = require('./store');
const { isValidRoomId, MAX_TOPIC } = require('./rooms');
const { dmKey, roomKey } = require('./history');
const kdf = require('./kdf');

const MAX_BODY = 4000;
const MAX_NICK = 24;
const MIN_NICK = 2;
const MIN_SEARCH = 2;
const MAX_CONTACTS = 500;
const MAX_JOINED_ROOMS = 30;
const HISTORY_PAGE = 200;
const RATE_BURST = 40;
const RATE_REFILL_PER_SEC = 8;

const VISIBLE_STATUSES = new Set(STATUSES.filter((s) => s !== 'offline'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Hub {
  constructor(store, options = {}) {
    this.store = store;
    this.limits = options.limits;
    this.history = options.history || null;
    this.rooms = options.rooms || null;
    this.sessions = new Map(); // uin -> Set<Session>
    this.allowRegistration = options.allowRegistration !== false;
    this.allowRoomCreation = options.allowRoomCreation !== false;
    this.motd = options.motd || '';
    this.announceUpdates = !!options.announceUpdates;
    this.updateStatus = null; // set by the update checker in index.js
    /** Set by the Meshtastic bridge so room messages can be relayed out. */
    this.onRoomMessage = null;
  }

  handleConnection(ws) {
    const session = new Session(this, ws);
    ws.sendJSON({
      t: 'hello',
      server: 'OpenICQ',
      version: require('../package.json').version,
      users: this.store.userCount,
      registration: this.allowRegistration,
      rooms: !!this.rooms,
      serverHistory: !!(this.history && this.history.enabled),
      motd: this.motd,
      // Only when the operator asked for it: by default a pending update is
      // the host's business, not every visitor's.
      update: this.announceUpdates && this.updateStatus ? this.updateStatus : undefined,
    });

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return session.fail('bad-json', 'Malformed packet.');
      }
      if (!msg || typeof msg.t !== 'string') return;
      session.dispatch(msg);
    });

    ws.on('close', () => session.onClose());
  }

  sessionsFor(uin) {
    if (!isValidUin(String(uin))) return null;
    return this.sessions.get(String(uin)) || null;
  }

  isOnline(uin) {
    const set = this.sessionsFor(uin);
    return !!(set && set.size);
  }

  /** Status as the rest of the world should see it (invisible reads as offline). */
  publicStatus(uin) {
    const set = this.sessionsFor(uin);
    if (!set || !set.size) return { status: 'offline', statusMessage: '' };

    // With several devices connected, the most "available" status wins.
    let best = null;
    for (const s of set) {
      if (s.status === 'invisible') continue;
      if (!best || STATUSES.indexOf(s.status) < STATUSES.indexOf(best.status)) best = s;
    }
    if (!best) return { status: 'offline', statusMessage: '' };
    return { status: best.status, statusMessage: best.statusMessage };
  }

  register(session) {
    let set = this.sessions.get(session.uin);
    if (!set) {
      set = new Set();
      this.sessions.set(session.uin, set);
    }
    set.add(session);
  }

  unregister(session) {
    const set = this.sessions.get(session.uin);
    if (!set) return;
    set.delete(session);
    if (!set.size) this.sessions.delete(session.uin);
  }

  sendTo(uin, payload) {
    const set = this.sessionsFor(uin);
    if (!set) return false;
    for (const s of set) s.ws.sendJSON(payload);
    return set.size > 0;
  }

  sendToOthers(session, payload) {
    const set = this.sessionsFor(session.uin);
    if (!set) return;
    for (const s of set) if (s !== session) s.ws.sendJSON(payload);
  }

  // --- rooms ---------------------------------------------------------------

  /** Send to everyone currently in a room, optionally skipping one session. */
  sendToRoom(roomId, payload, except = null) {
    if (!this.rooms) return 0;
    const set = this.rooms.members(roomId);
    if (!set) return 0;
    let sent = 0;
    for (const session of set) {
      if (session === except) continue;
      session.ws.sendJSON(payload);
      sent++;
    }
    return sent;
  }

  /** Tell a room its occupant list changed. */
  broadcastRoomPresence(roomId) {
    if (!this.rooms) return;
    this.sendToRoom(roomId, {
      t: 'room-presence',
      room: roomId,
      occupants: this.rooms.occupants(roomId),
    });
  }

  /**
   * Deliver a room message to everyone present, record it, and hand it to any
   * bridge that is listening.
   *
   * Used by both the `room-message` handler and the Meshtastic bridge, so
   * messages arriving from the mesh go through exactly the same path.
   *
   * @param {{room: string, from: string, fromNick: string, body: string, source?: string}} message
   */
  deliverRoomMessage({ room, from, fromNick, body, source = null }, except = null) {
    const packet = {
      id: crypto.randomUUID(),
      room,
      from,
      fromNick,
      body,
      ts: Date.now(),
    };
    if (source) packet.source = source;

    this.sendToRoom(room, { t: 'room-message', ...packet }, except);
    if (this.history) this.history.recordRoom(packet);
    if (this.onRoomMessage) {
      try {
        this.onRoomMessage(packet);
      } catch (err) {
        console.error('[protocol] room message relay failed:', err.message);
      }
    }
    return packet;
  }

  /** Tell everyone who has `user` on their list about a presence change. */
  broadcastPresence(uin) {
    const user = this.store.getUser(uin);
    if (!user) return;
    const presence = this.publicStatus(uin);

    for (const other of Object.values(this.store.db.users)) {
      if (other.uin === uin) continue;
      if (!this.store.hasContact(other, uin)) continue;
      if (!this.isOnline(other.uin)) continue;
      this.sendTo(other.uin, { t: 'presence', uin, ...presence });
    }
  }
}

class Session {
  constructor(hub, ws) {
    this.hub = hub;
    this.store = hub.store;
    this.ws = ws;
    this.ip = ws.remoteAddress;
    this.uin = null;
    this.user = null;
    this.status = 'offline';
    this.statusMessage = '';
    this.tokens = RATE_BURST;
    this.lastRefill = Date.now();
    this.authInFlight = false;
    this.joinedRooms = new Set();
  }

  get authed() {
    return this.user !== null;
  }

  fail(code, message) {
    this.ws.sendJSON({ t: 'error', code, message });
  }

  _spend(cost) {
    const now = Date.now();
    this.tokens = Math.min(
      RATE_BURST,
      this.tokens + ((now - this.lastRefill) / 1000) * RATE_REFILL_PER_SEC
    );
    this.lastRefill = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  dispatch(msg) {
    const handler = HANDLERS[msg.t];
    if (!handler) {
      if (!this._spend(1)) return this.fail('rate-limited', 'Slow down a moment.');
      return this.fail('unknown-packet', `Unsupported packet: ${msg.t}`);
    }
    if (!this._spend(handler.cost)) {
      return this.fail('rate-limited', 'Slow down a moment.');
    }
    if (handler.auth && !this.authed) return this.fail('not-signed-on', 'Sign on first.');

    let result;
    try {
      result = handler.run(this, msg);
    } catch (err) {
      return this._handlerError(msg.t, err);
    }
    if (result && typeof result.catch === 'function') {
      result.catch((err) => this._handlerError(msg.t, err));
    }
  }

  _handlerError(name, err) {
    if (err instanceof kdf.KdfBusyError) {
      return this.fail('busy', err.message);
    }
    console.error(`[protocol] ${name} failed:`, err);
    this.fail('server-error', 'The server could not process that.');
  }

  onClose() {
    if (!this.authed) return;

    // Drop out of every room first, then tell those rooms, otherwise the
    // occupant list still contains this connection.
    const left = this.hub.rooms ? this.hub.rooms.leaveAll(this) : [];
    this.joinedRooms.clear();

    this.user.lastSeen = Date.now();
    this.store.markDirty();
    this.hub.unregister(this);
    this.hub.broadcastPresence(this.uin);

    for (const roomId of left) this.hub.broadcastRoomPresence(roomId);
  }

  /** Contact-list entry shaped for the client. */
  contactView(uin) {
    const entry = this.store.getContact(this.user, uin);
    const other = this.store.getUser(uin);
    if (!other || !entry) return null;

    const presence = entry.authorized
      ? this.hub.publicStatus(uin)
      : { status: 'offline', statusMessage: '' };

    return {
      uin,
      nick: other.nick,
      firstName: other.firstName,
      lastName: other.lastName,
      group: entry.group || 'General',
      authorized: !!entry.authorized,
      lastSeen: other.lastSeen,
      ...presence,
    };
  }

  contactList() {
    return Object.keys(this.user.contacts)
      .map((uin) => this.contactView(uin))
      .filter(Boolean);
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const HANDLERS = Object.create(null);

/** `cost` is how many rate-limit tokens the packet burns; expensive work costs more. */
function handler(name, auth, run, { cost = 1 } = {}) {
  HANDLERS[name] = { auth, run, cost };
}

function clean(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

/** Read a UIN out of a packet, or null when it is not a well-formed UIN. */
function uinArg(value) {
  const raw = clean(value, 20);
  return isValidUin(raw) ? raw : null;
}

handler('ping', false, (s) => s.ws.sendJSON({ t: 'pong', ts: Date.now() }));

handler(
  'register',
  false,
  async (s, msg) => {
    if (!s.hub.allowRegistration) {
      return s.fail('registration-closed', 'This server is not accepting new UINs.');
    }
    if (s.hub.limits && !s.hub.limits.canRegister(s.ip)) {
      return s.fail('rate-limited', 'Too many new UINs from your address. Try again later.');
    }
    if (s.authInFlight) return s.fail('busy', 'Already working on that.');

    const nick = clean(msg.nick, MAX_NICK);
    const password = typeof msg.password === 'string' ? msg.password : '';

    if (nick.length < MIN_NICK) {
      return s.fail('bad-nick', `Nickname must be at least ${MIN_NICK} characters.`);
    }
    if (!/^[\w .'\-\u00c0-\u024f]+$/u.test(nick)) {
      return s.fail('bad-nick', 'Nickname contains unsupported characters.');
    }
    if (s.store.nickTaken(nick)) {
      return s.fail('nick-taken', 'That nickname is already registered.');
    }
    const badPassword = kdf.checkPassword(password);
    if (badPassword) return s.fail('bad-password', badPassword);

    s.authInFlight = true;
    try {
      // Re-check under the await: another packet may have taken the nick.
      if (s.store.nickTaken(nick)) {
        return s.fail('nick-taken', 'That nickname is already registered.');
      }
      const user = await s.store.createUser({
        nick,
        password,
        email: clean(msg.email, 120),
        firstName: clean(msg.firstName, 40),
        lastName: clean(msg.lastName, 40),
        profile: msg.profile,
      });

      if (s.hub.limits) s.hub.limits.noteRegistration(s.ip);
      console.log(`[openicq] new UIN ${user.uin} (${user.nick}) from ${s.ip}`);
      s.ws.sendJSON({ t: 'registered', uin: user.uin, nick: user.nick });
    } finally {
      s.authInFlight = false;
    }
  },
  { cost: 8 }
);

handler(
  'login',
  false,
  async (s, msg) => {
    if (s.authed) return s.fail('already-signed-on', 'This connection is already signed on.');
    if (s.authInFlight) return s.fail('busy', 'A sign-on attempt is already in progress.');

    const identifier = clean(msg.uin, 64);
    const password = typeof msg.password === 'string' ? msg.password : '';
    const limits = s.hub.limits;

    if (limits && limits.loginBlocked(s.ip, identifier.toLowerCase())) {
      return s.fail('rate-limited', 'Too many failed sign-on attempts. Try again later.');
    }

    s.authInFlight = true;
    try {
      const user = isValidUin(identifier)
        ? s.store.getUser(identifier)
        : s.store.findByNick(identifier);

      // Back off before answering, so guessing costs real time even across
      // fresh connections. verifyPassword hashes either way, so a missing
      // account is indistinguishable from a wrong password.
      const delay = limits ? limits.loginDelay(s.ip, identifier.toLowerCase()) : 0;
      if (delay) await sleep(delay);
      if (s.ws.readyState !== 'open') return;

      const ok = await s.store.verifyPassword(user, password);
      if (s.ws.readyState !== 'open') return;

      if (!user || !ok) {
        if (limits) limits.noteLoginFailure(s.ip, identifier.toLowerCase());
        return s.fail('bad-credentials', 'Wrong UIN or password.');
      }
      if (limits) limits.noteLoginSuccess(s.ip, identifier.toLowerCase());

      // The connection may have signed on while we were hashing.
      if (s.authed) return;

      s.uin = user.uin;
      s.user = user;
      s.status = VISIBLE_STATUSES.has(msg.status) ? msg.status : 'online';
      s.statusMessage = clean(msg.statusMessage, 120);
      user.lastSeen = Date.now();
      s.store.markDirty();
      s.hub.register(s);

      const pending = Object.entries(user.pendingAuth).map(([from, info]) => ({
        from,
        nick: s.store.getUser(from)?.nick || `UIN ${from}`,
        reason: info.reason,
        ts: info.ts,
      }));

      s.ws.sendJSON({
        t: 'welcome',
        user: publicUser(user, true),
        status: s.status,
        statusMessage: s.statusMessage,
        contacts: s.contactList(),
        pendingAuth: pending,
      });

      for (const message of s.store.drainOffline(user)) {
        s.ws.sendJSON({ t: 'message', ...message, offline: true });
      }

      s.hub.broadcastPresence(s.uin);
      console.log(`[openicq] ${user.nick} (${user.uin}) signed on as ${s.status}`);
    } finally {
      s.authInFlight = false;
    }
  },
  { cost: 8 }
);

handler('set-status', true, (s, msg) => {
  if (!VISIBLE_STATUSES.has(msg.status)) return s.fail('bad-status', 'Unknown status.');
  s.status = msg.status;
  s.statusMessage = clean(msg.statusMessage, 120);
  s.user.status = msg.status;
  s.store.markDirty();

  s.ws.sendJSON({ t: 'status-changed', status: s.status, statusMessage: s.statusMessage });
  s.hub.sendToOthers(s, { t: 'status-changed', status: s.status, statusMessage: s.statusMessage });
  s.hub.broadcastPresence(s.uin);
});

handler('logout', true, (s) => {
  s.ws.sendJSON({ t: 'signed-off' });
  s.onClose();
  s.user = null;
  s.uin = null;
});

handler(
  'search',
  true,
  (s, msg) => {
    const query = clean(msg.query, 64);
    if (query.length < MIN_SEARCH) {
      return s.fail('bad-query', `Search for at least ${MIN_SEARCH} characters.`);
    }
    const results = s.store
      .search(query)
      .filter((u) => u.uin !== s.uin)
      .map((u) => ({
        ...publicUser(u, false),
        status: s.hub.publicStatus(u.uin).status,
        onList: s.store.hasContact(s.user, u.uin),
      }));
    s.ws.sendJSON({ t: 'search-result', query, results });
  },
  { cost: 4 }
);

handler('get-info', true, (s, msg) => {
  const uin = uinArg(msg.uin);
  const target = uin && s.store.getUser(uin);
  if (!target) return s.fail('no-such-user', 'No such UIN.');
  s.ws.sendJSON({
    t: 'user-info',
    user: { ...publicUser(target, false), ...s.hub.publicStatus(target.uin) },
  });
});

handler('add-contact', true, (s, msg) => {
  const uin = uinArg(msg.uin);
  const target = uin && s.store.getUser(uin);

  if (!target) return s.fail('no-such-user', 'No such UIN.');
  if (uin === s.uin) return s.fail('bad-contact', 'You cannot add yourself.');
  if (s.store.hasContact(s.user, uin)) return s.fail('already-contact', 'Already on your list.');
  if (Object.keys(s.user.contacts).length >= MAX_CONTACTS) {
    return s.fail('list-full', 'Your contact list is full.');
  }

  const reason = clean(msg.reason, 200);
  // Mutual adds skip the dance: if they already have me, we are both authorized.
  const mutual = s.store.hasContact(target, s.uin);
  const authorized = mutual || !target.requireAuth;

  s.store.addContact(s.user, uin, { authorized, group: clean(msg.group, 32) || 'General' });

  if (mutual && !target.contacts[s.uin].authorized) {
    target.contacts[s.uin].authorized = true;
    s.store.markDirty();
    s.hub.sendTo(uin, { t: 'auth-result', uin: s.uin, accepted: true });
    s.hub.broadcastPresence(s.uin);
  }

  s.ws.sendJSON({ t: 'contact-added', contact: s.contactView(uin), pendingAuth: !authorized });

  if (!authorized) {
    target.pendingAuth[s.uin] = { reason, ts: Date.now() };
    s.store.markDirty();
    s.hub.sendTo(uin, {
      t: 'auth-request',
      from: s.uin,
      nick: s.user.nick,
      reason,
      ts: Date.now(),
    });
  } else {
    s.hub.broadcastPresence(uin);
  }
});

handler('auth-response', true, (s, msg) => {
  const uin = uinArg(msg.uin);
  if (!uin || !s.store.hasPendingAuth(s.user, uin)) {
    return s.fail('no-request', 'No such authorization request.');
  }

  const accepted = !!msg.accept;
  delete s.user.pendingAuth[uin];

  const requester = s.store.getUser(uin);
  if (requester && s.store.hasContact(requester, s.uin)) {
    requester.contacts[s.uin].authorized = accepted;
    if (!accepted) delete requester.contacts[s.uin];
  }
  s.store.markDirty();

  s.ws.sendJSON({ t: 'auth-handled', uin, accepted });
  s.hub.sendToOthers(s, { t: 'auth-handled', uin, accepted });
  s.hub.sendTo(uin, { t: 'auth-result', uin: s.uin, nick: s.user.nick, accepted });

  if (accepted) {
    s.hub.broadcastPresence(s.uin);
    if (s.store.hasContact(s.user, uin)) {
      s.ws.sendJSON({ t: 'contact-update', contact: s.contactView(uin) });
    }
  }
});

handler('remove-contact', true, (s, msg) => {
  const uin = uinArg(msg.uin);
  if (!uin || !s.store.hasContact(s.user, uin)) {
    return s.fail('no-such-contact', 'Not on your list.');
  }
  s.store.removeContact(s.user, uin);
  s.ws.sendJSON({ t: 'contact-removed', uin });
  s.hub.sendToOthers(s, { t: 'contact-removed', uin });
});

handler('message', true, (s, msg) => {
  const to = uinArg(msg.to);
  const body = clean(msg.body, MAX_BODY);
  const ref = clean(msg.id, 40) || crypto.randomUUID();

  if (!body) return;
  const target = to && s.store.getUser(to);
  if (!target) return s.fail('no-such-user', 'No such UIN.');

  // ICQ let anyone message anyone; we only require that the sender knows the UIN.
  const packet = {
    id: crypto.randomUUID(),
    from: s.uin,
    fromNick: s.user.nick,
    to,
    body,
    ts: Date.now(),
  };

  const visibleStatus = s.hub.publicStatus(to).status;
  const deliveredLive = s.hub.sendTo(to, { t: 'message', ...packet, offline: false });
  if (!deliveredLive) s.store.queueOffline(target, packet);

  // Recorded whether or not it was delivered live, so both sides see the same
  // conversation when they next ask for it.
  if (s.hub.history) s.hub.history.recordDirect(packet);

  // An invisible recipient must look exactly like an absent one, so the ack
  // reports what the sender is allowed to know, not what actually happened.
  const visible = visibleStatus !== 'offline';

  // Keep the sender's other devices in sync with what they just said.
  s.hub.sendToOthers(s, { t: 'message-echo', ...packet });
  s.ws.sendJSON({
    t: 'ack',
    ref,
    id: packet.id,
    to,
    ts: packet.ts,
    state: visible && deliveredLive ? 'delivered' : 'queued',
    targetStatus: visible ? visibleStatus : 'offline',
  });
});

handler('typing', true, (s, msg) => {
  const to = uinArg(msg.to);
  if (!to || !s.hub.isOnline(to)) return;
  s.hub.sendTo(to, { t: 'typing', from: s.uin, state: msg.state === 'start' ? 'start' : 'stop' });
});

handler('update-profile', true, (s, msg) => {
  // Validate the nickname before touching anything, so a rejected rename does
  // not leave half the profile updated.
  const nick = clean(msg.nick, MAX_NICK);
  const renaming = nick && nick.toLowerCase() !== s.user.nick.toLowerCase();
  if (nick && nick.length < MIN_NICK) {
    return s.fail('bad-nick', `Nickname must be at least ${MIN_NICK} characters.`);
  }
  if (nick && !/^[\w .'\-\u00c0-\u024f]+$/u.test(nick)) {
    return s.fail('bad-nick', 'Nickname contains unsupported characters.');
  }
  if (renaming && s.store.nickTaken(nick)) {
    return s.fail('nick-taken', 'That nickname is taken.');
  }

  s.user.firstName = clean(msg.firstName, 40);
  s.user.lastName = clean(msg.lastName, 40);
  s.user.email = clean(msg.email, 120);
  s.user.profile = normalizeProfile(msg.profile);
  if (typeof msg.requireAuth === 'boolean') s.user.requireAuth = msg.requireAuth;

  if (nick && nick !== s.user.nick) {
    s.store.nickIndex.delete(s.user.nick.toLowerCase());
    s.user.nick = nick;
    s.store.nickIndex.set(nick.toLowerCase(), s.uin);
  }

  s.store.markDirty();
  s.ws.sendJSON({ t: 'profile-updated', user: publicUser(s.user, true) });
  s.hub.broadcastPresence(s.uin);
});

handler(
  'change-password',
  true,
  async (s, msg) => {
    if (s.authInFlight) return s.fail('busy', 'Already working on that.');
    const next = typeof msg.next === 'string' ? msg.next : '';
    const badPassword = kdf.checkPassword(next);
    if (badPassword) return s.fail('bad-password', badPassword);

    s.authInFlight = true;
    try {
      const current = typeof msg.current === 'string' ? msg.current : '';
      if (!(await s.store.verifyPassword(s.user, current))) {
        return s.fail('bad-credentials', 'Current password is wrong.');
      }
      await s.store.setPassword(s.user, next);
      s.ws.sendJSON({ t: 'password-changed' });
    } finally {
      s.authInFlight = false;
    }
  },
  { cost: 8 }
);

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

handler(
  'get-history',
  true,
  (s, msg) => {
    if (!s.hub.history || !s.hub.history.enabled) {
      return s.fail('no-history', 'This server does not keep message history.');
    }

    const limit = Math.min(Number(msg.limit) || 100, HISTORY_PAGE);
    const before = Number(msg.before) || 0;

    if (msg.room !== undefined) {
      const room = clean(msg.room, 48);
      if (!isValidRoomId(room) || !s.hub.rooms || !s.hub.rooms.exists(room)) {
        return s.fail('no-such-room', 'No such room.');
      }
      return s.ws.sendJSON({
        t: 'history',
        room,
        entries: s.hub.history.readRoom(room, { limit, before }),
      });
    }

    const withUin = uinArg(msg.with);
    if (!withUin) return s.fail('no-such-user', 'No such UIN.');
    s.ws.sendJSON({
      t: 'history',
      with: withUin,
      entries: s.hub.history.readDirect(s.uin, withUin, { limit, before }),
    });
  },
  { cost: 3 }
);

handler('clear-history', true, (s, msg) => {
  if (!s.hub.history || !s.hub.history.enabled) {
    return s.fail('no-history', 'This server does not keep message history.');
  }
  const withUin = uinArg(msg.with);
  if (!withUin) return s.fail('no-such-user', 'No such UIN.');

  // Both people share one conversation, so this clears it for them too. Say so
  // plainly rather than pretending it is private to the caller.
  s.hub.history.forgetDirect(s.uin, withUin);
  s.ws.sendJSON({ t: 'history-cleared', with: withUin });
  s.hub.sendTo(withUin, { t: 'history-cleared', with: s.uin, by: s.uin });
});

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

/** Rooms are optional; every handler below needs them switched on. */
function roomsOrFail(s) {
  if (!s.hub.rooms) {
    s.fail('no-rooms', 'This server does not have chat rooms.');
    return null;
  }
  return s.hub.rooms;
}

handler(
  'list-rooms',
  true,
  (s) => {
    const rooms = roomsOrFail(s);
    if (!rooms) return;
    s.ws.sendJSON({ t: 'room-list', rooms: rooms.list(), canCreate: s.hub.allowRoomCreation });
  },
  { cost: 2 }
);

handler(
  'create-room',
  true,
  (s, msg) => {
    const rooms = roomsOrFail(s);
    if (!rooms) return;
    if (!s.hub.allowRoomCreation) {
      return s.fail('rooms-closed', 'This server is not accepting new rooms.');
    }

    const result = rooms.create({
      name: clean(msg.name, 32),
      topic: clean(msg.topic, MAX_TOPIC),
      owner: s.uin,
    });
    if (result.error) return s.fail(result.code, result.error);

    console.log(`[openicq] ${s.user.nick} created room "${result.room.name}" (${result.room.id})`);
    s.ws.sendJSON({ t: 'room-created', room: rooms.view(result.room.id) });

    // Everyone browsing the room list wants to know.
    for (const set of s.hub.sessions.values()) {
      for (const other of set) {
        if (other !== s) other.ws.sendJSON({ t: 'room-added', room: rooms.view(result.room.id) });
      }
    }
  },
  { cost: 5 }
);

handler('join-room', true, (s, msg) => {
  const rooms = roomsOrFail(s);
  if (!rooms) return;

  const roomId = clean(msg.room, 48);
  if (!isValidRoomId(roomId)) return s.fail('no-such-room', 'No such room.');
  if (s.joinedRooms.size >= MAX_JOINED_ROOMS && !s.joinedRooms.has(roomId)) {
    return s.fail('too-many-rooms', 'You are in as many rooms as this server allows.');
  }

  const result = rooms.join(roomId, s);
  if (result.error) return s.fail(result.code, result.error);
  s.joinedRooms.add(roomId);

  s.ws.sendJSON({
    t: 'room-joined',
    room: rooms.view(roomId),
    occupants: rooms.occupants(roomId),
    history: s.hub.history ? s.hub.history.readRoom(roomId, { limit: 100 }) : [],
  });

  s.hub.sendToRoom(roomId, { t: 'room-entered', room: roomId, uin: s.uin, nick: s.user.nick }, s);
  s.hub.broadcastRoomPresence(roomId);
});

handler('leave-room', true, (s, msg) => {
  const rooms = roomsOrFail(s);
  if (!rooms) return;

  const roomId = clean(msg.room, 48);
  if (!s.joinedRooms.has(roomId)) return s.fail('not-in-room', 'You are not in that room.');

  rooms.leave(roomId, s);
  s.joinedRooms.delete(roomId);

  s.ws.sendJSON({ t: 'room-left', room: roomId });
  s.hub.sendToRoom(roomId, { t: 'room-exited', room: roomId, uin: s.uin, nick: s.user.nick });
  s.hub.broadcastRoomPresence(roomId);
});

handler('room-message', true, (s, msg) => {
  const rooms = roomsOrFail(s);
  if (!rooms) return;

  const roomId = clean(msg.room, 48);
  const body = clean(msg.body, MAX_BODY);
  const ref = clean(msg.id, 40) || crypto.randomUUID();

  if (!body) return;
  if (!s.joinedRooms.has(roomId)) return s.fail('not-in-room', 'Join the room first.');
  if (!rooms.exists(roomId)) return s.fail('no-such-room', 'No such room.');

  // The sender's own window already shows the line, so skip them on the
  // broadcast and acknowledge instead.
  const packet = s.hub.deliverRoomMessage(
    { room: roomId, from: s.uin, fromNick: s.user.nick, body },
    s
  );

  s.ws.sendJSON({ t: 'room-ack', ref, id: packet.id, room: roomId, ts: packet.ts });
});

handler('set-room-topic', true, (s, msg) => {
  const rooms = roomsOrFail(s);
  if (!rooms) return;

  const roomId = clean(msg.room, 48);
  const result = rooms.setTopic(roomId, clean(msg.topic, MAX_TOPIC), s.uin);
  if (result.error) return s.fail(result.code, result.error);

  s.hub.sendToRoom(roomId, { t: 'room-topic', room: roomId, topic: result.room.topic, by: s.user.nick });
  s.ws.sendJSON({ t: 'room-topic', room: roomId, topic: result.room.topic, by: s.user.nick });
});

handler('remove-room', true, (s, msg) => {
  const rooms = roomsOrFail(s);
  if (!rooms) return;

  const roomId = clean(msg.room, 48);
  const result = rooms.remove(roomId, s.uin);
  if (result.error) return s.fail(result.code, result.error);

  s.hub.sendToRoom(roomId, { t: 'room-removed', room: roomId });
  for (const set of s.hub.sessions.values()) {
    for (const other of set) other.ws.sendJSON({ t: 'room-removed', room: roomId });
  }
});

handler('room-typing', true, (s, msg) => {
  if (!s.hub.rooms) return;
  const roomId = clean(msg.room, 48);
  if (!s.joinedRooms.has(roomId)) return;
  s.hub.sendToRoom(
    roomId,
    { t: 'room-typing', room: roomId, from: s.uin, nick: s.user.nick, state: msg.state === 'start' ? 'start' : 'stop' },
    s
  );
});

function publicUser(user, self) {
  const view = {
    uin: user.uin,
    nick: user.nick,
    firstName: user.firstName,
    lastName: user.lastName,
    profile: user.profile,
    created: user.created,
    lastSeen: user.lastSeen,
  };
  if (self) {
    view.email = user.email;
    view.requireAuth = user.requireAuth;
  }
  return view;
}

module.exports = { Hub };
