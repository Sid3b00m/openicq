'use strict';

/**
 * Per-IP abuse limits.
 *
 * The session token bucket in protocol.js only slows a single connection down,
 * which is no help against someone who simply opens more sockets. These limits
 * are keyed on the peer address instead, so reconnecting does not reset them.
 */

const CLEANUP_INTERVAL_MS = 60_000;
const ENTRY_TTL_MS = 60 * 60_000;

const DEFAULTS = {
  maxConnectionsPerIp: 12,
  maxRegistrationsPerIpPerHour: 5,
  // Failed sign-ons are counted per IP *and* per account; whichever is further
  // along decides the delay.
  loginFailureWindowMs: 15 * 60_000,
  maxLoginFailures: 10,
  loginBaseDelayMs: 350,
  loginMaxDelayMs: 20_000,
};

class Limits {
  constructor(options = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.connections = new Map(); // ip -> count
    this.registrations = new Map(); // ip -> timestamps[]
    this.failures = new Map(); // key -> { count, first, last }
    this.exempt = new Set(); // addresses that bypass the limits

    const timer = setInterval(() => this.sweep(), CLEANUP_INTERVAL_MS);
    if (timer.unref) timer.unref();
    this._timer = timer;
  }

  isExempt(ip) {
    return this.exempt.has(ip);
  }

  // --- connections --------------------------------------------------------

  /** @returns {boolean} false when this IP already holds too many sockets. */
  openConnection(ip) {
    if (this.isExempt(ip)) return true;
    const current = this.connections.get(ip) || 0;
    if (current >= this.opts.maxConnectionsPerIp) return false;
    this.connections.set(ip, current + 1);
    return true;
  }

  closeConnection(ip) {
    const current = this.connections.get(ip);
    if (!current) return;
    if (current <= 1) this.connections.delete(ip);
    else this.connections.set(ip, current - 1);
  }

  connectionCount(ip) {
    return this.connections.get(ip) || 0;
  }

  // --- registration -------------------------------------------------------

  canRegister(ip) {
    if (this.isExempt(ip)) return true;
    const stamps = this.registrations.get(ip);
    if (!stamps) return true;
    const cutoff = Date.now() - 60 * 60_000;
    const recent = stamps.filter((t) => t > cutoff);
    if (recent.length !== stamps.length) this.registrations.set(ip, recent);
    return recent.length < this.opts.maxRegistrationsPerIpPerHour;
  }

  noteRegistration(ip) {
    if (this.isExempt(ip)) return;
    const stamps = this.registrations.get(ip) || [];
    stamps.push(Date.now());
    this.registrations.set(ip, stamps);
  }

  // --- sign-on throttling -------------------------------------------------

  _failureCount(key) {
    const entry = this.failures.get(key);
    if (!entry) return 0;
    if (Date.now() - entry.last > this.opts.loginFailureWindowMs) {
      this.failures.delete(key);
      return 0;
    }
    return entry.count;
  }

  /**
   * How long to wait before answering a sign-on attempt. Doubles with each
   * recent failure so guessing a password gets expensive fast.
   */
  loginDelay(ip, account) {
    if (this.isExempt(ip)) return 0;
    const strikes = Math.max(this._failureCount(`ip:${ip}`), this._failureCount(`acct:${account}`));
    const delay = this.opts.loginBaseDelayMs * 2 ** Math.min(strikes, 12);
    return Math.min(delay, this.opts.loginMaxDelayMs);
  }

  /** True when this IP or account has failed so often it should be refused outright. */
  loginBlocked(ip, account) {
    if (this.isExempt(ip)) return false;
    return (
      this._failureCount(`ip:${ip}`) >= this.opts.maxLoginFailures * 5 ||
      this._failureCount(`acct:${account}`) >= this.opts.maxLoginFailures * 5
    );
  }

  noteLoginFailure(ip, account) {
    if (this.isExempt(ip)) return;
    for (const key of [`ip:${ip}`, `acct:${account}`]) {
      const entry = this.failures.get(key) || { count: 0, first: Date.now(), last: 0 };
      entry.count++;
      entry.last = Date.now();
      this.failures.set(key, entry);
    }
  }

  noteLoginSuccess(ip, account) {
    this.failures.delete(`ip:${ip}`);
    this.failures.delete(`acct:${account}`);
  }

  // --- housekeeping -------------------------------------------------------

  sweep() {
    const now = Date.now();
    for (const [key, entry] of this.failures) {
      if (now - entry.last > this.opts.loginFailureWindowMs) this.failures.delete(key);
    }
    for (const [ip, stamps] of this.registrations) {
      const recent = stamps.filter((t) => now - t < ENTRY_TTL_MS);
      if (!recent.length) this.registrations.delete(ip);
      else this.registrations.set(ip, recent);
    }
  }

  stop() {
    clearInterval(this._timer);
  }
}

module.exports = { Limits, DEFAULTS };
