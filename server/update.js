'use strict';

/**
 * Update checks against the GitHub releases API.
 *
 * This is advisory only: it never downloads or runs anything, it just tells
 * whoever is hosting that a newer release exists. Every failure is soft, so a
 * blocked network or a rate-limited API can never stop the server working.
 */

const REPO = process.env.OPENICQ_REPO || 'Sid3b00m/openicq';

// Overridable so forks and mirrors can point elsewhere, and so the tests can
// aim at a local stub. Only ever used to read a version string: nothing from
// the response is downloaded, executed, or written to disk.
const API =
  process.env.OPENICQ_UPDATE_API || `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_URL = `https://github.com/${REPO}/releases`;

const TIMEOUT_MS = 6000;
const CACHE_MS = 6 * 60 * 60 * 1000; // the API allows 60 anonymous calls an hour

let cache = null; // { at, result }

/** Split "1.2.3-rc1" into comparable parts, ignoring any leading "v". */
function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(value || '').trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] || null,
  };
}

/**
 * @returns {number} negative when a < b, 0 when equal, positive when a > b.
 */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;

  for (const part of ['major', 'minor', 'patch']) {
    if (left[part] !== right[part]) return left[part] - right[part];
  }
  // A release beats a pre-release of the same number (1.0.0 > 1.0.0-rc1).
  if (left.pre && !right.pre) return -1;
  if (!left.pre && right.pre) return 1;
  if (left.pre && right.pre) return left.pre < right.pre ? -1 : left.pre > right.pre ? 1 : 0;
  return 0;
}

/**
 * Ask GitHub for the latest release.
 *
 * @param {object} [options]
 * @param {string} [options.currentVersion]
 * @param {boolean} [options.force]  ignore the cache
 * @returns {Promise<{ok: boolean, updateAvailable: boolean, current: string,
 *   latest: string|null, url: string, publishedAt: string|null,
 *   notes: string|null, error: string|null}>}
 */
async function checkForUpdate({ currentVersion, force = false } = {}) {
  const current = currentVersion || require('../package.json').version;

  if (!force && cache && Date.now() - cache.at < CACHE_MS) {
    return cache.result;
  }

  const base = {
    ok: false,
    updateAvailable: false,
    current,
    latest: null,
    url: RELEASES_URL,
    publishedAt: null,
    notes: null,
    error: null,
  };

  let result;
  try {
    const res = await fetch(API, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `OpenICQ/${current}`,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (res.status === 404) {
      // No releases published yet; that is not an error worth shouting about.
      result = { ...base, ok: true };
    } else if (!res.ok) {
      result = { ...base, error: `GitHub answered ${res.status}` };
    } else {
      const body = await res.json();
      const latest = String(body.tag_name || '').replace(/^v/, '');
      result = {
        ...base,
        ok: true,
        latest: latest || null,
        updateAvailable: !!latest && compareVersions(current, latest) < 0,
        url: body.html_url || RELEASES_URL,
        publishedAt: body.published_at || null,
        notes: typeof body.body === 'string' ? body.body.trim().slice(0, 2000) : null,
      };
    }
  } catch (err) {
    result = { ...base, error: err.name === 'TimeoutError' ? 'timed out' : err.message };
  }

  cache = { at: Date.now(), result };
  return result;
}

/** One-line summary for the console. */
function describe(result) {
  if (!result.ok) return `could not check for updates (${result.error})`;
  if (!result.latest) return `no releases published yet`;
  if (!result.updateAvailable) return `up to date (${result.current})`;
  return `update available: ${result.current} \u2192 ${result.latest}`;
}

module.exports = { checkForUpdate, compareVersions, parseVersion, describe, REPO, RELEASES_URL };
