/* A tiny window manager: draggable/resizable windows, a taskbar, context menus
   and modal dialogs - all with Win98 furniture. */

(function (global) {
  'use strict';

  const layer = () => document.getElementById('windows');
  const taskArea = () => document.getElementById('task-buttons');
  const desktop = () => document.getElementById('desktop');

  const windows = new Map();
  let zTop = 100;
  let cascade = 0;
  let active = null;

  class WinBox {
    constructor(options) {
      this.id = options.id || `win-${Math.random().toString(36).slice(2, 9)}`;
      this.options = options;
      this.minimized = false;
      this.flashing = false;
      this.onClose = options.onClose;
      this.onFocus = options.onFocus;

      this._build(options);
      windows.set(this.id, this);

      if (options.focusOnCreate === false) {
        // Pops to the front but leaves keyboard focus wherever the user had it.
        this.el.style.zIndex = ++zTop;
        this.el.classList.add('inactive');
      } else {
        this.focus();
      }
    }

    _build(o) {
      const el = document.createElement('div');
      el.className = `window ${o.className || ''}`;
      el.dataset.winId = this.id;

      const bar = document.createElement('div');
      bar.className = 'title-bar';
      bar.innerHTML =
        `<span class="title-icon">${o.icon || ''}</span>` +
        `<span class="title-text"></span>` +
        `<span class="title-buttons">` +
        (o.minimizable === false ? '' : '<button class="title-btn" data-act="min" title="Minimize">_</button>') +
        (o.closable === false ? '' : '<button class="title-btn" data-act="close" title="Close">&times;</button>') +
        `</span>`;
      el.appendChild(bar);

      const body = document.createElement('div');
      body.className = 'window-body';
      if (o.body) body.appendChild(o.body);
      el.appendChild(body);

      if (o.resizable !== false) {
        const grip = document.createElement('div');
        grip.className = 'resize-grip';
        el.appendChild(grip);
        this._makeResizable(el, grip, o);
      }

      this.el = el;
      this.bodyEl = body;
      this.titleEl = bar.querySelector('.title-text');
      this.iconEl = bar.querySelector('.title-icon');
      this.setTitle(o.title || 'Window');

      if (o.width) el.style.width = `${o.width}px`;
      if (o.height) el.style.height = `${o.height}px`;

      const pos = this._initialPosition(o);
      el.style.left = `${pos.x}px`;
      el.style.top = `${pos.y}px`;

      bar.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.title-btn')) return;
        this._startDrag(e);
      });
      bar.addEventListener('dblclick', (e) => {
        if (!e.target.closest('.title-btn')) this.minimize();
      });
      bar.addEventListener('click', (e) => {
        const act = e.target.closest('.title-btn')?.dataset.act;
        if (act === 'close') this.close();
        if (act === 'min') this.minimize();
      });
      el.addEventListener('pointerdown', () => this.focus(), true);

      layer().appendChild(el);

      if (o.taskbar !== false) this._buildTaskButton(o);
    }

    _initialPosition(o) {
      const area = desktop().getBoundingClientRect();
      const w = o.width || 320;
      const h = o.height || 240;

      if (typeof o.x === 'number' && typeof o.y === 'number') return { x: o.x, y: o.y };

      if (o.center) {
        return {
          x: Math.max(4, Math.round((area.width - w) / 2)),
          y: Math.max(4, Math.round((area.height - h) / 2)),
        };
      }

      const step = (cascade++ % 9) * 24;
      return {
        x: Math.max(4, Math.min(area.width - w - 4, 60 + step)),
        y: Math.max(4, Math.min(area.height - h - 4, 40 + step)),
      };
    }

    _buildTaskButton(o) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'task-button';
      btn.innerHTML = `<span class="ico">${o.icon || ''}</span><span class="label"></span>`;
      btn.querySelector('.label').textContent = o.title || 'Window';
      btn.addEventListener('click', () => {
        if (this.minimized || active !== this) this.focus();
        else this.minimize();
      });
      taskArea().appendChild(btn);
      this.taskBtn = btn;
    }

    _startDrag(e) {
      const area = desktop().getBoundingClientRect();
      const rect = this.el.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;

      const move = (ev) => {
        const x = clamp(ev.clientX - offsetX - area.left, -rect.width + 60, area.width - 40);
        const y = clamp(ev.clientY - offsetY - area.top, 0, area.height - 24);
        this.el.style.left = `${Math.round(x)}px`;
        this.el.style.top = `${Math.round(y)}px`;
        this.el.style.transform = 'none';
      };
      const up = () => {
        global.removeEventListener('pointermove', move);
        global.removeEventListener('pointerup', up);
      };

      global.addEventListener('pointermove', move);
      global.addEventListener('pointerup', up);
      e.preventDefault();
    }

    _makeResizable(el, grip, o) {
      grip.addEventListener('pointerdown', (e) => {
        const rect = el.getBoundingClientRect();
        const startX = e.clientX;
        const startY = e.clientY;

        const move = (ev) => {
          el.style.width = `${Math.max(o.minWidth || 200, rect.width + ev.clientX - startX)}px`;
          el.style.height = `${Math.max(o.minHeight || 140, rect.height + ev.clientY - startY)}px`;
        };
        const up = () => {
          global.removeEventListener('pointermove', move);
          global.removeEventListener('pointerup', up);
        };

        global.addEventListener('pointermove', move);
        global.addEventListener('pointerup', up);
        e.preventDefault();
        e.stopPropagation();
      });
    }

    setTitle(title) {
      this.titleEl.textContent = title;
      if (this.taskBtn) this.taskBtn.querySelector('.label').textContent = title;
    }

    setIcon(svg) {
      this.iconEl.innerHTML = svg;
      if (this.taskBtn) this.taskBtn.querySelector('.ico').innerHTML = svg;
    }

    focus() {
      this.minimized = false;
      this.el.classList.remove('minimized');
      this.el.style.zIndex = ++zTop;
      this.stopFlashing();

      if (active && active !== this) {
        active.el.classList.add('inactive');
        active.taskBtn?.classList.remove('active');
      }
      active = this;
      this.el.classList.remove('inactive');
      this.taskBtn?.classList.add('active');

      if (this.onFocus) this.onFocus();
      return this;
    }

    minimize() {
      this.minimized = true;
      this.el.classList.add('minimized');
      this.taskBtn?.classList.remove('active');
      if (active === this) active = null;
    }

    flash() {
      if (active === this && !this.minimized && document.hasFocus()) return;
      this.flashing = true;
      this.taskBtn?.classList.add('flashing');
    }

    stopFlashing() {
      this.flashing = false;
      this.taskBtn?.classList.remove('flashing');
    }

    /** Close regardless of what onClose says, used when tearing down a session. */
    destroy() {
      this.onClose = null;
      this.close();
    }

    close() {
      if (this.onClose && this.onClose() === false) return;
      this.el.remove();
      this.taskBtn?.remove();
      windows.delete(this.id);
      if (active === this) active = null;
    }

    get isActive() {
      return active === this && !this.minimized;
    }
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function create(options) {
    if (options.id && windows.has(options.id)) {
      return windows.get(options.id).focus();
    }
    return new WinBox(options);
  }

  function get(id) {
    return windows.get(id) || null;
  }

  // --- context menu -------------------------------------------------------

  function menu(x, y, items) {
    const el = document.getElementById('context-menu');
    el.innerHTML = '';

    for (const item of items) {
      if (item === '-' || item.separator) {
        const sep = document.createElement('div');
        sep.className = 'menu-sep';
        el.appendChild(sep);
        continue;
      }

      const row = document.createElement('div');
      row.className = `menu-item${item.disabled ? ' disabled' : ''}`;
      row.innerHTML = `<span class="ico">${item.icon || ''}</span><span>${escapeHtml(item.label)}</span>`;
      if (!item.disabled) {
        row.addEventListener('click', () => {
          hideMenu();
          item.action?.();
        });
      }
      el.appendChild(row);
    }

    el.hidden = false;
    el.style.left = '0px';
    el.style.top = '0px';
    const rect = el.getBoundingClientRect();
    el.style.left = `${clamp(x, 2, global.innerWidth - rect.width - 4)}px`;
    el.style.top = `${clamp(y, 2, global.innerHeight - rect.height - 4)}px`;
  }

  function hideMenu() {
    const el = document.getElementById('context-menu');
    if (el) el.hidden = true;
  }

  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#context-menu')) hideMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideMenu();
  });

  // --- dialogs ------------------------------------------------------------

  function dialog({ title, icon, message, html, buttons, width = 320, sound }) {
    return new Promise((resolve) => {
      const body = document.createElement('div');
      body.style.display = 'flex';
      body.style.flexDirection = 'column';
      body.style.gap = '10px';

      const content = document.createElement('div');
      content.style.whiteSpace = 'pre-wrap';
      content.style.userSelect = 'text';
      if (html) content.innerHTML = html;
      else content.textContent = message || '';
      body.appendChild(content);

      const row = document.createElement('div');
      row.className = 'button-row';
      body.appendChild(row);

      const box = create({
        title: title || 'OpenICQ',
        icon,
        width,
        body,
        center: true,
        resizable: false,
        minimizable: false,
        taskbar: false,
        onClose: () => resolve(null),
      });

      const list = buttons && buttons.length ? buttons : [{ label: 'OK', value: true, default: true }];
      for (const button of list) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = `btn${button.default ? ' default' : ''}`;
        el.textContent = button.label;
        el.addEventListener('click', () => {
          box.onClose = null;
          box.close();
          resolve(button.value);
        });
        row.appendChild(el);
      }

      box.el.style.height = 'auto';
      row.querySelector('.btn.default, .btn')?.focus();
      if (sound) global.Sounds?.play(sound);
    });
  }

  function escapeHtml(value) {
    return String(value).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  }

  global.Win = { create, get, menu, hideMenu, dialog, escapeHtml, windows };
})(window);
