'use strict';

/**
 * Update-check test. Points the checker at a local stub of the GitHub releases
 * API so every branch can be exercised without touching the network.
 */

const http = require('http');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` \u2014 ${detail}` : ''}`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Stand-in for api.github.com; `reply` decides what each request gets. */
async function stubApi(reply) {
  const port = await freePort();
  const server = http.createServer((req, res) => {
    const { status, body } = reply(req);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${port}/releases/latest`, server };
}

/** Run the checker in a fresh process, since its cache is module-level. */
function runChecker(apiUrl, currentVersion) {
  return new Promise((resolve) => {
    const script = `
      const u = require(${JSON.stringify(path.join(__dirname, '..', 'server', 'update.js'))});
      u.checkForUpdate({ currentVersion: ${JSON.stringify(currentVersion)}, force: true })
        .then((r) => console.log(JSON.stringify(r)));
    `;
    const child = spawn(process.execPath, ['-e', script], {
      env: { ...process.env, OPENICQ_UPDATE_API: apiUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('exit', () => {
      try {
        resolve(JSON.parse(out.trim()));
      } catch {
        resolve({ parseError: out });
      }
    });
  });
}

async function main() {
  console.log('OpenICQ update-check test\n');

  const { compareVersions, parseVersion, describe } = require('../server/update');

  console.log('version comparison');
  check('older < newer', compareVersions('0.5.0', '0.6.0') < 0);
  check('newer > older', compareVersions('1.0.0', '0.9.9') > 0);
  check('equal is zero', compareVersions('0.5.0', '0.5.0') === 0);
  check('major beats minor', compareVersions('0.99.0', '1.0.0') < 0);
  check('patch is compared numerically', compareVersions('0.5.9', '0.5.10') < 0);
  check('a leading v is ignored', compareVersions('v0.5.0', '0.5.0') === 0);
  check('pre-release sorts below release', compareVersions('1.0.0-rc1', '1.0.0') < 0);
  check('release sorts above pre-release', compareVersions('1.0.0', '1.0.0-rc1') > 0);
  check('unparsable versions compare equal', compareVersions('junk', '0.5.0') === 0);
  check('parseVersion rejects junk', parseVersion('not-a-version') === null);

  console.log('\nupdate available');
  {
    const { url, server } = await stubApi(() => ({
      status: 200,
      body: {
        tag_name: 'v0.6.0',
        html_url: 'https://example.invalid/releases/v0.6.0',
        published_at: '2026-10-14T00:00:00Z',
        body: 'Adds things.',
      },
    }));
    const r = await runChecker(url, '0.5.0');
    check('a newer tag is reported', r.updateAvailable === true, JSON.stringify(r));
    check('the new version is carried through', r.latest === '0.6.0');
    check('the release URL is carried through', r.url === 'https://example.invalid/releases/v0.6.0');
    check('release notes are included', r.notes === 'Adds things.');
    check('describe() says so', describe(r).includes('0.5.0 \u2192 0.6.0'));
    server.close();
  }

  console.log('\nalready current');
  {
    const { url, server } = await stubApi(() => ({ status: 200, body: { tag_name: 'v0.5.0' } }));
    const r = await runChecker(url, '0.5.0');
    check('the same version is not an update', r.updateAvailable === false);
    check('a newer local build is not an update', (await runChecker(url, '0.9.0')).updateAvailable === false);
    check('describe() says up to date', describe(r).includes('up to date'));
    server.close();
  }

  console.log('\nfailure is soft');
  {
    const none = await stubApi(() => ({ status: 404, body: { message: 'Not Found' } }));
    const r404 = await runChecker(none.url, '0.5.0');
    check('a repo with no releases is not an error', r404.ok === true && r404.latest === null);
    check('and is not an update', r404.updateAvailable === false);
    none.server.close();

    const limited = await stubApi(() => ({ status: 403, body: { message: 'rate limited' } }));
    const r403 = await runChecker(limited.url, '0.5.0');
    check('a rate-limited API reports not-ok', r403.ok === false);
    check('and never claims an update', r403.updateAvailable === false);
    check('and keeps the current version', r403.current === '0.5.0');
    limited.server.close();

    const garbage = await stubApi(() => ({ status: 200, body: 'this is not json' }));
    const rJunk = await runChecker(garbage.url, '0.5.0');
    check('a malformed body does not throw', rJunk.ok === false && !rJunk.updateAvailable);
    garbage.server.close();

    const noTag = await stubApi(() => ({ status: 200, body: { something: 'else' } }));
    const rNoTag = await runChecker(noTag.url, '0.5.0');
    check('a response without a tag is not an update', rNoTag.updateAvailable === false);
    noTag.server.close();

    // Nothing listening at all.
    const dead = `http://127.0.0.1:${await freePort()}/releases/latest`;
    const rDead = await runChecker(dead, '0.5.0');
    check('an unreachable API reports not-ok', rDead.ok === false);
    check('and offers the releases page as a fallback URL', rDead.url.includes('/releases'));
  }

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
}

main()
  .then(() => process.exit(failures ? 1 : 0))
  .catch((err) => {
    console.error('\nUpdate test crashed:', err.message);
    process.exit(1);
  });
