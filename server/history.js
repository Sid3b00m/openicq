'use strict';

/**
 * Server-side message history.
 *
 * Kept out of the main JSON database deliberately: that file is held in memory
 * and rewritten whole on every flush, so putting message bodies in it would
 * mean rewriting megabytes every few hundred milliseconds. This is an
 * append-only JSON-lines log instead, which costs one write per message, with
 * an in-memory index of the recent tail of each conversation for fast reads.
 *
 * The operator decides whether any of this is kept at all; with history off,
 * nothing is written and nothing is indexed.
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  enabled: true,
  // Per conversation, how much is kept and served.
  maxPerConversation: 500,
  maxAgeDays: 0, // 0 = forever
  // Rewrite the log once this many dead lines have accumulated.
  compactAfter: 5000,
};

/** How long a batch of messages may sit in memory before it is written. */
const FLUSH_MS = 250;

/** Conversation key for a direct message, stable whichever way it was sent. */
function dmKey(a, b) {
  return 'dm:' + [String(a), String(b)].sort().join(':');
}

function roomKey(roomId) {
  return 'room:' + String(roomId);
}

class History {
  /**
   * @param {Partial<typeof DEFAULTS> & {file: string}} options
   */
  constructor(options = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.file = options.file;
    this.index = new Map(); // conversation key -> entries[]
    this.lineCount = 0;
    this.deadLines = 0;
    this.pending = [];
    this.writing = false;
    this._flushTimer = null;
    this.compacting = false;

    if (this.opts.enabled) this._load();
  }

  get enabled() {
    return this.opts.enabled;
  }

  _cutoff() {
    if (!this.opts.maxAgeDays) return 0;
    return Date.now() - this.opts.maxAgeDays * 86400_000;
  }

