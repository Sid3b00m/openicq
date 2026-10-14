# Installing OpenICQ

Two halves, and you may only need one of them:

- **[Client](#part-1-the-client)** — you want to *use* OpenICQ on a server that
  already exists, or try it on your own machine.
- **[Server](#part-2-running-a-server)** — you want other people to connect to
  you, over the internet or just your home network.

There is nothing to compile and nothing to `npm install`. The server is plain
Node.js and the client is plain HTML, CSS and JavaScript.

**Contents**

- [Part 1: the client](#part-1-the-client)
- [Part 2: running a server](#part-2-running-a-server)
- [Part 3: hosting it publicly](#part-3-hosting-it-publicly)
- [Part 4: updates](#part-4-updates)
- [Configuration reference](#configuration-reference)
- [Backups and restoring](#backups-and-restoring)
- [Troubleshooting](#troubleshooting)
- [Uninstalling](#uninstalling)

---

## Part 1: the client

### Option A — just use a browser

If somebody already runs a server, you need nothing at all. Open the address
they gave you (`https://icq.example.com`, or `http://192.168.1.50:5190` on a
home network), click **New UIN…**, and pick a nickname and password. The
browser *is* the client: there is no separate program to install.

Your UIN is assigned by the server and is how people find you. Write it down.

### Option B — the desktop app

The desktop build is the same client wrapped in a window, with its own private
server inside it, so it works with no setup and no server to join.

**Install a prebuilt one** from the
[releases page](https://github.com/Sid3b00m/openicq/releases):

| Your system | Download |
| --- | --- |
| Windows | `OpenICQ-Setup-*.exe` (installer) or `OpenICQ-*.exe` (portable, no install) |
| macOS | `OpenICQ-*.dmg` |
| Linux, anything | `OpenICQ-*.AppImage` — `chmod +x` it and run it |
| Debian, Ubuntu | `openicq_*.deb` — `sudo apt install ./openicq_*.deb` |
| Fedora, RHEL | `openicq-*.rpm` — `sudo dnf install ./openicq-*.rpm` |

On macOS the first launch is blocked because the build is unsigned:
**right-click the app → Open → Open**, once.

To point the desktop app at somebody else's server instead of its own:

```sh
OPENICQ_SERVER=icq.example.com npm start      # macOS, Linux
$env:OPENICQ_SERVER="icq.example.com"; npm start   # Windows PowerShell
```

**Build it yourself** instead, if you prefer:

```sh
git clone https://github.com/Sid3b00m/openicq
cd openicq/desktop
npm install
npm start                 # run it

npm run dist              # installer for the system you are on
npm run dist:win          # or :mac / :linux
```

This is the one part of the project that needs `npm install`, because Electron
is a real dependency. The server and the web client never do.

---

## Part 2: running a server

### What you need

**Node.js 18 or newer.** That is the whole list.

```sh
node --version
```

If that fails, install it:

| | |
| --- | --- |
| Windows, macOS | [nodejs.org/download](https://nodejs.org/en/download) |
| Debian, Ubuntu | `sudo apt install nodejs` |
| Fedora, RHEL | `sudo dnf install nodejs` |
| Arch | `sudo pacman -S nodejs` |
| Alpine | `sudo apk add nodejs` |
| openSUSE | `sudo zypper install nodejs` |
| macOS, Homebrew | `brew install node` |

Debian and Ubuntu sometimes ship a version too old. If `node --version` says
less than 18:

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install nodejs
```

### On your own machine

```sh
git clone https://github.com/Sid3b00m/openicq
cd openicq
```

**Windows** — double-click `start.bat`, or:

```powershell
node server\index.js
```

**macOS, Linux**:

```sh
chmod +x start.sh && ./start.sh
```

Then open <http://localhost:5190>.

### Letting your household in

The server already listens on every interface, so other devices on the same
network can reach it at the addresses it printed on startup:

```
  Local    : http://localhost:5190
  Network  : http://192.168.1.50:5190     <- give people this one
```

If nobody else can connect, your firewall is in the way:

```sh
# Linux, ufw
sudo ufw allow 5190/tcp

# Fedora, RHEL
sudo firewall-cmd --add-port=5190/tcp --permanent && sudo firewall-cmd --reload

# macOS: System Settings -> Network -> Firewall -> Options -> allow node
```

```powershell
# Windows, as Administrator
New-NetFirewallRule -DisplayName "OpenICQ" -Direction Inbound -LocalPort 5190 `
  -Protocol TCP -Action Allow
```

That is enough for a home network. **Do not** forward port 5190 from your
router to get at it from outside — put it behind HTTPS instead, which is
[Part 3](#part-3-hosting-it-publicly).

### Keeping it running

On Windows or macOS, the simplest thing is to leave the terminal open. For a
machine that should serve all the time, use the real service setup in
[Part 3](#part-3-hosting-it-publicly) — it works just as well on a LAN-only
box, and gives you restarts-on-crash and nightly backups.

---

## Part 3: hosting it publicly

This assumes a Linux server with a domain name pointed at it. The shape of it:

```
  browser  --HTTPS-->  Caddy or nginx  --HTTP-->  OpenICQ on 127.0.0.1:5190
                       (holds the certificate)    (not reachable from outside)
```

TLS is not optional here. The client only upgrades to encrypted `wss://`
WebSockets when the page itself arrived over HTTPS, so without it every
message and password crosses the network in the clear.

### The scripted way

Install [Caddy](https://caddyserver.com/docs/install) first — it obtains and
renews certificates by itself — then:

```sh
git clone https://github.com/Sid3b00m/openicq
cd openicq
sudo ./deploy/install.sh icq.example.com you@example.com
```

Use your real domain and email. The script:

- installs Node.js if it is missing,
- creates an unprivileged `openicq` system user,
- installs the program to `/opt/openicq` and the database to `/var/lib/openicq`,
- writes `/etc/openicq/openicq.env` with your domain filled in,
- enables a hardened systemd service and a nightly backup timer,
- configures Caddy (or nginx, if that is what it finds) for your domain,
- opens 80 and 443 in `ufw` and keeps 5190 closed.

Running it again upgrades the files in place and leaves your database and
configuration alone.

Then visit `https://icq.example.com`, click **New UIN…**, and you are 100000.

### With Docker instead

```sh
git clone https://github.com/Sid3b00m/openicq
cd openicq/deploy
cp .env.example .env
$EDITOR .env                 # set OPENICQ_ORIGINS to https://your-domain
$EDITOR Caddyfile.docker     # same domain, and your email
docker compose up -d
```

Caddy handles the certificate. OpenICQ is not published to the host, so only
the proxy can reach it; it runs unprivileged, with a read-only root filesystem
and the database on a named volume.

### By hand

Everything the script uses is in [`deploy/`](deploy/), so you can do it
yourself:

```sh
sudo useradd --system --home /var/lib/openicq --shell /usr/sbin/nologin openicq
sudo mkdir -p /opt/openicq /var/lib/openicq /etc/openicq
sudo cp -r server public package.json LICENSE README.md /opt/openicq/
sudo install -m 0755 deploy/backup.sh deploy/update.sh /opt/openicq/
sudo chown -R openicq:openicq /var/lib/openicq
sudo chmod 0700 /var/lib/openicq

sudo cp deploy/openicq.env.example /etc/openicq/openicq.env
sudo $EDITOR /etc/openicq/openicq.env      # at minimum, set OPENICQ_ORIGINS
sudo chmod 0640 /etc/openicq/openicq.env

sudo cp deploy/openicq.service deploy/openicq-backup.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now openicq openicq-backup.timer
```

Then put a proxy in front with [`deploy/Caddyfile`](deploy/Caddyfile) or
[`deploy/nginx.conf`](deploy/nginx.conf) — both already carry the
WebSocket-upgrade and forwarded-header settings OpenICQ expects. With nginx,
finish by running `certbot --nginx -d icq.example.com`.

### The two settings that matter

Whichever route you took, check these in `/etc/openicq/openicq.env`:

```ini
# Your real public URL. Without it, any website can open connections to your
# server using a visitor's browser.
OPENICQ_ORIGINS=https://icq.example.com

# Lets the server see real client addresses instead of the proxy's. Without
# it every visitor looks like 127.0.0.1 and the per-IP limits protect nothing.
OPENICQ_TRUST_PROXY=loopback
```

`systemctl restart openicq` after editing.

### Moving an existing server behind HTTPS

If you already have people on a server they reach as
`http://icq.example.com:5190` — the port in the address, no certificate — this
is the move to make. Accounts and messages come across untouched; what changes
is the address and the fact that passwords stop crossing the network readable.

**First, copy the database somewhere safe.** Everything below is reversible,
but not if the only copy is gone:

```sh
sudo systemctl stop openicq        # or Ctrl+C, if you started it by hand
cp /path/to/your/openicq.json ~/openicq-backup.json
```

Find where that file actually is before you trust the path. Started by hand
from a checkout, it defaults to `data/openicq.json` inside the checkout; under
`--data` or `OPENICQ_DATA`, it is wherever you pointed it. If you are on 0.6.0
or later there is a `history.jsonl` beside it — bring that too.

**Open 80 and 443 to the world.** On a cloud box this means the security group
or firewall rules, not just `ufw`. Caddy and certbot both prove you own the
domain over port 80, so a certificate will never issue while it is shut. This
is the step people miss.

**Put the database where the service expects it**, then run the installer:

```sh
sudo mkdir -p /var/lib/openicq
sudo cp ~/openicq-backup.json /var/lib/openicq/openicq.json
sudo chown -R openicq:openicq /var/lib/openicq

cd /path/to/openicq
git pull
sudo ./deploy/install.sh icq.example.com you@example.com
```

The installer binds OpenICQ to `127.0.0.1`, so port 5190 stops being reachable
from outside and the proxy becomes the only way in. It will not overwrite an
`/etc/openicq/openicq.env` that already exists, so if you had one, set
`OPENICQ_ORIGINS` to your `https://` URL yourself and confirm
`OPENICQ_TRUST_PROXY=loopback` — without the second, every visitor looks like
the proxy and the per-IP limits stop protecting anything.

**Check it worked** before telling anyone the new address:

```sh
curl -sI https://icq.example.com | head -1       # 200, and no port
curl -s  https://icq.example.com/health          # {"ok":true}
sudo ss -ltnp | grep 5190                        # should say 127.0.0.1:5190
```

Then open the site and sign on. The client upgrades itself to `wss://` because
the page arrived over HTTPS; there is nothing to configure for that. Once you
have seen it work, turn on HSTS so browsers stop trying plain HTTP at all:

```sh
echo 'OPENICQ_HSTS=on' | sudo tee -a /etc/openicq/openicq.env
sudo systemctl restart openicq
```

**Tell your users the port is gone.** The address is now
`https://icq.example.com` with no `:5190`. Anyone who typed a custom server
into **Main → Server…** has it saved in their browser and should clear or
update it; a stale `icq.example.com:5190` will try to reach a port that is no
longer open. Plain `http://icq.example.com` still answers, but only to redirect
to HTTPS; the old `:5190` address stops answering at all, which is the point —
leaving it reachable would let people keep signing on in the clear.

### Day-to-day

| | |
| --- | --- |
| Status | `systemctl status openicq` |
| Logs | `journalctl -u openicq -f` |
| Restart | `sudo systemctl restart openicq` |
| Config | `/etc/openicq/openicq.env` |
| Database | `/var/lib/openicq/openicq.json` |
| Backups | `/var/lib/openicq/backups` |

Once your friends all have accounts, stop handing out new ones:

```sh
echo 'OPENICQ_REGISTRATION=off' | sudo tee -a /etc/openicq/openicq.env
sudo systemctl restart openicq
```

---

## Part 4: updates

The server asks GitHub once a day whether a newer release exists. It only ever
reads a version number — nothing is downloaded, and nothing installs itself.
When there is something new you will see it in the log:

```
[openicq] update available: 0.5.0 -> 0.6.0 - https://github.com/Sid3b00m/openicq/releases/tag/v0.6.0
```

Ask at any time:

```sh
node server/index.js --check-update     # or: npm run check-update
sudo /opt/openicq/update.sh --check     # on a systemd install
```

Exit status is 0 if current, 1 if an update exists, 2 if GitHub could not be
reached.

### Installing an update

On a systemd host:

```sh
sudo /opt/openicq/update.sh              # latest release
sudo /opt/openicq/update.sh v0.6.0       # a specific one
```

It snapshots the database, downloads the release, swaps the files, restarts the
service, and **rolls back automatically** if the new version does not stay up.
Your database and `/etc/openicq/openicq.env` are never modified.

With Docker:

```sh
cd openicq && git pull
cd deploy && docker compose up -d --build
```

Run from a git clone:

```sh
git pull && sudo systemctl restart openicq     # or restart it however you run it
```

### Turning the check off

It is a single outbound HTTPS request a day to `api.github.com`, carrying only
your version number. To stop it entirely:

```ini
OPENICQ_UPDATE_CHECK=off
```

or pass `--no-update-check`. Clients are never told about pending updates
unless you opt in with `--announce-updates`, which adds a note to the sign-on
screen for everyone.

### Client updates

The desktop app checks on launch and offers a link to the release page; it
never updates itself. Browser users get the new client automatically, because
the server serves it.

---

## Configuration reference

Every option is both a flag and an environment variable. `node server/index.js
--help` prints the same list.

### Basics

| Flag | Variable | Default | What it does |
| --- | --- | --- | --- |
| `--port <n>` | `PORT` | `5190` | Port to listen on |
| `--host <addr>` | `HOST` | `0.0.0.0` | Address to bind; use `127.0.0.1` behind a proxy |
| `--data <file>` | `OPENICQ_DATA` | `./data/openicq.json` | Database file |
| `--motd <text>` | `OPENICQ_MOTD` | none | Message on the sign-on screen |
| `--no-registration` | `OPENICQ_REGISTRATION=off` | open | Stop handing out new UINs |

### Hosting

| Flag | Variable | Default | What it does |
| --- | --- | --- | --- |
| `--origin <url>` | `OPENICQ_ORIGINS` | any | Browser origins allowed to connect. **Set when public.** |
| `--trust-proxy <l>` | `OPENICQ_TRUST_PROXY` | none | Where `X-Forwarded-For` is believed: `loopback`, `all`, or IPs/CIDRs |
| `--hsts` | `OPENICQ_HSTS=on` | off | Send `Strict-Transport-Security` |
| `--health-details` | `OPENICQ_HEALTH_DETAILS=on` | off | Let `/health` report user and session counts |
| `--max-connections-per-ip <n>` | `OPENICQ_MAX_CONNECTIONS_PER_IP` | `12` | Concurrent sockets per address |
| `--registrations-per-hour <n>` | `OPENICQ_REGISTRATIONS_PER_HOUR` | `5` | New UINs per address per hour |

Raise the last two if real users share one address behind NAT.

### History and rooms

| Flag | Variable | Default | What it does |
| --- | --- | --- | --- |
| `--no-history` | `OPENICQ_HISTORY=off` | on | Keep no message history on the server at all |
| `--history-max <n>` | `OPENICQ_HISTORY_MAX` | `500` | Messages kept per conversation |
| `--history-days <n>` | `OPENICQ_HISTORY_DAYS` | `0` | Delete anything older than n days; `0` keeps them forever |
| `--no-rooms` | `OPENICQ_ROOMS=off` | on | Disable chat rooms |
| `--no-room-creation` | `OPENICQ_ROOM_CREATION=off` | anyone | Rooms stay, but only the operator can add them |

History is what makes a conversation follow you between machines: it is stored
on the server, so a second device sees the same thread. Each side can clear a
conversation for themselves at any time.

### Meshtastic bridge

Bridges a [Meshtastic](https://meshtastic.org) channel onto a chat room, so
radio traffic and browser traffic land in the same place. It needs the MQTT
module switched on at the gateway node, with JSON output enabled.

| Flag | Variable | Default | What it does |
| --- | --- | --- | --- |
| `--mqtt-host <h>` | `OPENICQ_MQTT_HOST` | none | Broker to bridge through; setting it enables the bridge |
| `--mqtt-port <n>` | `OPENICQ_MQTT_PORT` | `1883`, or `8883` with TLS | Broker port |
| `--mqtt-tls` | `OPENICQ_MQTT_TLS=on` | off | Connect to the broker over TLS |
| `--mqtt-user <u>` | `OPENICQ_MQTT_USER` | none | Broker username |
| `--mqtt-password <p>` | `OPENICQ_MQTT_PASSWORD` | none | Broker password; prefer the variable so it stays out of `ps` |
| `--mesh-root <t>` | `OPENICQ_MESH_ROOT` | `msh/US` | Topic root, matching the gateway's region |
| `--mesh-channel <c>` | `OPENICQ_MESH_CHANNELS` | `LongFast` | Channel to bridge; repeat the flag for more |

A bridged room is created automatically and cannot be renamed or removed from
the client. Anything said in one is transmitted over the radio, where anyone in
range with the channel key can read it — treat bridged rooms as public.

### Updates

| Flag | Variable | Default | What it does |
| --- | --- | --- | --- |
| `--check-update` | | | Check, report, exit |
| `--no-update-check` | `OPENICQ_UPDATE_CHECK=off` | on | Never contact GitHub |
| `--announce-updates` | `OPENICQ_ANNOUNCE_UPDATES=on` | off | Show pending updates to everyone, not just the log |
| | `OPENICQ_REPO` | `Sid3b00m/openicq` | Which repository to check |
| `--version`, `-v` | | | Print the version and exit |

---

## Backups and restoring

The whole database is one JSON file, so a backup is a copy of it:

```sh
cp /var/lib/openicq/openicq.json ~/openicq-backup.json
```

The systemd install does this nightly into `/var/lib/openicq/backups`,
gzipped, keeping 14. Run one on demand with `sudo /opt/openicq/backup.sh`.

To restore:

```sh
sudo systemctl stop openicq
sudo gunzip -c /var/lib/openicq/backups/openicq-20261014T030000Z.json.gz \
  | sudo tee /var/lib/openicq/openicq.json > /dev/null
sudo chown openicq:openicq /var/lib/openicq/openicq.json
sudo systemctl start openicq
```

Stop the server first. It holds the database in memory and writes the whole
file out, so editing it underneath a running server loses your changes.

---

## Troubleshooting

**"Port 5190 is already in use."** Something else has it, often an OpenICQ you
forgot about. Use `--port 5191`, or find the culprit:

```sh
sudo lsof -i :5190            # macOS, Linux
Get-NetTCPConnection -LocalPort 5190    # Windows
```

**Nobody else on my network can connect.** The firewall; see
[Letting your household in](#letting-your-household-in). Check you gave out the
`Network` address rather than `localhost`, which only means "this machine".

**The page loads but it says "connecting…" forever.** The WebSocket is not
getting through. Behind nginx, that is almost always a missing upgrade header —
use [`deploy/nginx.conf`](deploy/nginx.conf) as written. Behind Cloudflare,
turn WebSocket support on. Check the browser console for the real error.

**"Sign on failed" with the right password.** Sign-on attempts are deliberately
slowed after failures, per address and per account, doubling each time. Wait a
few minutes. The window is 15 minutes from the last failure.

**Everyone is getting rate-limited at once.** Your users probably share one
address behind NAT, and the server cannot tell them apart. Raise
`OPENICQ_MAX_CONNECTIONS_PER_IP`. If you are behind a proxy, the real cause is
usually a missing `OPENICQ_TRUST_PROXY=loopback`, which makes every visitor
look like the same client.

**Browsers are refused but my terminal client works.** `OPENICQ_ORIGINS` does
not match the URL people actually use — check `https://` versus `http://`, and
`www.` versus not. The log names the origin it refused.

**The service will not start.** `journalctl -u openicq -n 50`. If it mentions
the database, the file is probably unreadable or not owned by `openicq`; the
server refuses to start rather than overwrite a database it cannot parse.

**Nothing works after an update.** `update.sh` rolls back on its own, but you
can do it by hand from the copy it left in `/tmp`, or:

```sh
sudo /opt/openicq/update.sh v0.5.0     # go back to a known-good release
```

---

## Uninstalling

```sh
sudo systemctl disable --now openicq openicq-backup.timer
sudo rm /etc/systemd/system/openicq.service /etc/systemd/system/openicq-backup.*
sudo systemctl daemon-reload
sudo rm -rf /opt/openicq /etc/openicq
# Accounts and messages live here. Copy it somewhere first if you want them.
sudo rm -rf /var/lib/openicq
sudo userdel openicq
```

Docker: `docker compose down -v` (the `-v` deletes the database too).

Run from a clone: stop it and delete the directory. There is nothing anywhere
else.
