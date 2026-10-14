/* WebSocket transport with automatic reconnect and a tiny event bus. */

(function (global) {
  'use strict';

  const SERVER_KEY = 'openicq.server';
  const MAX_BACKOFF = 15000;

  function pageScheme() {
    return location.protocol === 'https:' ? 'wss' : 'ws';
  }

  function resolveUrl() {
    const override =
      new URLSearchParams(location.search).get('server') || localStorage.getItem(SERVER_KEY);

    // A bare "host:port" override has to follow the page, not default to ws://:
    // a browser blocks an insecure socket opened from an HTTPS page outright.
    if (override) {
      if (/^wss?:\/\//.test(override)) return override.replace(/\/+$/, '') + '/ws';
      return `${pageScheme()}://${override.replace(/^\/+|\/+$/g, '')}/ws`;
    }

    // Served over file:// (packaged desktop build without a local http origin).
    if (location.protocol === 'file:') return 'ws://localhost:5190/ws';

    return `${pageScheme()}://${location.host}/ws`;
  }

  const listeners = new Map();
  let socket = null;
  let backoff = 500;
  let intentionalClose = false;
  let queue = [];

  function on(type, handler) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(handler);
    return () => listeners.get(type).delete(handler);
  }

  function emit(type, payload) {
    const set = listeners.get(type);
    if (set) for (const handler of set) handler(payload);
    const any = listeners.get('*');
    if (any) for (const handler of any) handler(payload);
  }

  function connect() {
    intentionalClose = false;
    const url = resolveUrl();
    emit('net', { state: 'connecting', url });

    try {
      socket = new WebSocket(url);
    } catch (err) {
      emit('net', { state: 'error', error: String(err) });
      scheduleReconnect();
      return;
    }

    socket.addEventListener('open', () => {
      backoff = 500;
      emit('net', { state: 'open', url });
      const pending = queue;
      queue = [];
      for (const frame of pending) socket.send(frame);
    });

    socket.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg && typeof msg.t === 'string') emit(msg.t, msg);
    });

    socket.addEventListener('close', () => {
      socket = null;
      emit('net', { state: 'closed' });
      if (!intentionalClose) scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      emit('net', { state: 'error' });
    });
  }

  function scheduleReconnect() {
    const delay = backoff;
    backoff = Math.min(MAX_BACKOFF, Math.round(backoff * 1.8));
    emit('net', { state: 'reconnecting', delay });
    setTimeout(() => {
      if (!intentionalClose && !socket) connect();
    }, delay);
  }

  function send(type, payload) {
    const frame = JSON.stringify(Object.assign({ t: type }, payload || {}));
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(frame);
    } else {
      // Hold a small backlog so a message typed mid-reconnect is not lost.
      if (queue.length < 50) queue.push(frame);
      if (!socket) connect();
    }
  }

  function disconnect() {
    intentionalClose = true;
    queue = [];
    if (socket) socket.close(1000, 'client sign off');
  }

  function isOpen() {
    return !!socket && socket.readyState === WebSocket.OPEN;
  }

  function setServer(value) {
    if (value) localStorage.setItem(SERVER_KEY, value);
    else localStorage.removeItem(SERVER_KEY);
  }

  global.Net = { connect, disconnect, send, on, isOpen, setServer, resolveUrl, serverKey: SERVER_KEY };
})(window);
