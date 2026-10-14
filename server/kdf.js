'use strict';

/**
 * Password hashing.
 *
 * scrypt is deliberately expensive, so it must never run on the event loop:
 * `crypto.scryptSync` would let anyone freeze the whole server by firing login
 * packets at it. Everything here uses the async form (which runs on the libuv
 * thread pool) behind a queue that bounds both how many hashes run at once and
 * how many may be waiting.
 *
 * The parameters match Node's historical scryptSync defaults, so hashes
 * written by earlier versions still verify.
 */

const crypto = require('crypto');
const os = require('os');

const KEYLEN = 64;
const SALT_BYTES = 16;
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 256;

// Node's thread pool is 4 threads by default; leave one for file I/O.
const MAX_CONCURRENT = Math.max(1, Math.min(3, os.cpus().length - 1));
const MAX_QUEUED = 48;

// Verifying an unknown account still costs a real hash, so "no such UIN" and
// "wrong password" take the same time and cannot be told apart.
const DUMMY_SALT = crypto.randomBytes(SALT_BYTES).toString('hex');

let active = 0;
const queue = [];

class KdfBusyError extends Error {
  constructor() {
    super('Authentication is busy. Try again in a moment.');
    this.code = 'kdf-busy';
  }
}

function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    active++;
    crypto.scrypt(job.password, job.salt, KEYLEN, PARAMS, (err, derived) => {
      active--;
      if (err) job.reject(err);
      else job.resolve(derived);
      pump();
    });
  }
}

/** @returns {Promise<Buffer>} */
function derive(password, salt) {
  if (queue.length >= MAX_QUEUED) return Promise.reject(new KdfBusyError());
  return new Promise((resolve, reject) => {
    queue.push({ password, salt, resolve, reject });
    pump();
  });
}

/**
 * Reject passwords that are unusable before any hashing happens. Returning a
 * reason rather than throwing keeps the protocol handlers flat.
 * @returns {string|null} an error message, or null when the password is fine
 */
function checkPassword(password) {
  if (typeof password !== 'string') return 'Password must be text.';
  if (password.length < MIN_PASSWORD) {
    return `Password must be at least ${MIN_PASSWORD} characters.`;
  }
  if (password.length > MAX_PASSWORD) {
    return `Password must be at most ${MAX_PASSWORD} characters.`;
  }
  return null;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
  const hash = (await derive(password, salt)).toString('hex');
  return { salt, hash };
}

/**
 * @param {{ salt: string, hash: string }|null} user
 * @returns {Promise<boolean>}
 */
async function verifyPassword(user, password) {
  // Over-long passwords are never valid, but hash a truncated copy anyway so
  // the timing of this path matches a normal failure.
  const candidate = String(password).slice(0, MAX_PASSWORD);
  const tooLong = String(password).length > MAX_PASSWORD;

  const salt = user ? user.salt : DUMMY_SALT;
  const derived = await derive(candidate, salt);
  if (!user || tooLong) return false;

  const expected = Buffer.from(user.hash, 'hex');
  if (expected.length !== derived.length) return false;
  return crypto.timingSafeEqual(expected, derived);
}

function stats() {
  return { active, queued: queue.length, maxConcurrent: MAX_CONCURRENT };
}

module.exports = {
  hashPassword,
  verifyPassword,
  checkPassword,
  stats,
  KdfBusyError,
  MIN_PASSWORD,
  MAX_PASSWORD,
};
