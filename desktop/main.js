'use strict';

/**
 * Electron shell for OpenICQ.
 *
 * By default it boots a private server process and talks to it over loopback,
 * so the desktop build works with no setup at all. Point OPENICQ_SERVER at a
 * host to join someone else's server instead.
 */

const { app, BrowserWindow, shell, Menu, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const os = require('os');

const REMOTE = process.env.OPENICQ_SERVER || null;

// In a packaged build the server and client are copied into resources/app.
const ROOT = app.isPackaged ? path.join(process.resourcesPath, 'app') : path.join(__dirname, '..');

let serverProcess = null;
let mainWindow = null;

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

function dataFile() {
  return path.join(app.getPath('userData'), 'openicq.json');
}

async function startLocalServer() {
  const port = Number(process.env.OPENICQ_PORT) || (await freePort());

  serverProcess = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(port),
      HOST: '127.0.0.1',
      OPENICQ_DATA: dataFile(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  serverProcess.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  serverProcess.on('exit', (code) => {
    if (code && !app.isQuiting) {
      dialog.showErrorBox('OpenICQ', `The local server exited unexpectedly (code ${code}).`);
    }
  });

  await waitForServer(port);
  return `http://127.0.0.1:${port}`;
}

async function waitForServer(port) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const reachable = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => socket.end(resolve.bind(null, true)));
      socket.once('error', () => resolve(false));
      socket.setTimeout(400, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (reachable) return;
    await new Promise((r) => setTimeout(r, 125));
  }
  throw new Error('local server did not come up');
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 420,
    minHeight: 420,
    title: 'OpenICQ',
    backgroundColor: '#3a6ea5',
    icon: path.join(ROOT, 'public', 'icon.svg'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'OpenICQ',
        submenu: [
          { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => mainWindow.reload() },
          { label: 'Toggle Developer Tools', accelerator: 'F12', role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
    ])
  );

  // External links belong in the user's browser, not in the chat window.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });

  // The window only ever shows our own server; a link that tries to navigate
  // it somewhere else opens in the browser instead.
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== new URL(url).origin) {
      event.preventDefault();
      if (/^https?:\/\//.test(target)) shell.openExternal(target);
    }
  });

  mainWindow.loadURL(url);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Tell the user once if a newer release exists. Nothing is downloaded here;
 * installing is a deliberate act in the browser.
 */
async function checkForUpdate() {
  if (process.env.OPENICQ_UPDATE_CHECK === 'off') return;
  try {
    const update = require(path.join(ROOT, 'server', 'update.js'));
    const current = require(path.join(ROOT, 'package.json')).version;
    const result = await update.checkForUpdate({ currentVersion: current });
    if (!result.updateAvailable || !mainWindow) return;

    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'OpenICQ',
      message: `OpenICQ ${result.latest} is available.`,
      detail: `You are running ${result.current}.`,
      buttons: ['Get it', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) shell.openExternal(result.url);
  } catch {
    /* an update check must never get in the way of using the program */
  }
}

app.whenReady().then(async () => {
  try {
    const url = REMOTE
      ? /^https?:\/\//.test(REMOTE)
        ? REMOTE
        : `http://${REMOTE}`
      : await startLocalServer();
    createWindow(url);
    setTimeout(checkForUpdate, 4000);
  } catch (err) {
    dialog.showErrorBox('OpenICQ', `Could not start: ${err.message}`);
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && mainWindow === null) app.relaunch();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  app.isQuiting = true;
  if (serverProcess) {
    // SIGTERM lets the server flush its database on the way out.
    if (os.platform() === 'win32') serverProcess.kill();
    else serverProcess.kill('SIGTERM');
  }
});
