#!/usr/bin/env node
'use strict';

/**
 * OpenICQ server: static client host + WebSocket hub, no dependencies.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { attach } = require('./ws');
const { Store } = require('./store');
const { Hub } = require('./protocol');
const { Limits, DEFAULTS } = require('./limits');
const update = require('./update');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * The client is plain files with no inline scripts, so script-src can stay
 * tight. Inline `style="..."` attributes are used for layout, hence
 * 'unsafe-inline' on style-src only.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws: wss:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const opts = {
    port: Number(process.env.PORT) || 5190,
    host: process.env.HOST || '0.0.0.0',
    data: process.env.OPENICQ_DATA || path.join(ROOT, 'data', 'openicq.json'),
    allowRegistration: process.env.OPENICQ_REGISTRATION !== 'off',
    motd: process.env.OPENICQ_MOTD || '',
    origins: parseList(process.env.OPENICQ_ORIGINS),
    trustProxy: parseList(process.env.OPENICQ_TRUST_PROXY),
    hsts: process.env.OPENICQ_HSTS === 'on',
    healthDetails: process.env.OPENICQ_HEALTH_DETAILS === 'on',
    maxConnectionsPerIp:
      Number(process.env.OPENICQ_MAX_CONNECTIONS_PER_IP) || DEFAULTS.maxConnectionsPerIp,
    registrationsPerHour:
      Number(process.env.OPENICQ_REGISTRATIONS_PER_HOUR) || DEFAULTS.maxRegistrationsPerIpPerHour,
    updateCheck: process.env.OPENICQ_UPDATE_CHECK !== 'off',
    announceUpdates: process.env.OPENICQ_ANNOUNCE_UPDATES === 'on',
    checkUpdateOnly: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--port':
      case '-p':
        opts.port = Number(next());
        break;
      case '--host':
      case '-h':
        opts.host = next();
        break;
      case '--data':
      case '-d':
        opts.data = path.resolve(next());
        break;
      case '--motd':
        opts.motd = next();
        break;
      case '--no-registration':
        opts.allowRegistration = false;
        break;
      case '--origin':
        opts.origins.push(...parseList(next()));
        break;
      case '--trust-proxy':
        opts.trustProxy.push(...parseList(next()));
        break;
      case '--hsts':
        opts.hsts = true;
        break;
      case '--health-details':
        opts.healthDetails = true;
        break;
      case '--max-connections-per-ip':
        opts.maxConnectionsPerIp = Number(next());
        break;
      case '--registrations-per-hour':
        opts.registrationsPerHour = Number(next());
        break;
      case '--no-update-check':
        opts.updateCheck = false;
        break;
      case '--announce-updates':
        opts.announceUpdates = true;
        break;
      case '--check-update':
        opts.checkUpdateOnly = true;
        break;
      case '--version':
      case '-v':
        console.log(require('../package.json').version);
        process.exit(0);
        break;
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        printHelp();
        process.exit(1);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`OpenICQ server

Usage: node server/index.js [options]

  -p, --port <n>        Port to listen on (default 5190, the classic ICQ port)
  -h, --host <addr>     Address to bind (default 0.0.0.0)
  -d, --data <file>     Database file (default ./data/openicq.json)
      --motd <text>     Message shown on the sign-on screen
      --no-registration Refuse new UIN registrations

Hosting:
      --origin <url>    Allowed browser origin, repeatable or comma-separated.
                        Set this when the server is reachable from the internet;
                        handshakes from other sites are then refused.
      --trust-proxy <l> Where X-Forwarded-For may be believed: "loopback",
                        "all", or a comma-separated list of IPs/CIDRs. Without
                        this the header is ignored, as it is trivially forged.
      --hsts            Send Strict-Transport-Security (only behind HTTPS)
      --health-details  Let /health report user and session counts
      --max-connections-per-ip <n>   Default ${DEFAULTS.maxConnectionsPerIp}
      --registrations-per-hour <n>   Default ${DEFAULTS.maxRegistrationsPerIpPerHour} per IP

Updates:
      --check-update    Ask GitHub whether a newer release exists, then exit
      --no-update-check Never contact GitHub
      --announce-updates  Also show "update available" to anyone on the
                        sign-on screen, not just in the server log
  -v, --version         Print the version and exit
      --help            Show this help

Update checks ask ${update.REPO} for its latest release once a day. Nothing is
ever downloaded or run; to actually install one, see deploy/update.sh.
`);
}

// --- proxy handling -------------------------------------------------------

function ipToLong(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

function normalizeIp(ip) {
  if (!ip) return '';
  // ::ffff:1.2.3.4 -> 1.2.3.4
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return mapped ? mapped[1] : ip;
}

/** Build a predicate for "is this socket peer a proxy we configured?" */
function makeProxyMatcher(entries) {
  if (!entries.length) return () => false;
  if (entries.includes('all')) return () => true;

  const exact = new Set();
  const cidrs = [];
  for (const entry of entries) {
    if (entry === 'loopback') {
      exact.add('127.0.0.1');
      exact.add('::1');
      continue;
    }
    if (entry.includes('/')) {
      const [base, bits] = entry.split('/');
      const long = ipToLong(base);
      const width = Number(bits);
      if (long === null || !Number.isInteger(width) || width < 0 || width > 32) {
        console.error(`[openicq] ignoring unparsable --trust-proxy entry: ${entry}`);
        continue;
      }
      const mask = width === 0 ? 0 : (0xffffffff << (32 - width)) >>> 0;
      cidrs.push({ network: (long & mask) >>> 0, mask });
      continue;
    }
    exact.add(entry);
  }

  return (ip) => {
    const clean = normalizeIp(ip);
    if (exact.has(clean) || exact.has(ip)) return true;
    const long = ipToLong(clean);
    if (long === null) return false;
    return cidrs.some(({ network, mask }) => ((long & mask) >>> 0) === network);
  };
}

