# OpenICQ

ICQ shut down. This is a working replacement you can run yourself: UINs, a
server-side contact list, authorization requests, the eight status flowers,
offline messages, and a message alert that still goes *uh-oh*.

Runs on Windows, macOS and every flavour of Linux. **No dependencies, no build
step, no `npm install`** — the server is plain Node.js and the client is plain
HTML/CSS/JS.

```
   ___                 ___ ____ ___
  / _ \ _ __  ___ _ _ |_ _/ ___/ _ \   "Uh-oh!"
 | (_) | '_ \/ -_) ' \ | | |  | (_) |
  \___/| .__/\___|_||_|___\___|\__\_\
       |_|
```

## Quick start

For anything beyond trying it out — hosting it, installing the desktop app,
updating, backups, troubleshooting — see the **[install guide](INSTALL.md)**.

You need [Node.js](https://nodejs.org/en/download) 18 or newer. That is the
only requirement.

**Windows** — double-click `start.bat`, or:

```powershell
node server\index.js
```

**macOS / Linux**:

```sh
chmod +x start.sh && ./start.sh
```

Then open <http://localhost:5190>, click **New UIN…**, and you are on. Anyone
on your network can join at `http://<your-ip>:5190` — the server prints the
addresses when it starts.

## Desktop app

The web client is the whole client, but there is an Electron shell that boots
its own private server and feels like a real installed program:

```sh
cd desktop
npm install
npm start
```

Build installers for every platform (`.exe`, `.dmg`, `AppImage`, `.deb`,
`.rpm`, `.tar.gz`):

```sh
npm run dist          # current platform
npm run dist:linux    # or :win / :mac
```

To point the desktop app at someone else's server instead of its own:

```sh
OPENICQ_SERVER=icq.example.com:5190 npm start
```

## Running a server for other people

```sh
node server/index.js --port 5190 --motd "Welcome back to 1999."
```

| Option | What it does |
| --- | --- |
| `--port <n>` | Port to listen on. Default `5190`, the port real ICQ used. |
| `--host <addr>` | Address to bind. Default `0.0.0.0`. |
| `--data <file>` | Database file. Default `./data/openicq.json`. |
| `--motd <text>` | Message shown on the sign-on screen. |
| `--no-registration` | Stop handing out new UINs. |

And, for a server that strangers can reach:

| Option | What it does |
| --- | --- |
| `--origin <url>` | Browser origins allowed to open a WebSocket. **Set this when the server is public**, or any website can drive it with a visitor's browser. |
| `--trust-proxy <l>` | Where `X-Forwarded-For` may be believed: `loopback`, `all`, or a list of IPs/CIDRs. Ignored otherwise, since anyone can forge it. |
| `--hsts` | Send `Strict-Transport-Security`. Only once TLS works. |
| `--health-details` | Let `/health` report user and session counts. Off by default. |
| `--max-connections-per-ip <n>` | Default 12. Raise it if real users share an address. |
| `--registrations-per-hour <n>` | New UINs per IP per hour. Default 5. |

Every flag has an environment variable (`PORT`, `OPENICQ_ORIGINS`,
`OPENICQ_TRUST_PROXY`, …) so the service file stays declarative — see
[`deploy/openicq.env.example`](deploy/openicq.env.example).

Everything lives in one JSON file, so backups are `cp data/openicq.json
somewhere-else`.

## Deploying it

A condensed version of the [install guide](INSTALL.md), which covers the same
ground with more care. Everything here assumes a domain pointed at a fresh
Linux box. OpenICQ binds loopback and a reverse proxy terminates TLS, because
the client only switches to `wss://` when the page itself came over HTTPS.

### The scripted way

```sh
git clone <your-fork> openicq && cd openicq
sudo ./deploy/install.sh icq.example.com you@example.com
```

That creates an `openicq` system user, installs to `/opt/openicq`, puts the
database in `/var/lib/openicq`, writes `/etc/openicq/openicq.env`, enables a
hardened systemd unit plus a nightly backup timer, and configures Caddy (or
nginx, if that is what it finds). Re-running it upgrades in place and leaves
the database and config alone.

Install [Caddy](https://caddyserver.com/docs/install) first if you want
certificates handled for you; with nginx you finish by running
`certbot --nginx -d icq.example.com`.

| | |
| --- | --- |
| Status | `systemctl status openicq` |
| Logs | `journalctl -u openicq -f` |
| Config | `/etc/openicq/openicq.env` |
| Database | `/var/lib/openicq/openicq.json` |
| Backups | `/var/lib/openicq/backups`, daily, 14 kept |
| Updates | `sudo /opt/openicq/update.sh` |

### With Docker

```sh
cd deploy
cp .env.example .env          # set your domain
$EDITOR Caddyfile.docker      # same domain, your email
docker compose up -d
```

Caddy gets the certificate; OpenICQ is not published to the host, so only the
proxy can reach it. The container runs unprivileged with a read-only root
filesystem and the database on a named volume.

### By hand

The pieces are all in [`deploy/`](deploy/):
[`openicq.service`](deploy/openicq.service) (a locked-down unit),
[`Caddyfile`](deploy/Caddyfile), [`nginx.conf`](deploy/nginx.conf),
[`backup.sh`](deploy/backup.sh) with its timer, and the env example. The two
settings that matter most are `OPENICQ_ORIGINS` (your public URL) and
`OPENICQ_TRUST_PROXY=loopback` — without the latter, every client looks like
the proxy and the per-IP limits protect nothing.

## What it does

- **UINs.** The first account on a fresh server is 100000, same as the real
  thing. Sign on with your UIN or your nickname.
- **Contact list** stored server-side, so it follows you between machines.
- **Authorization requests.** Adding someone sends a request with a message;
  they stay offline to you until it is accepted. Mutual adds skip the dance.
- **Eight statuses** — Online, Free For Chat, Away, N/A, Occupied, DND and
  Invisible, plus a status message. Invisible really does read as offline to
  everyone else.
- **Offline messages** are stored on the server and delivered at next sign-on.
- **Typing notifications**, delivery acknowledgements and local message
  history you can browse or clear per contact.
- **Multiple devices** on one UIN at the same time; your own messages echo to
  your other sessions.
- **The sounds.** Message alert, door-open on sign-on, door-close on sign-off.
  All synthesized in the browser with Web Audio.

## Keyboard and mouse

| Action | How |
| --- | --- |
| Open a chat | Double-click a contact |
| Contact menu | Right-click a contact |
| Send | `Enter` (`Shift+Enter` for a new line) |
| Change status | Click the status button, or the flower in the tray |
| Minimize a window | Double-click its title bar |

## Protocol

JSON frames over a WebSocket at `/ws`. Every packet has a `t` field.

```jsonc
// client -> server
{ "t": "login",   "uin": "100000", "password": "…", "status": "online" }
{ "t": "message", "to": "100001", "body": "uh-oh", "id": "ref-1" }

// server -> client
{ "t": "welcome",  "user": { … }, "contacts": [ … ], "pendingAuth": [ … ] }
{ "t": "message",  "from": "100000", "fromNick": "Alice", "body": "uh-oh", "ts": 1 }
{ "t": "presence", "uin": "100001", "status": "away" }
```

`server/protocol.js` is the complete list — each handler is a dozen lines and
the names match the packet names. Writing a bot or an alternative client is a
couple of hours of work.

## Layout

```
server/index.js      HTTP + static file server, CLI, security headers
server/ws.js         RFC 6455 WebSocket server written from scratch
server/protocol.js   sessions, presence, contacts, message routing
server/store.js      accounts and the JSON database
server/kdf.js        password hashing, off the event loop
server/limits.js     per-IP connection, registration and sign-on limits
server/update.js     advisory release check against GitHub
public/              the client (no build step, edit and reload)
desktop/             Electron shell and installer config
deploy/              systemd unit, proxy configs, installer, backups
test/smoke.js        end-to-end test against a real server
test/security.js     regression test for the hardening
test/update.js       update check against a stubbed API
```

## Staying current

The server asks GitHub for its latest release once a day and logs it if there
is something newer. It reads a version number and nothing else; no download, no
self-installing. `--no-update-check` stops it contacting GitHub at all.

```sh
node server/index.js --check-update   # 0 current, 1 update available, 2 could not check
sudo /opt/openicq/update.sh           # install it: backs up, swaps, restarts, rolls back on failure
```

The desktop app checks on launch and offers a link. Browser users get the new
client the moment the server has it.

## Tests

```sh
npm test            # all three suites
npm run test:smoke  # protocol behaviour
npm run test:security
npm run test:update
```

The smoke test boots a real server on a scratch database and drives two clients
through registration, authorization, messaging, offline delivery and invisible
mode. The security test boots servers with various flags and checks the
hardening actually holds — origin rejection, per-IP caps, sign-on backoff,
header policy, path traversal and the invisible-mode acknowledgement.

## Security notes

**Messages are not end-to-end encrypted.** The server sees every message,
exactly as ICQ did, and anyone who can read the database can read stored
offline messages. Run it over TLS and do not use it for anything you would not
post on a BBS.

What the server does do:

- **Passwords** are scrypt hashes with per-account salts, never stored or
  logged in the clear. Hashing happens off the event loop behind a bounded
  queue, so sign-on traffic cannot stall the server; a failed sign-on costs the
  same whether or not the account exists.
- **Guessing is throttled per address and per account**, with the delay
  doubling each time. Reconnecting does not reset it.
- **Per-IP limits** on concurrent connections and new registrations, so one
  host cannot exhaust the server or mint accounts in bulk.
- **Origin is checked** on the WebSocket handshake when `--origin` is set,
  which stops other sites opening connections through a visitor's browser.
- **`X-Forwarded-For` is ignored** unless you name the proxy with
  `--trust-proxy`, because it is trivially forged.
- **The client is served with a strict CSP**, `frame-ancestors 'none'` and
  `nosniff`. Everything a user can type is escaped before it reaches the DOM.
- **Invisible is really invisible**: delivery acknowledgements report an
  invisible recipient exactly as they report an absent one.

`npm run test:security` exercises all of the above against a real server; each
check is there because something once failed it.

Two things are deliberate rather than overlooked: anyone who knows your UIN can
message you without authorization, which is how ICQ worked, and the directory
is searchable by nickname and name. Email addresses are never searchable or
disclosed. Close sign-ups with `--no-registration` once your friends are in.

If you find something, open an issue rather than a pull request.

## Licence

MIT. See [LICENSE](LICENSE).

Independent clean-room reimplementation. Not affiliated with ICQ, AOL,
Mirabilis or VK. No original code, artwork or audio is included — the flowers
are SVG drawn by hand and the sounds are generated at runtime.
