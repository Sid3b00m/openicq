/* OpenICQ client: sign-on, contact list, chat windows and the glue between
   the server protocol and the window manager. */

(function (global) {
  'use strict';

  const { flower, glyph, hydrate, statusLabel } = global.ICQIcons;
  const esc = Win.escapeHtml;

  const SELECTABLE_STATUSES = ['online', 'ffc', 'away', 'na', 'occupied', 'dnd', 'invisible'];
  const HISTORY_LIMIT = 300;
  const TYPING_IDLE_MS = 2500;

  const state = {
    me: null,
    status: 'offline',
    statusMessage: '',
    contacts: new Map(), // uin -> contact
    chats: new Map(), // uin -> chat
    pendingAuth: [],
    mainWin: null,
    selected: null,
    presenceReady: false,
    collapsed: new Set(),
  };

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  const el = (id) => document.getElementById(id);

  function clockString(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function dateString(ts) {
    return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  }

  const SMILEYS = [
    [/:-?\)/g, '\u{1F642}'],
    [/:-?\(/g, '\u{1F641}'],
    [/;-?\)/g, '\u{1F609}'],
    [/:-?D/g, '\u{1F603}'],
    [/:-?P/gi, '\u{1F61B}'],
    [/:-?O/gi, '\u{1F62E}'],
    [/:'-?\(/g, '\u{1F622}'],
    [/<3/g, '\u2764\uFE0F'],
    [/\bO:-?\)/g, '\u{1F607}'],
  ];

  function renderBody(text) {
    let html = esc(text);
    html = html.replace(/\bhttps?:\/\/[^\s<]+/g, (url) => {
      const safe = esc(url);
      return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${safe}</a>`;
    });
    for (const [pattern, emoji] of SMILEYS) html = html.replace(pattern, emoji);
    return html;
  }

  /** Win98-style prompt box; resolves to the typed string or null. */
  function promptBox({ title, icon, label, value = '', placeholder = '', multiline = false, okLabel = 'OK' }) {
    return new Promise((resolve) => {
      const body = document.createElement('div');
      body.innerHTML =
        `<label>${esc(label)}</label>` +
        (multiline
          ? `<textarea class="field" rows="3" placeholder="${esc(placeholder)}"></textarea>`
          : `<input class="field" placeholder="${esc(placeholder)}" />`) +
        `<div class="button-row">` +
        `<button type="button" class="btn default" data-ok>${esc(okLabel)}</button>` +
        `<button type="button" class="btn" data-cancel>Cancel</button></div>`;

      const input = body.querySelector('.field');
      input.value = value;

      const box = Win.create({
        title: title || 'OpenICQ',
        icon: icon || glyph('info'),
        width: 330,
        body,
        center: true,
        resizable: false,
        minimizable: false,
        taskbar: false,
        onClose: () => resolve(null),
      });
      box.el.style.height = 'auto';

      const done = (result) => {
        box.onClose = null;
        box.close();
        resolve(result);
      };

      body.querySelector('[data-ok]').addEventListener('click', () => done(input.value.trim()));
      body.querySelector('[data-cancel]').addEventListener('click', () => done(null));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !multiline) done(input.value.trim());
        if (e.key === 'Escape') done(null);
      });
      setTimeout(() => input.focus(), 30);
    });
  }

  function notify(title, message, sound) {
    return Win.dialog({ title, icon: glyph('info'), message, sound });
  }

  // ---------------------------------------------------------------------
  // Local message history
  // ---------------------------------------------------------------------

  function historyKey(uin) {
    return `openicq.history.${state.me?.uin}.${uin}`;
  }

  function loadHistory(uin) {
    try {
      return JSON.parse(localStorage.getItem(historyKey(uin)) || '[]');
    } catch {
      return [];
    }
  }

  function saveHistory(uin, entries) {
    try {
      localStorage.setItem(historyKey(uin), JSON.stringify(entries.slice(-HISTORY_LIMIT)));
    } catch {
      /* quota exhausted: history is best-effort */
    }
  }

  function pushHistory(uin, entry) {
    const entries = loadHistory(uin);
    entries.push(entry);
    saveHistory(uin, entries);
  }

  // ---------------------------------------------------------------------
  // Sign on
  // ---------------------------------------------------------------------

  function initSignon() {
    const select = el('signon-status');
    select.innerHTML = SELECTABLE_STATUSES.map(
      (s) => `<option value="${s}">${esc(statusLabel(s))}</option>`
    ).join('');

    const savedUin = localStorage.getItem('openicq.uin');
    if (savedUin) {
      el('signon-uin').value = savedUin;
      setTimeout(() => el('signon-password').focus(), 60);
    }

    el('signon-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const uin = el('signon-uin').value.trim();
      const password = el('signon-password').value;
      if (!uin || !password) return;

      setSignonError('');
      el('signon-submit').disabled = true;
      el('signon-submit').textContent = 'Signing on\u2026';

      if (el('signon-remember').checked) localStorage.setItem('openicq.uin', uin);
      else localStorage.removeItem('openicq.uin');

      Net.send('login', { uin, password, status: select.value });
    });

    el('signon-register').addEventListener('click', openRegisterWindow);
  }

  function setSignonError(message) {
    el('signon-error').textContent = message || '';
    el('signon-submit').disabled = false;
    el('signon-submit').textContent = 'Sign On';
  }

  function openRegisterWindow() {
    const body = document.createElement('div');
    body.innerHTML = `
      <p style="margin:0 0 8px">Pick a nickname and a password. The server hands you the next free UIN.</p>
      <label>Nickname *</label><input class="field" data-f="nick" maxlength="24" />
      <label>Password * <span class="hint">(6 characters or more)</span></label>
      <input class="field" type="password" data-f="password" />
      <label>Confirm password *</label><input class="field" type="password" data-f="confirm" />
      <hr />
      <label>First name</label><input class="field" data-f="firstName" />
      <label>Last name</label><input class="field" data-f="lastName" />
      <label>E-mail</label><input class="field" data-f="email" />
      <label>City</label><input class="field" data-f="city" />
      <div class="error-text" data-err></div>
      <div class="button-row">
        <button type="button" class="btn default" data-ok>Create UIN</button>
        <button type="button" class="btn" data-cancel>Cancel</button>
      </div>`;

    const box = Win.create({
      id: 'register',
      title: 'Register a new UIN',
      icon: glyph('user-add'),
      width: 330,
      height: 470,
      body,
      center: true,
      taskbar: false,
      onClose: () => {
        state.registerBox = null;
        state.registerError = null;
      },
    });

    const field = (name) => body.querySelector(`[data-f="${name}"]`);
    const err = body.querySelector('[data-err]');

    body.querySelector('[data-cancel]').addEventListener('click', () => box.close());
    body.querySelector('[data-ok]').addEventListener('click', () => {
      const nick = field('nick').value.trim();
      const password = field('password').value;

      if (nick.length < 2) return (err.textContent = 'Nickname must be at least 2 characters.');
      if (password.length < 8) return (err.textContent = 'Password must be at least 8 characters.');
      if (password !== field('confirm').value) return (err.textContent = 'Passwords do not match.');

      err.textContent = '';
      Net.send('register', {
        nick,
        password,
        firstName: field('firstName').value.trim(),
        lastName: field('lastName').value.trim(),
        email: field('email').value.trim(),
        profile: { city: field('city').value.trim() },
      });
    });

    state.registerBox = box;
    state.registerError = err;
    setTimeout(() => field('nick').focus(), 40);
  }

  // ---------------------------------------------------------------------
  // Main contact list window
  // ---------------------------------------------------------------------

  function openMainWindow() {
    const body = document.createElement('div');
    body.style.padding = '0';
    body.style.gap = '5px';
    body.innerHTML = `
      <div class="icq-header">
        <span data-me-flower></span>
        <div style="min-width:0">
          <div class="me-nick"></div>
          <div class="me-uin"></div>
        </div>
      </div>
      <div class="search-row">
        <input class="field" data-filter placeholder="Filter contacts\u2026" />
      </div>
      <div class="contact-list" data-list></div>
      <div class="icq-footer">
        <button type="button" class="btn slim status-button" data-status></button>
        <button type="button" class="btn slim" data-add>Add/Find</button>
        <button type="button" class="btn slim" data-main>Main</button>
      </div>`;

    const area = el('desktop').getBoundingClientRect();
    const win = Win.create({
      id: 'main',
      title: 'OpenICQ',
      icon: flower(state.status),
      className: 'icq-window',
      width: 212,
      height: Math.min(470, area.height - 20),
      x: Math.max(6, area.width - 230),
      y: 10,
      body,
      closable: false,
      onClose: () => false,
    });
    win.bodyEl.style.padding = '0 0 2px';

    state.mainWin = win;
    state.listEl = body.querySelector('[data-list]');
    state.statusBtn = body.querySelector('[data-status]');
    state.meFlower = body.querySelector('[data-me-flower]');
    body.querySelector('.me-nick').textContent = state.me.nick;
    body.querySelector('.me-uin').textContent = `UIN ${state.me.uin}`;

    body.querySelector('[data-filter]').addEventListener('input', (e) => {
      state.filter = e.target.value.trim().toLowerCase();
      renderContacts();
    });
    body.querySelector('[data-add]').addEventListener('click', openFindWindow);
    body.querySelector('[data-main]').addEventListener('click', (e) => {
      const r = e.target.getBoundingClientRect();
      openMainMenu(r.left, r.top);
    });
    state.statusBtn.addEventListener('click', (e) => {
      const r = e.target.closest('button').getBoundingClientRect();
      openStatusMenu(r.left, r.top);
    });

    updateMyStatusUi();
    renderContacts();
  }

  function updateMyStatusUi() {
    const svg = flower(state.status);
    if (state.meFlower) state.meFlower.innerHTML = svg;
    if (state.statusBtn) {
      state.statusBtn.innerHTML = `${svg}<span>${esc(statusLabel(state.status))}</span>`;
    }
    state.mainWin?.setIcon(svg);
    const tray = el('tray-flower');
    tray.innerHTML = svg;
    tray.title = statusLabel(state.status) + (state.statusMessage ? ` \u2013 ${state.statusMessage}` : '');
  }

  function sortedContacts() {
    const list = [...state.contacts.values()];
    if (state.filter) {
      return list.filter((c) =>
        `${c.nick} ${c.firstName} ${c.lastName} ${c.uin}`.toLowerCase().includes(state.filter)
      );
    }
    return list;
  }

  function renderContacts() {
    const listEl = state.listEl;
    if (!listEl) return;

    const all = sortedContacts();
    const online = all
      .filter((c) => c.status !== 'offline')
      .sort((a, b) => a.nick.localeCompare(b.nick));
    const offline = all
      .filter((c) => c.status === 'offline')
      .sort((a, b) => a.nick.localeCompare(b.nick));

    listEl.innerHTML = '';

    if (!state.contacts.size) {
      listEl.innerHTML =
        '<div class="list-empty">Your contact list is empty.<br />Use <b>Add/Find</b> to look somebody up by UIN or nickname.</div>';
      return;
    }

    addGroup(listEl, `Online (${online.length})`, 'online', online);
    addGroup(listEl, `Offline (${offline.length})`, 'offline', offline);

    if (state.filter && !online.length && !offline.length) {
      listEl.innerHTML = '<div class="list-empty">No contacts match that filter.</div>';
    }
  }

  function addGroup(parent, label, key, contacts) {
    const header = document.createElement('div');
    const collapsed = state.collapsed.has(key);
    header.className = `group-header${collapsed ? ' collapsed' : ''}`;
    header.innerHTML = `<span>${esc(label)}</span>`;
    header.addEventListener('click', () => {
      if (collapsed) state.collapsed.delete(key);
      else state.collapsed.add(key);
      renderContacts();
    });
    parent.appendChild(header);
    if (collapsed) return;

    for (const contact of contacts) parent.appendChild(contactRow(contact));
  }

  function contactRow(contact) {
    const chat = state.chats.get(contact.uin);
    const unread = chat && chat.unread > 0;

    const row = document.createElement('div');
    row.className = 'contact';
    if (contact.status === 'offline') row.classList.add('offline');
    if (!contact.authorized) row.classList.add('pending');
    if (unread) row.classList.add('has-message');
    if (state.selected === contact.uin) row.classList.add('selected');

    const icon = unread ? glyph('message-new') : flower(contact.status);
    const badge = !contact.authorized
      ? '<span class="badge">waiting</span>'
      : contact.statusMessage
        ? `<span class="badge" title="${esc(contact.statusMessage)}">\u2022</span>`
        : '';

    row.innerHTML = `${icon}<span class="name">${esc(contact.nick)}</span>${badge}`;
    row.title = `${contact.nick} (UIN ${contact.uin}) \u2013 ${statusLabel(contact.status)}${
      contact.statusMessage ? `\n${contact.statusMessage}` : ''
    }`;

    row.addEventListener('click', () => {
      state.selected = contact.uin;
      renderContacts();
    });
    row.addEventListener('dblclick', () => openChat(contact.uin));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      state.selected = contact.uin;
      renderContacts();
      openContactMenu(e.clientX, e.clientY, contact);
    });

    return row;
  }

  function openContactMenu(x, y, contact) {
    Win.menu(x, y, [
      { label: 'Message', icon: glyph('message'), action: () => openChat(contact.uin) },
      { label: 'User Info', icon: glyph('info'), action: () => Net.send('get-info', { uin: contact.uin }) },
      { label: 'Message History', icon: glyph('history'), action: () => openHistory(contact) },
      '-',
      {
        label: 'Remove From List',
        icon: glyph('trash'),
        action: async () => {
          const ok = await Win.dialog({
            title: 'Remove Contact',
            icon: glyph('trash'),
            message: `Remove ${contact.nick} (UIN ${contact.uin}) from your contact list?`,
            buttons: [
              { label: 'Remove', value: true, default: true },
              { label: 'Cancel', value: false },
            ],
          });
          if (ok) Net.send('remove-contact', { uin: contact.uin });
        },
      },
    ]);
  }

  function openStatusMenu(x, y) {
    const items = SELECTABLE_STATUSES.map((status) => ({
      label: statusLabel(status),
      icon: flower(status),
      action: () => changeStatus(status),
    }));

    items.push('-', {
      label: 'Set status message\u2026',
      icon: glyph('gear'),
      action: async () => {
        const text = await promptBox({
          title: 'Status Message',
          label: 'Shown to contacts next to your status:',
          value: state.statusMessage,
          placeholder: 'Back in 5 minutes',
        });
        if (text !== null) {
          state.statusMessage = text;
          Net.send('set-status', { status: state.status, statusMessage: text });
        }
      },
    });

    Win.menu(x, y - 10 - items.length * 22, items);
  }

  function changeStatus(status) {
    const needsMessage = ['away', 'na', 'occupied', 'dnd'].includes(status);
    state.status = status;
    updateMyStatusUi();
    Net.send('set-status', { status, statusMessage: needsMessage ? state.statusMessage : '' });
  }

  function openMainMenu(x, y) {
    const items = [
      { label: 'My Details\u2026', icon: glyph('user'), action: openMyDetails },
      { label: 'Add/Find Users\u2026', icon: glyph('search'), action: openFindWindow },
      { label: 'Change Password\u2026', icon: glyph('key'), action: openChangePassword },
      '-',
      {
        label: `Sounds: ${Sounds.isEnabled() ? 'On' : 'Off'}`,
        icon: glyph('gear'),
        action: () => Sounds.setEnabled(!Sounds.isEnabled()),
      },
      { label: 'Server\u2026', icon: glyph('gear'), action: openServerSettings },
      '-',
      { label: 'Sign Off', icon: glyph('exit'), action: signOff },
    ];
    Win.menu(x, y - 10 - items.length * 22, items);
  }

  function openServerSettings() {
    promptBox({
      title: 'Server',
      icon: glyph('gear'),
      label: 'Server address (host:port). Leave empty to use this page\u2019s host.',
      value: localStorage.getItem(Net.serverKey) || '',
      placeholder: 'icq.example.com:5190',
      okLabel: 'Save',
    }).then((value) => {
      if (value === null) return;
      Net.setServer(value);
      notify('Server', 'Saved. The client will use it after you reload the page.');
    });
  }

  function openMyDetails() {
    const me = state.me;
    const body = document.createElement('div');
    body.innerHTML = `
      <fieldset><legend>UIN ${esc(me.uin)}</legend>
        <label>Nickname</label><input class="field" data-f="nick" maxlength="24" />
        <label>First name</label><input class="field" data-f="firstName" />
        <label>Last name</label><input class="field" data-f="lastName" />
        <label>E-mail</label><input class="field" data-f="email" />
        <label>City</label><input class="field" data-f="city" />
        <label>Country</label><input class="field" data-f="country" />
        <label>Homepage</label><input class="field" data-f="homepage" />
        <label>About</label><textarea class="field" rows="3" data-f="about"></textarea>
        <label class="check"><input type="checkbox" data-f="requireAuth" />
          <span>Require my authorization before someone adds me</span></label>
      </fieldset>
      <div class="button-row">
        <button type="button" class="btn default" data-save>Save</button>
        <button type="button" class="btn" data-close>Close</button>
      </div>`;

    const box = Win.create({
      id: 'my-details',
      title: 'My Details',
      icon: glyph('user'),
      width: 330,
      height: 470,
      body,
      center: true,
    });
    box.bodyEl.classList.add('scroll-body');

    const f = (name) => body.querySelector(`[data-f="${name}"]`);
    f('nick').value = me.nick;
    f('firstName').value = me.firstName || '';
    f('lastName').value = me.lastName || '';
    f('email').value = me.email || '';
    f('city').value = me.profile?.city || '';
    f('country').value = me.profile?.country || '';
    f('homepage').value = me.profile?.homepage || '';
    f('about').value = me.profile?.about || '';
    f('requireAuth').checked = me.requireAuth !== false;

    body.querySelector('[data-close]').addEventListener('click', () => box.close());
    body.querySelector('[data-save]').addEventListener('click', () => {
      Net.send('update-profile', {
        nick: f('nick').value.trim(),
        firstName: f('firstName').value.trim(),
        lastName: f('lastName').value.trim(),
        email: f('email').value.trim(),
        requireAuth: f('requireAuth').checked,
        profile: {
          city: f('city').value.trim(),
          country: f('country').value.trim(),
          homepage: f('homepage').value.trim(),
          about: f('about').value.trim(),
        },
      });
      box.close();
    });
  }

  function openChangePassword() {
    const body = document.createElement('div');
    body.innerHTML = `
      <label>Current password</label><input class="field" type="password" data-f="current" />
      <label>New password</label><input class="field" type="password" data-f="next" />
      <label>Confirm new password</label><input class="field" type="password" data-f="confirm" />
      <div class="error-text" data-err></div>
      <div class="button-row">
        <button type="button" class="btn default" data-ok>Change</button>
        <button type="button" class="btn" data-cancel>Cancel</button>
      </div>`;

    const box = Win.create({
      id: 'change-password',
      title: 'Change Password',
      icon: glyph('key'),
      width: 320,
      body,
      center: true,
      resizable: false,
      taskbar: false,
    });
    box.el.style.height = 'auto';

    const f = (n) => body.querySelector(`[data-f="${n}"]`);
    const err = body.querySelector('[data-err]');

    body.querySelector('[data-cancel]').addEventListener('click', () => box.close());
    body.querySelector('[data-ok]').addEventListener('click', () => {
      if (f('next').value !== f('confirm').value) {
        err.textContent = 'New passwords do not match.';
        return;
      }
      Net.send('change-password', { current: f('current').value, next: f('next').value });
      box.close();
    });
  }

  // ---------------------------------------------------------------------
  // Find / add users
  // ---------------------------------------------------------------------

  function openFindWindow() {
    const body = document.createElement('div');
    body.innerHTML = `
      <label>Search by UIN, nickname, name or e-mail</label>
      <div style="display:flex;gap:5px">
        <input class="field" data-q placeholder="e.g. 100001 or alice" />
        <button type="button" class="btn slim" data-go>Search</button>
      </div>
      <div class="result-list" data-results></div>
      <div class="hint" data-count></div>`;

    const box = Win.create({
      id: 'find',
      title: 'Find / Add Users',
      icon: glyph('search'),
      width: 360,
      height: 330,
      body,
      center: true,
      onClose: () => {
        state.findBox = null;
        state.findResults = null;
      },
    });

    const input = body.querySelector('[data-q]');
    const run = () => {
      const query = input.value.trim();
      if (!query) return;
      state.lastQuery = query;
      Net.send('search', { query });
    };

    body.querySelector('[data-go]').addEventListener('click', run);
    input.addEventListener('keydown', (e) => e.key === 'Enter' && run());
    setTimeout(() => input.focus(), 40);

    state.findBox = box;
    state.findResults = body.querySelector('[data-results]');
    state.findCount = body.querySelector('[data-count]');
  }

  function renderSearchResults(msg) {
    const list = state.findResults;
    if (!list) return;

    list.innerHTML = '';
    state.findCount.textContent = `${msg.results.length} result${msg.results.length === 1 ? '' : 's'} for "${msg.query}"`;

    if (!msg.results.length) {
      list.innerHTML = '<div class="list-empty">Nobody found. Try the exact UIN.</div>';
      return;
    }

    for (const user of msg.results) {
      const row = document.createElement('div');
      row.className = 'result-row';
      const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
      row.innerHTML =
        `${flower(user.status)}<span class="grow"><b>${esc(user.nick)}</b> ` +
        `<span class="hint">UIN ${esc(user.uin)}${name ? ` \u2013 ${esc(name)}` : ''}</span></span>` +
        `<button type="button" class="btn slim" ${user.onList ? 'disabled' : ''}>` +
        `${user.onList ? 'On list' : 'Add'}</button>`;

      row.querySelector('button').addEventListener('click', async () => {
        const reason = await promptBox({
          title: 'Request Authorization',
          icon: glyph('user-add'),
          label: `Message to ${user.nick} (optional):`,
          value: `Hi, I would like to add you to my contact list.`,
          okLabel: 'Send Request',
        });
        if (reason === null) return;
        Net.send('add-contact', { uin: user.uin, reason });
      });

      row.addEventListener('dblclick', () => Net.send('get-info', { uin: user.uin }));
      list.appendChild(row);
    }
  }

  function showUserInfo(user) {
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
    const rows = [
      ['UIN', user.uin],
      ['Nickname', user.nick],
      ['Name', name],
      ['Status', statusLabel(user.status || 'offline')],
      ['Status message', user.statusMessage],
      ['City', user.profile?.city],
      ['Country', user.profile?.country],
      ['Homepage', user.profile?.homepage],
      ['Member since', user.created ? dateString(user.created) : ''],
      ['Last seen', user.lastSeen ? `${dateString(user.lastSeen)} ${clockString(user.lastSeen)}` : 'never'],
      ['About', user.profile?.about],
    ].filter(([, value]) => value);

    const body = document.createElement('div');
    body.innerHTML =
      `<div style="display:flex;gap:9px;align-items:center;margin-bottom:8px">` +
      `<span style="width:34px;display:inline-block">${flower(user.status || 'offline')}</span>` +
      `<div><div style="font-weight:bold;font-size:14px">${esc(user.nick)}</div>` +
      `<div class="hint">UIN ${esc(user.uin)}</div></div></div>` +
      `<dl class="info-grid">` +
      rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('') +
      `</dl><div class="button-row">` +
      `<button type="button" class="btn" data-msg>Message</button>` +
      `<button type="button" class="btn default" data-close>Close</button></div>`;

    const box = Win.create({
      id: `info-${user.uin}`,
      title: `Info: ${user.nick}`,
      icon: glyph('info'),
      width: 320,
      height: 330,
      body,
      center: true,
    });
    box.bodyEl.classList.add('scroll-body');

    body.querySelector('[data-close]').addEventListener('click', () => box.close());
    body.querySelector('[data-msg]').addEventListener('click', () => {
      openChat(user.uin, user.nick);
      box.close();
    });
  }

  // ---------------------------------------------------------------------
  // Chat windows
  // ---------------------------------------------------------------------

  function peerName(uin, fallback) {
    return state.contacts.get(uin)?.nick || fallback || `UIN ${uin}`;
  }

  function openChat(uin, fallbackNick, background) {
    let chat = state.chats.get(uin);
    if (chat) {
      chat.unread = 0;
      if (!background) {
        chat.win.focus();
        chat.input.focus();
      }
      renderContacts();
      return chat;
    }

    const contact = state.contacts.get(uin);
    const nick = peerName(uin, fallbackNick);

    const body = document.createElement('div');
    body.style.padding = '0';
    body.innerHTML = `
      <div class="chat-head">
        <span data-head-flower></span>
        <div style="min-width:0">
          <div class="who"></div>
          <div class="meta"></div>
        </div>
      </div>
      <div class="chat-log" data-log></div>
      <div class="chat-compose">
        <textarea class="field" data-input placeholder="Type a message and press Enter\u2026"></textarea>
        <div class="chat-actions">
          <span class="typing-note" data-typing></span>
          <span class="hint">Shift+Enter = new line</span>
          <button type="button" class="btn" data-send>Send</button>
        </div>
      </div>`;

    const win = Win.create({
      id: `chat-${uin}`,
      title: `${nick} (${uin})`,
      icon: glyph('message'),
      className: 'chat-window',
      width: 430,
      height: 380,
      body,
      focusOnCreate: !background,
      onClose: () => {
        state.chats.delete(uin);
        renderContacts();
      },
      onFocus: () => {
        const c = state.chats.get(uin);
        if (c) {
          c.unread = 0;
          c.win.setIcon(glyph('message'));
          renderContacts();
        }
      },
    });
    win.bodyEl.style.padding = '4px';
    win.bodyEl.style.gap = '4px';

    chat = {
      uin,
      nick,
      win,
      log: body.querySelector('[data-log]'),
      input: body.querySelector('[data-input]'),
      typingEl: body.querySelector('[data-typing]'),
      headFlower: body.querySelector('[data-head-flower]'),
      who: body.querySelector('.who'),
      meta: body.querySelector('.meta'),
      unread: 0,
      typingSentAt: 0,
    };
    state.chats.set(uin, chat);
    updateChatHead(chat);

    const send = () => {
      const text = chat.input.value.replace(/\s+$/, '');
      if (!text) return;
      chat.input.value = '';
      const ref = `r${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
      Net.send('message', { to: uin, body: text, id: ref });
      Net.send('typing', { to: uin, state: 'stop' });
      appendLine(chat, { who: 'me', nick: state.me.nick, body: text, ts: Date.now(), ref });
      pushHistory(uin, { dir: 'out', body: text, ts: Date.now() });
      Sounds.play('sent');
    };

    body.querySelector('[data-send]').addEventListener('click', send);
    chat.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
        return;
      }
      const now = Date.now();
      if (now - chat.typingSentAt > TYPING_IDLE_MS) {
        chat.typingSentAt = now;
        Net.send('typing', { to: uin, state: 'start' });
      }
    });

    // Replay what we said before, so reopening a window is not amnesia.
    const history = loadHistory(uin);
    if (history.length) {
      const recent = history.slice(-40);
      appendSystem(chat, `\u2014 ${recent.length} earlier message${recent.length === 1 ? '' : 's'} \u2014`);
      for (const entry of recent) {
        appendLine(chat, {
          who: entry.dir === 'out' ? 'me' : 'them',
          nick: entry.dir === 'out' ? state.me.nick : nick,
          body: entry.body,
          ts: entry.ts,
          quiet: true,
        });
      }
      appendSystem(chat, '\u2014 end of history \u2014');
    }

    if (contact && !contact.authorized) {
      appendSystem(chat, 'This contact has not authorized you yet. Messages still go through.');
    }

    if (!background) setTimeout(() => chat.input.focus(), 50);
    return chat;
  }

  function updateChatHead(chat) {
    const contact = state.contacts.get(chat.uin);
    const status = contact?.status || 'offline';
    chat.headFlower.innerHTML = flower(status);
    chat.who.textContent = chat.nick;
    chat.meta.textContent =
      `UIN ${chat.uin} \u2013 ${statusLabel(status)}` +
      (contact?.statusMessage ? ` \u2013 ${contact.statusMessage}` : '');
  }

  function appendLine(chat, { who, nick, body, ts, quiet }) {
    const atBottom = chat.log.scrollHeight - chat.log.scrollTop - chat.log.clientHeight < 40;
    const line = document.createElement('div');
    line.className = `line ${who}`;
    line.innerHTML =
      `<span class="who">${esc(nick)}</span>` +
      `<span class="stamp">${clockString(ts)}</span><br />${renderBody(body)}`;
    chat.log.appendChild(line);
    if (atBottom || !quiet) chat.log.scrollTop = chat.log.scrollHeight;
    return line;
  }

  function appendSystem(chat, text, extraClass) {
    const line = document.createElement('div');
    line.className = `line system ${extraClass || ''}`;
    line.textContent = text;
    chat.log.appendChild(line);
    chat.log.scrollTop = chat.log.scrollHeight;
  }

  function openHistory(contact) {
    const entries = loadHistory(contact.uin);
    const body = document.createElement('div');

    if (!entries.length) {
      body.innerHTML = '<div class="list-empty">No stored history with this contact.</div>';
    } else {
      body.innerHTML =
        `<div class="chat-log" style="flex:1">` +
        entries
          .map(
            (e) =>
              `<div class="line ${e.dir === 'out' ? 'me' : 'them'}">` +
              `<span class="who">${esc(e.dir === 'out' ? state.me.nick : contact.nick)}</span>` +
              `<span class="stamp">${dateString(e.ts)} ${clockString(e.ts)}</span><br />` +
              `${renderBody(e.body)}</div>`
          )
          .join('') +
        `</div>`;
    }

    const clear = document.createElement('div');
    clear.className = 'button-row';
    clear.innerHTML = '<button type="button" class="btn">Clear History</button>';
    body.appendChild(clear);

    const box = Win.create({
      id: `history-${contact.uin}`,
      title: `History: ${contact.nick}`,
      icon: glyph('history'),
      width: 420,
      height: 360,
      body,
      center: true,
    });

    clear.querySelector('button').addEventListener('click', () => {
      localStorage.removeItem(historyKey(contact.uin));
      box.close();
    });
  }

  // ---------------------------------------------------------------------
  // Incoming events
  // ---------------------------------------------------------------------

  function handleIncomingMessage(msg) {
    const nick = msg.fromNick || peerName(msg.from);
    const chat = openChatQuietly(msg.from, nick);

    if (msg.offline) {
      appendSystem(chat, `Sent while you were offline \u2013 ${dateString(msg.ts)} ${clockString(msg.ts)}`, 'offline-note');
    }
    appendLine(chat, { who: 'them', nick, body: msg.body, ts: msg.ts });
    pushHistory(msg.from, { dir: 'in', body: msg.body, ts: msg.ts });
    chat.typingEl.textContent = '';

    if (!chat.win.isActive || !document.hasFocus()) {
      chat.unread = (chat.unread || 0) + 1;
      chat.win.flash();
      chat.win.setIcon(glyph('message-new'));
      renderContacts();
    }

    Sounds.play('message');
    flashTitle(`Message from ${nick}`);
  }

  /** Open (or find) a chat without stealing focus from whatever the user is doing. */
  function openChatQuietly(uin, nick) {
    return openChat(uin, nick, true);
  }

  let titleTimer = null;
  function flashTitle(text) {
    if (document.hasFocus()) return;
    clearInterval(titleTimer);
    let on = false;
    titleTimer = setInterval(() => {
      document.title = on ? 'OpenICQ' : text;
      on = !on;
    }, 900);
  }

  global.addEventListener('focus', () => {
    clearInterval(titleTimer);
    document.title = 'OpenICQ';
  });

  function applyPresence(uin, status, statusMessage) {
    const contact = state.contacts.get(uin);
    if (!contact) return;

    const before = contact.status;
    contact.status = status;
    contact.statusMessage = statusMessage || '';

    const chat = state.chats.get(uin);
    if (chat) {
      updateChatHead(chat);
      if (before !== status) {
        appendSystem(chat, `${contact.nick} is now ${statusLabel(status)}.`);
      }
    }

    if (state.presenceReady && before !== status) {
      if (before === 'offline') Sounds.play('online');
      else if (status === 'offline') Sounds.play('offline');
    }

    renderContacts();
  }

  function handleAuthRequest(msg) {
    Sounds.play('auth');
    Win.dialog({
      title: 'Authorization Request',
      icon: glyph('user-add'),
      width: 350,
      html:
        `<b>${esc(msg.nick)}</b> <span class="hint">(UIN ${esc(msg.from)})</span> wants to add you ` +
        `to their contact list.` +
        (msg.reason ? `<div class="motd" style="margin-top:8px">${esc(msg.reason)}</div>` : ''),
      buttons: [
        { label: 'Accept', value: 'accept', default: true },
        { label: 'Decline', value: 'decline' },
        { label: 'Later', value: null },
      ],
    }).then((choice) => {
      if (!choice) return;
      const accept = choice === 'accept';
      Net.send('auth-response', { uin: msg.from, accept });
      // Accepting usually means you want them on your list too.
      if (accept && !state.contacts.has(msg.from)) {
        Net.send('add-contact', { uin: msg.from, reason: '' });
      }
    });
  }

  function signOff({ notifyServer = true } = {}) {
    if (notifyServer && Net.isOpen()) Net.send('logout', {});

    for (const chat of [...state.chats.values()]) chat.win.destroy();
    state.chats.clear();
    state.contacts.clear();
    for (const id of ['find', 'my-details', 'change-password']) Win.get(id)?.destroy();

    state.mainWin?.destroy();
    state.mainWin = null;
    state.findBox = null;
    state.findResults = null;
    state.listEl = null;
    state.statusBtn = null;
    state.meFlower = null;
    state.selected = null;
    state.me = null;
    state.status = 'offline';
    state.presenceReady = false;
    updateMyStatusUi();

    el('signon').style.display = '';
    el('signon-password').value = '';
    setSignonError('');
    Sounds.play('offline');
  }

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------

  function wireProtocol() {
    Net.on('net', (e) => {
      const dot = el('connection-dot');
      const stats = el('server-stats');
      dot.className = 'conn-dot';
      if (e.state === 'open') {
        dot.classList.add('online');
        dot.title = 'Connected';
      } else if (e.state === 'closed' || e.state === 'error' || e.state === 'reconnecting') {
        dot.classList.add('offline');
        dot.title = 'Disconnected';
        if (!state.me) stats.textContent = 'server unreachable \u2013 retrying\u2026';
        if (state.me && e.state === 'closed') {
          state.mainWin?.setTitle('OpenICQ (reconnecting\u2026)');
        }
      }
    });

    Net.on('hello', (msg) => {
      el('server-stats').textContent = `${msg.server} ${msg.version} \u2013 ${msg.users} UIN${
        msg.users === 1 ? '' : 's'
      } registered`;
      if (msg.motd) {
        el('signon-motd').hidden = false;
        el('signon-motd').textContent = msg.motd;
      }
      el('signon-register').disabled = !msg.registration;

      // Shown only when the operator runs with --announce-updates.
      if (msg.update && msg.update.version) {
        const note = el('signon-update');
        note.hidden = false;
        note.textContent = `OpenICQ ${msg.update.version} is available.`;
        const link = document.createElement('a');
        link.href = msg.update.url || '#';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Release notes';
        note.append(' ', link);
      }

      // A fresh hello while signed on means the socket dropped and came back.
      // The server no longer knows this session, so send the user back to sign-on.
      if (state.me) {
        signOff({ notifyServer: false });
        notify('Connection', 'Lost the connection to the server. Please sign on again.');
      }
    });

    Net.on('error', (msg) => {
      if (state.registerBox && state.registerError && msg.code.startsWith('bad-')) {
        state.registerError.textContent = msg.message;
        return;
      }
      if (state.registerBox && (msg.code === 'nick-taken' || msg.code === 'registration-closed')) {
        state.registerError.textContent = msg.message;
        return;
      }
      if (!state.me) {
        setSignonError(msg.message);
        Sounds.play('error');
        return;
      }
      notify('OpenICQ', msg.message, 'error');
    });

    Net.on('registered', (msg) => {
      state.registerBox?.close();
      state.registerBox = null;
      el('signon-uin').value = msg.uin;
      localStorage.setItem('openicq.uin', msg.uin);
      Win.dialog({
        title: 'Welcome to OpenICQ',
        icon: glyph('check'),
        html:
          `Your UIN is <b style="font-size:15px">${esc(msg.uin)}</b>.<br /><br />` +
          `Write it down \u2013 it is how people find you. Sign on with it and your password.`,
        sound: 'auth',
      }).then(() => el('signon-password').focus());
    });

    Net.on('welcome', (msg) => {
      state.me = msg.user;
      state.status = msg.status;
      state.statusMessage = msg.statusMessage || '';
      state.contacts = new Map(msg.contacts.map((c) => [c.uin, c]));
      state.presenceReady = false;

      el('signon').style.display = 'none';
      el('signon-submit').disabled = false;
      el('signon-submit').textContent = 'Sign On';

      openMainWindow();
      Sounds.play('signon');

      for (const request of msg.pendingAuth || []) handleAuthRequest(request);

      // Suppress door sounds for the initial presence burst.
      setTimeout(() => {
        state.presenceReady = true;
      }, 1500);
    });

    Net.on('signed-off', () => {});

    Net.on('presence', (msg) => applyPresence(msg.uin, msg.status, msg.statusMessage));

    Net.on('status-changed', (msg) => {
      state.status = msg.status;
      state.statusMessage = msg.statusMessage || '';
      updateMyStatusUi();
    });

    Net.on('message', handleIncomingMessage);

    Net.on('message-echo', (msg) => {
      const chat = openChatQuietly(msg.to, peerName(msg.to));
      appendLine(chat, { who: 'me', nick: state.me.nick, body: msg.body, ts: msg.ts });
    });

    Net.on('ack', (msg) => {
      const chat = state.chats.get(msg.to);
      if (!chat) return;
      if (msg.state === 'queued') {
        appendSystem(chat, 'Stored on the server \u2013 it will arrive when they sign on.', 'offline-note');
      }
    });

    Net.on('typing', (msg) => {
      const chat = state.chats.get(msg.from);
      if (!chat) return;
      if (msg.state === 'start') {
        chat.typingEl.textContent = `${chat.nick} is typing\u2026`;
        clearTimeout(chat.typingTimer);
        chat.typingTimer = setTimeout(() => (chat.typingEl.textContent = ''), 4000);
      } else {
        chat.typingEl.textContent = '';
      }
    });

    Net.on('search-result', renderSearchResults);
    Net.on('user-info', (msg) => showUserInfo(msg.user));

    Net.on('contact-added', (msg) => {
      state.contacts.set(msg.contact.uin, msg.contact);
      renderContacts();
      // Refresh the search window so the row flips to "On list".
      if (state.findBox && state.lastQuery) Net.send('search', { query: state.lastQuery });
      if (msg.pendingAuth) {
        notify('Authorization', `Request sent to ${msg.contact.nick}. They appear offline until they accept.`);
      }
    });

    Net.on('contact-update', (msg) => {
      state.contacts.set(msg.contact.uin, msg.contact);
      renderContacts();
    });

    Net.on('contact-removed', (msg) => {
      state.contacts.delete(msg.uin);
      state.chats.get(msg.uin)?.win.close();
      renderContacts();
    });

    Net.on('auth-request', handleAuthRequest);

    Net.on('auth-result', (msg) => {
      const contact = state.contacts.get(msg.uin);
      if (msg.accepted) {
        if (contact) contact.authorized = true;
        notify('Authorization', `${contact?.nick || msg.nick || `UIN ${msg.uin}`} accepted your request.`, 'auth');
      } else {
        state.contacts.delete(msg.uin);
        notify('Authorization', `${msg.nick || `UIN ${msg.uin}`} declined your request.`);
      }
      renderContacts();
    });

    Net.on('auth-handled', (msg) => {
      state.pendingAuth = state.pendingAuth.filter((p) => p.from !== msg.uin);
    });

    Net.on('profile-updated', (msg) => {
      state.me = msg.user;
      const nickEl = state.mainWin?.el.querySelector('.me-nick');
      if (nickEl) nickEl.textContent = msg.user.nick;
      notify('My Details', 'Your details were saved.');
    });

    Net.on('password-changed', () => notify('Password', 'Your password was changed.'));
  }

  function startClock() {
    const tick = () => (el('clock').textContent = clockString(Date.now()));
    tick();
    setInterval(tick, 15000);
  }

  function init() {
    hydrate(document);
    initSignon();
    wireProtocol();
    startClock();
    Net.connect();

    el('start-button').addEventListener('click', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      if (state.me) openMainMenu(r.left, r.top);
      else Win.menu(r.left, r.top - 60, [{ label: 'Sign on first', disabled: true }]);
    });

    el('tray-flower').addEventListener('click', (e) => {
      if (!state.me) return;
      openStatusMenu(e.clientX - 60, e.clientY);
    });

    document.addEventListener('contextmenu', (e) => {
      if (!e.target.closest('.contact') && !e.target.closest('.chat-log') && !e.target.closest('.field')) {
        e.preventDefault();
      }
    });

    global.addEventListener('beforeunload', (e) => {
      if (!state.me) return;
      e.preventDefault();
      e.returnValue = '';
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