// --- static files ---------------------------------------------------------

function serveStatic(req, res, extraHeaders) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, relative);

  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, extraHeaders).end('Forbidden');
    return;
  }

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { ...extraHeaders, 'content-type': 'text/plain' }).end('Not found');
      return;
    }

    const ext = path.extname(target).toLowerCase();
    const etag = `W/"${stat.size}-${stat.mtimeMs}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, extraHeaders).end();
      return;
    }

    res.writeHead(200, {
      ...extraHeaders,
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': stat.size,
      etag,
      'cache-control': 'no-cache',
    });

    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(target).pipe(res);
  });
}

function localAddresses() {
  const out = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}

/**
 * `--check-update`: report and exit, without starting a server.
 *
 * Sets process.exitCode rather than calling process.exit, because tearing the
 * process down while fetch is still releasing its socket aborts the runtime.
 *
 * Exit status: 0 up to date, 1 update available, 2 could not check.
 */
async function runUpdateCheck() {
  const current = require('../package.json').version;
  const result = await update.checkForUpdate({ currentVersion: current, force: true });

  if (!result.ok) {
    console.error(`[openicq] ${update.describe(result)}`);
    process.exitCode = 2;
    return;
  }
  console.log(`  Installed : ${result.current}`);
  console.log(`  Latest    : ${result.latest || 'none published'}`);
  if (result.updateAvailable) {
    console.log(`\n  An update is available: ${result.url}`);
    if (result.notes) {
      console.log('\n' + result.notes.split('\n').map((l) => `  | ${l}`).join('\n'));
    }
    console.log('\n  To install it on a systemd host: sudo /opt/openicq/update.sh');
    process.exitCode = 1;
    return;
  }
  console.log('\n  You are up to date.');
  process.exitCode = 0;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.checkUpdateOnly) return runUpdateCheck();

  const store = new Store(opts.data);
  const limits = new Limits({
    maxConnectionsPerIp: opts.maxConnectionsPerIp,
    maxRegistrationsPerIpPerHour: opts.registrationsPerHour,
  });
  const hub = new Hub(store, {
    allowRegistration: opts.allowRegistration,
    motd: opts.motd,
    limits,
    announceUpdates: opts.announceUpdates,
  });

  const isTrustedProxy = makeProxyMatcher(opts.trustProxy);
  const trustAllProxies = opts.trustProxy.includes('all');

  /**
   * The address we hold a client responsible for.
   *
   * X-Forwarded-For is only read when the socket peer is a proxy we were told
   * about, because anyone can send the header. The rightmost entry is the one
   * our own proxy appended; entries to its left came from the client and are
   * worthless.
   */
  const clientAddress = (req, socket) => {
    const peer = socket.remoteAddress || 'unknown';
    if (!isTrustedProxy(peer)) return normalizeIp(peer);

    const forwarded = parseList(req.headers['x-forwarded-for']);
    if (!forwarded.length) return normalizeIp(peer);

    // With "all" there is no way to tell proxy hops from clients, so trust
    // only the last entry and nothing further left.
    if (trustAllProxies) return normalizeIp(forwarded[forwarded.length - 1]);

    for (let i = forwarded.length - 1; i >= 0; i--) {
      if (!isTrustedProxy(forwarded[i])) return normalizeIp(forwarded[i]);
    }
    return normalizeIp(peer);
  };

  const headers = { ...SECURITY_HEADERS };
  if (opts.hsts) headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains';

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...headers, allow: 'GET, HEAD' }).end('Method not allowed');
      return;
    }
    if ((req.url || '').split('?')[0] === '/health') {
      const body = opts.healthDetails
        ? { ok: true, users: store.userCount, online: hub.sessions.size }
        : { ok: true };
      res.writeHead(200, { ...headers, 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
    serveStatic(req, res, headers);
  });

  // Keep half-open and slow-header connections from piling up.
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 15_000;
  server.maxHeadersCount = 64;

  attach(server, {
    path: '/ws',
    onConnection: (ws) => hub.handleConnection(ws),
    clientAddress,
    origins: opts.origins.length ? opts.origins : null,
    limits,
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[openicq] port ${opts.port} is already in use. Try --port 5191.`);
      process.exit(1);
    }
    if (err.code === 'EACCES') {
      console.error(`[openicq] not allowed to bind ${opts.host}:${opts.port}.`);
      console.error('[openicq] ports below 1024 need extra privileges; pick a higher one.');
      process.exit(1);
    }
    throw err;
  });

  server.listen(opts.port, opts.host, () => {
    const banner = [
      '',
      '   ___                 ___ ____ ___',
      '  / _ \\ _ __  ___ _ _ |_ _/ ___/ _ \\   "Uh-oh!"',
      ' | (_) | \'_ \\/ -_) \' \\ | | |  | (_) |',
      '  \\___/| .__/\\___|_||_|___\\___|\\__\\_\\',
      '       |_|',
      '',
    ].join('\n');
    console.log(banner);
    console.log(`  Database : ${opts.data} (${store.userCount} UIN${store.userCount === 1 ? '' : 's'})`);
    console.log(`  Local    : http://localhost:${opts.port}`);
    for (const address of localAddresses()) {
      console.log(`  Network  : http://${address}:${opts.port}`);
    }
    console.log(`  Sign-ups : ${opts.allowRegistration ? 'open' : 'closed'}`);
    console.log(`  Origins  : ${opts.origins.length ? opts.origins.join(', ') : 'any (set --origin when public)'}`);
    if (opts.trustProxy.length) {
      console.log(`  Proxies  : ${opts.trustProxy.join(', ')}`);
    }
    console.log(`  Version  : ${require('../package.json').version}`);
    console.log('\n  Press Ctrl+C to shut down.\n');
  });

  // Advisory update check: once at startup, then daily. Failures are silent
  // beyond a log line, and --no-update-check skips it entirely.
  if (opts.updateCheck) {
    const announce = async () => {
      const result = await update.checkForUpdate();
      hub.updateStatus = result.updateAvailable
        ? { version: result.latest, url: result.url }
        : null;
      if (result.updateAvailable) {
        console.log(`[openicq] ${update.describe(result)} \u2014 ${result.url}`);
      } else if (!result.ok) {
        console.log(`[openicq] ${update.describe(result)}`);
      }
    };
    setTimeout(announce, 2000).unref();
    setInterval(announce, 24 * 60 * 60 * 1000).unref();
  }

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) process.exit(0);
    shuttingDown = true;
    console.log('\n[openicq] saving database...');
    store.flushSync();
    limits.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Save what we can, then let the supervisor restart us. Carrying on after an
  // unknown failure risks serving from half-updated state.
  process.on('uncaughtException', (err) => {
    console.error('[openicq] uncaught exception:', err);
    store.flushSync();
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    console.error('[openicq] unhandled rejection:', err);
    store.flushSync();
    process.exit(1);
  });
}

main();