  _load() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });

    let raw = '';
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[history] could not read ${this.file}: ${err.message}`);
      }
    }

    const cutoff = this._cutoff();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      this.lineCount++;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        // A torn final line from an unclean shutdown: skip it.
        this.deadLines++;
        continue;
      }
      if (!entry || !entry.k || typeof entry.ts !== 'number') {
        this.deadLines++;
        continue;
      }
      if (cutoff && entry.ts < cutoff) {
        this.deadLines++;
        continue;
      }
      // A tombstone cancels everything recorded for that conversation before
      // it, which is how a cleared conversation stays cleared across restarts.
      if (entry.tombstone) {
        const existing = this.index.get(entry.k);
        if (existing) this.deadLines += existing.length;
        this.index.delete(entry.k);
        this.deadLines++;
        continue;
      }
      this._remember(entry);
    }

    const conversations = this.index.size;
    if (this.lineCount) {
      console.log(
        `[history] ${this.lineCount} message${this.lineCount === 1 ? '' : 's'} across ` +
          `${conversations} conversation${conversations === 1 ? '' : 's'}`
      );
    }
    if (this.deadLines > this.opts.compactAfter) this.compact();
  }

  /** Add to the in-memory tail, trimming to the per-conversation cap. */
  _remember(entry) {
    let list = this.index.get(entry.k);
    if (!list) {
      list = [];
      this.index.set(entry.k, list);
    }
    list.push(entry);
    if (list.length > this.opts.maxPerConversation) {
      const dropped = list.length - this.opts.maxPerConversation;
      list.splice(0, dropped);
      this.deadLines += dropped;
    }
  }

  /**
   * Queue a line for the log.
   *
   * Batched behind a short timer rather than written straight through: a busy
   * server would otherwise do a syscall per message. The pending batch is
   * flushed synchronously on shutdown, so nothing is lost between ticks.
   */
  _write(entry) {
    this.pending.push(JSON.stringify(entry) + '\n');
    this.lineCount++;
    if (this.pending.length >= 64) {
      this.flushSync();
      return;
    }
    if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => this._flushAsync(), FLUSH_MS);
      if (this._flushTimer.unref) this._flushTimer.unref();
    }
  }

  _flushAsync() {
    this._flushTimer = null;
    if (!this.pending.length || this.writing) return;
    const batch = this.pending.join('');
    this.pending.length = 0;
    this.writing = true;
    fs.appendFile(this.file, batch, { mode: 0o600 }, (err) => {
      this.writing = false;
      if (err) {
        console.error('[history] write failed:', err.message);
        // Put it back at the front so the next flush retries it.
        this.pending.unshift(batch);
      } else if (this.pending.length) {
        this._flushAsync();
      }
    });
  }

  /** Write anything queued right now, blocking until it is on disk. */
  flushSync() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (!this.pending.length) return;
    const batch = this.pending.join('');
    this.pending.length = 0;
    try {
      fs.appendFileSync(this.file, batch, { mode: 0o600 });
    } catch (err) {
      console.error('[history] write failed:', err.message);
    }
  }

  /**
   * Record a direct message.
   * @param {{id: string, from: string, to: string, body: string, ts: number}} message
   */
  recordDirect(message) {
    if (!this.opts.enabled) return;
    const entry = {
      k: dmKey(message.from, message.to),
      id: message.id,
      from: message.from,
      to: message.to,
      body: message.body,
      ts: message.ts,
    };
    this._remember(entry);
    this._write(entry);
  }

  /**
   * Record a room message.
   * @param {{id: string, room: string, from: string, fromNick: string, body: string, ts: number, source?: string}} message
   */
  recordRoom(message) {
    if (!this.opts.enabled) return;
    const entry = {
      k: roomKey(message.room),
      id: message.id,
      room: message.room,
      from: message.from,
      nick: message.fromNick,
      body: message.body,
      ts: message.ts,
    };
    if (message.source) entry.src = message.source;
    this._remember(entry);
    this._write(entry);
  }

  /**
   * Most recent messages in a conversation, oldest first.
   *
   * @param {string} key  from dmKey() or roomKey()
   * @param {{limit?: number, before?: number}} [options]
   */
  read(key, { limit = 100, before = 0 } = {}) {
    if (!this.opts.enabled) return [];
    const list = this.index.get(key);
    if (!list) return [];

    const cutoff = this._cutoff();
    let entries = list;
    if (cutoff) entries = entries.filter((e) => e.ts >= cutoff);
    if (before) entries = entries.filter((e) => e.ts < before);

    const take = Math.max(1, Math.min(Number(limit) || 100, this.opts.maxPerConversation));
    return entries.slice(-take);
  }

  readDirect(a, b, options) {
    return this.read(dmKey(a, b), options);
  }

  readRoom(roomId, options) {
    return this.read(roomKey(roomId), options);
  }

  /** Forget one conversation entirely. */
  forget(key) {
    if (!this.index.has(key)) return false;
    this.deadLines += this.index.get(key).length;
    this.index.delete(key);
    this._write({ k: key, ts: Date.now(), tombstone: true });
    if (this.deadLines > this.opts.compactAfter) this.compact();
    return true;
  }

  forgetDirect(a, b) {
    return this.forget(dmKey(a, b));
  }

  /**
   * Rewrite the log from the in-memory index, dropping everything expired,
   * trimmed away or tombstoned.
   */
  compact() {
    if (!this.opts.enabled || this.compacting) return;
    this.compacting = true;
    this.flushSync();

    const tmp = `${this.file}.${process.pid}.compact`;
    const entries = [];
    for (const list of this.index.values()) entries.push(...list);
    entries.sort((a, b) => a.ts - b.ts);

    try {
      fs.writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''), {
        mode: 0o600,
      });
      fs.renameSync(tmp, this.file);
      this.lineCount = entries.length;
      this.deadLines = 0;
      console.log(`[history] compacted to ${entries.length} message${entries.length === 1 ? '' : 's'}`);
    } catch (err) {
      console.error('[history] compaction failed:', err.message);
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* nothing to clean up */
      }
    } finally {
      this.compacting = false;
    }
  }

  /** One line for the startup banner. */
  describeRetention() {
    if (!this.opts.enabled) return 'off (nothing is kept)';
    const age = this.opts.maxAgeDays
      ? `${this.opts.maxAgeDays} day${this.opts.maxAgeDays === 1 ? '' : 's'}`
      : 'kept indefinitely';
    return `on, ${this.opts.maxPerConversation} per conversation, ${age}`;
  }

  get stats() {
    return {
      enabled: this.opts.enabled,
      conversations: this.index.size,
      messages: this.lineCount,
    };
  }

  close() {
    this.flushSync();
  }
}

module.exports = { History, dmKey, roomKey, DEFAULTS };
