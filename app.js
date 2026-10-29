(() => {
  'use strict';

  /* ------------------------------------------------------------------
     Константы
     ------------------------------------------------------------------ */

  const STORAGE_KEY = 'vyhod.checklist.v1';
  const COMPLETED_TTL = 60 * 60 * 1000; // готовая проверка «живёт» 1 час
  const PARTIAL_TTL = 6 * 60 * 60 * 1000; // незаконченная — 6 часов
  const CLOCK_SKEW = 5 * 60 * 1000; // допуск на неточные часы устройства
  const MAX_ITEMS = 30;
  const MAX_LABEL = 40;
  const DEFAULT_HINT = 'До 30 пунктов. Нажмите ✕, чтобы удалить.';

  const DEFAULT_ITEMS = [
    { id: 'water', label: 'Закрыть краны с водой', icon: '🚰' },
    { id: 'gas', label: 'Выключить газ и плиту', icon: '🔥' },
    { id: 'iron', label: 'Проверить утюг и приборы', icon: '🔌' },
    { id: 'windows', label: 'Закрыть окна', icon: '🪟' },
    { id: 'lights', label: 'Выключить свет', icon: '💡' },
    { id: 'door', label: 'Закрыть дверь на замок', icon: '🔒' },
    { id: 'keys', label: 'Взять ключи', icon: '🔑' },
  ];

  const DEFAULT_ICONS = new Set(DEFAULT_ITEMS.map((item) => item.icon));

  /* ------------------------------------------------------------------
     Элементы
     ------------------------------------------------------------------ */

  const els = {
    clock: document.getElementById('clock'),
    list: document.getElementById('list'),
    empty: document.getElementById('emptyState'),
    hero: document.getElementById('hero'),
    ringValue: document.getElementById('ringValue'),
    doneCount: document.getElementById('doneCount'),
    totalCount: document.getElementById('totalCount'),
    sectionCount: document.getElementById('sectionCount'),
    heroKicker: document.getElementById('heroKicker'),
    heroStatus: document.getElementById('heroStatus'),
    heroSub: document.getElementById('heroSub'),
    resetBtn: document.getElementById('resetBtn'),
    dialog: document.getElementById('editDialog'),
    closeDialog: document.getElementById('closeDialog'),
    doneEditBtn: document.getElementById('doneEditBtn'),
    restoreBtn: document.getElementById('restoreBtn'),
    addForm: document.getElementById('addForm'),
    newItem: document.getElementById('newItem'),
    editList: document.getElementById('editList'),
    editHint: document.getElementById('editHint'),
    installBtn: document.getElementById('installBtn'),
    toast: document.getElementById('toast'),
  };

  /* ------------------------------------------------------------------
     Состояние и хранилище
     ------------------------------------------------------------------ */

  let state = null;
  let toastTimer = 0;
  let noticeTimer = 0;
  let saveWarned = false;

  const timeFmt = new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  });

  const headerDateFmt = new Intl.DateTimeFormat('ru-RU', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
  });

  function makeId() {
    const c = window.crypto;
    if (c && typeof c.randomUUID === 'function') {
      return c.randomUUID();
    }
    if (c && typeof c.getRandomValues === 'function') {
      const bytes = new Uint8Array(8);
      c.getRandomValues(bytes);
      return 'c' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  // Пользовательский текст никогда не попадает в HTML-разметку.
  function sanitizeLabel(value) {
    if (typeof value !== 'string') return '';
    const clean = value
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return Array.from(clean).slice(0, MAX_LABEL).join('').trim();
  }

  function sanitizeIcon(value) {
    return typeof value === 'string' && DEFAULT_ICONS.has(value) ? value : '📌';
  }

  function normalizeItems(raw) {
    if (!Array.isArray(raw) || raw.length === 0) return null;

    const seen = new Set();
    const items = [];

    for (const candidate of raw) {
      if (!candidate || typeof candidate !== 'object') continue;

      const label = sanitizeLabel(candidate.label);
      if (!label) continue;

      let id =
        typeof candidate.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(candidate.id)
          ? candidate.id
          : makeId();

      let attempts = 0;
      while (seen.has(id) && attempts < 5) {
        id = makeId();
        attempts += 1;
      }
      if (seen.has(id)) continue;

      seen.add(id);
      items.push({ id, label, icon: sanitizeIcon(candidate.icon) });

      if (items.length >= MAX_ITEMS) break;
    }

    return items.length > 0 ? items : null;
  }

  function validTimestamp(value, fallback, now) {
    return Number.isFinite(value) && value > 0 && value <= now + CLOCK_SKEW ? value : fallback;
  }

  function freshState(now = Date.now()) {
    return {
      version: 1,
      items: DEFAULT_ITEMS.map((item) => ({ ...item })),
      checked: Object.create(null),
      startedAt: now,
      completedAt: null,
      lastActivity: now,
    };
  }

  function loadState() {
    const now = Date.now();
    const fallback = freshState(now);

    let stored = null;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      // Отсекаем заведомо мусорные данные до разбора.
      if (raw && raw.length <= 20000) stored = JSON.parse(raw);
    } catch {
      stored = null;
    }

    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
      return fallback;
    }

    const items = normalizeItems(stored.items) || fallback.items;
    const ids = new Set(items.map((item) => item.id));
    const checked = Object.create(null);

    if (stored.checked && typeof stored.checked === 'object' && !Array.isArray(stored.checked)) {
      for (const id of Object.keys(stored.checked)) {
        if (!ids.has(id)) continue;
        const ts = stored.checked[id];
        if (Number.isFinite(ts) && ts > 0 && ts <= now + CLOCK_SKEW) {
          checked[id] = ts;
        }
      }
    }

    const startedAt = validTimestamp(stored.startedAt, now, now);
    const lastActivity = validTimestamp(stored.lastActivity, startedAt, now);

    let completedAt = null;
    const allChecked = items.every((item) => Boolean(checked[item.id]));
    if (allChecked) {
      completedAt = validTimestamp(stored.completedAt, lastActivity, now);
    }

    return {
      version: 1,
      items,
      checked,
      startedAt,
      completedAt,
      lastActivity,
    };
  }

  function saveState() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      if (!saveWarned) {
        saveWarned = true;
        toast('Не удалось сохранить отметки. Проверьте настройки браузера.');
      }
    }
  }

  /* ------------------------------------------------------------------
     Логика проверки
     ------------------------------------------------------------------ */

  function resetSession(now = Date.now()) {
    state.checked = Object.create(null);
    state.startedAt = now;
    state.completedAt = null;
    state.lastActivity = now;
  }

  function expireIfStale(now) {
    const hasChecked = Object.keys(state.checked).length > 0;
    if (!hasChecked) return false;

    const stale = state.completedAt
      ? now - state.completedAt > COMPLETED_TTL
      : now - state.lastActivity > PARTIAL_TTL;

    if (!stale) return false;

    resetSession(now);
    saveState();
    return true;
  }

  function syncCompletion(now = Date.now()) {
    const allChecked =
      state.items.length > 0 && state.items.every((item) => Boolean(state.checked[item.id]));

    state.completedAt = allChecked ? state.completedAt || now : null;
  }

  function countDone() {
    return state.items.reduce(
      (total, item) => total + (state.checked[item.id] ? 1 : 0),
      0,
    );
  }

  function plural(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
  }

  function formatTime(timestamp) {
    return timeFmt.format(new Date(timestamp));
  }

  /* ------------------------------------------------------------------
     Отрисовка
     ------------------------------------------------------------------ */

  function render() {
    const fragment = document.createDocumentFragment();

    for (const item of state.items) {
      const label = document.createElement('label');
      label.className = 'item';

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'item-input';
      input.dataset.id = item.id;
      input.checked = Boolean(state.checked[item.id]);

      const box = document.createElement('span');
      box.className = 'box';
      box.setAttribute('aria-hidden', 'true');

      const icon = document.createElement('span');
      icon.className = 'item-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = item.icon;

      const text = document.createElement('span');
      text.className = 'item-label';
      text.textContent = item.label;

      label.append(input, box, icon, text);
      fragment.append(label);
    }

    els.list.replaceChildren(fragment);
    els.list.hidden = state.items.length === 0;
    els.empty.hidden = state.items.length > 0;

    updateSummary();
  }

  function updateSummary() {
    const total = state.items.length;
    const done = countDone();
    const allDone = total > 0 && done === total;
    const percent = total > 0 ? (done / total) * 100 : 0;

    els.doneCount.textContent = String(done);
    els.totalCount.textContent = String(total);
    els.sectionCount.textContent = `${done} из ${total}`;
    els.ringValue.setAttribute('stroke-dashoffset', String(100 - percent));
    els.hero.classList.toggle('is-complete', allDone);

    if (allDone) {
      els.heroKicker.textContent = 'Готово';
      els.heroStatus.textContent = 'Можно выходить';
      els.heroSub.textContent = state.completedAt
        ? `Проверено в ${formatTime(state.completedAt)}`
        : 'Все пункты отмечены';
    } else if (done === 0) {
      els.heroKicker.textContent = 'Проверка';
      els.heroStatus.textContent = 'Отметьте пункты';
      els.heroSub.textContent = 'Нажмите на пункт, когда проверите';
    } else {
      const left = total - done;
      els.heroKicker.textContent = 'Проверка идёт';
      els.heroStatus.textContent = `Осталось ${left} ${plural(left, 'пункт', 'пункта', 'пунктов')}`;
      els.heroSub.textContent = `Начата в ${formatTime(state.startedAt)}`;
    }
  }

  function renderEditList() {
    const fragment = document.createDocumentFragment();

    for (const item of state.items) {
      const row = document.createElement('div');
      row.className = 'edit-row';

      const icon = document.createElement('span');
      icon.className = 'item-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = item.icon;

      const label = document.createElement('span');
      label.className = 'edit-label';
      label.textContent = item.label;

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'del-btn';
      remove.dataset.id = item.id;
      remove.setAttribute('aria-label', `Удалить пункт «${item.label}»`);
      remove.textContent = '✕';
      remove.disabled = state.items.length <= 1;

      row.append(icon, label, remove);
      fragment.append(row);
    }

    els.editList.replaceChildren(fragment);
  }

  function updateClock() {
    const now = new Date();
    const date = headerDateFmt.format(now);
    els.clock.textContent = `${date.charAt(0).toUpperCase()}${date.slice(1)} · ${timeFmt.format(now)}`;
  }

  /* ------------------------------------------------------------------
     Уведомления
     ------------------------------------------------------------------ */

  function toast(message, duration = 2600) {
    els.toast.textContent = message;
    els.toast.classList.add('is-visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      els.toast.classList.remove('is-visible');
    }, duration);
  }

  function editNotice(message) {
    els.editHint.textContent = message;
    els.editHint.classList.add('is-notice');
    window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => {
      if (!els.dialog.open) return;
      els.editHint.textContent = DEFAULT_HINT;
      els.editHint.classList.remove('is-notice');
    }, 2400);
  }

  function vibrate(pattern) {
    try {
      if (typeof navigator.vibrate === 'function') navigator.vibrate(pattern);
    } catch {
      /* вибрация не критична */
    }
  }

  function celebrate() {
    vibrate([35, 45, 35]);
    toast('Всё проверено. Хорошего дня!');
  }

  /* ------------------------------------------------------------------
     Действия
     ------------------------------------------------------------------ */

  function onListChange(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'checkbox') return;

    const id = input.dataset.id;
    if (!id || !state.items.some((item) => item.id === id)) return;

    const now = Date.now();
    const wasComplete = Boolean(state.completedAt);

    if (input.checked) {
      state.checked[id] = now;
      vibrate(10);
    } else {
      delete state.checked[id];
    }

    state.lastActivity = now;
    syncCompletion(now);
    saveState();
    updateSummary();

    if (!wasComplete && state.completedAt) celebrate();
  }

  function startOver() {
    resetSession();
    saveState();
    render();
    toast('Новая проверка начата');
    vibrate(12);
  }

  function openEditor() {
    if (!els.dialog.open) {
      els.editHint.textContent = DEFAULT_HINT;
      els.editHint.classList.remove('is-notice');
      renderEditList();
      els.dialog.showModal();
      document.body.classList.add('no-scroll');
    }
  }

  function cleanupEditor() {
    document.body.classList.remove('no-scroll');
    window.clearTimeout(noticeTimer);
    els.editHint.textContent = DEFAULT_HINT;
    els.editHint.classList.remove('is-notice');
  }

  function closeEditor() {
    if (els.dialog.open) els.dialog.close();
    cleanupEditor();
  }

  function addItem(event) {
    event.preventDefault();

    if (state.items.length >= MAX_ITEMS) {
      editNotice(`Максимум ${MAX_ITEMS} пунктов`);
      return;
    }

    const label = sanitizeLabel(els.newItem.value);
    if (!label) {
      els.newItem.focus();
      return;
    }

    const duplicate = state.items.some(
      (item) => item.label.toLocaleLowerCase('ru-RU') === label.toLocaleLowerCase('ru-RU'),
    );
    if (duplicate) {
      editNotice('Такой пункт уже есть');
      els.newItem.select();
      return;
    }

    state.items.push({ id: makeId(), label, icon: '📌' });
    state.lastActivity = Date.now();
    syncCompletion();
    saveState();
    render();
    renderEditList();

    els.newItem.value = '';
    els.newItem.focus();
    editNotice('Пункт добавлен');
    vibrate(8);
  }

  function removeItem(id) {
    if (state.items.length <= 1) {
      editNotice('Нужен хотя бы один пункт');
      return;
    }

    const index = state.items.findIndex((item) => item.id === id);
    if (index === -1) return;
    const target = state.items[index];

    state.items = state.items.filter((item) => item.id !== id);
    delete state.checked[id];
    state.lastActivity = Date.now();
    syncCompletion();
    saveState();
    render();
    renderEditList();

    const nextButtons = els.editList.querySelectorAll('.del-btn:not(:disabled)');
    if (nextButtons.length > 0) {
      nextButtons[Math.min(index, nextButtons.length - 1)].focus();
    } else {
      els.doneEditBtn.focus();
    }

    editNotice(`Удалено: ${target.label}`);
    vibrate(8);
  }

  function restoreDefaults() {
    const confirmed = window.confirm(
      'Вернуть стандартные пункты? Добавленные вами пункты будут удалены.',
    );
    if (!confirmed) return;

    state.items = DEFAULT_ITEMS.map((item) => ({ ...item }));
    resetSession();
    saveState();
    render();
    renderEditList();
    editNotice('Стандартный список восстановлен');
    vibrate(10);
  }

  /* ------------------------------------------------------------------
     Установка (PWA)
     ------------------------------------------------------------------ */

  let deferredPrompt = null;

  function setupInstall() {
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true;

    if (!standalone) els.installBtn.hidden = false;

    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      deferredPrompt = event;
      els.installBtn.hidden = false;
    });

    window.addEventListener('appinstalled', () => {
      deferredPrompt = null;
      els.installBtn.hidden = true;
      toast('Приложение установлено');
    });

    els.installBtn.addEventListener('click', async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        try {
          await deferredPrompt.userChoice;
        } catch {
          /* пользователь мог закрыть окно */
        }
        deferredPrompt = null;
        return;
      }

      const isIOS =
        /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

      toast(
        isIOS
          ? 'Safari: «Поделиться» → «На экран „Домой“»'
          : 'Меню браузера → «Установить приложение»',
        5200,
      );
    });
  }

  function registerServiceWorker() {
    if (
      !('serviceWorker' in navigator) ||
      !(location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ) {
      return;
    }

    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {
        /* офлайн-режим недоступен — приложение продолжает работать */
      });
    });
  }

  /* ------------------------------------------------------------------
     События
     ------------------------------------------------------------------ */

  function bindEvents() {
    els.list.addEventListener('change', onListChange);
    els.resetBtn.addEventListener('click', startOver);

    document.querySelectorAll('[data-open-edit]').forEach((button) => {
      button.addEventListener('click', openEditor);
    });

    els.closeDialog.addEventListener('click', closeEditor);
    els.doneEditBtn.addEventListener('click', closeEditor);
    els.addForm.addEventListener('submit', addItem);
    els.restoreBtn.addEventListener('click', restoreDefaults);

    els.dialog.addEventListener('close', cleanupEditor);

    els.dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeEditor();
    });

    // Закрытие по клику вне «шторки», Esc обрабатывается браузером.
    els.dialog.addEventListener('click', (event) => {
      if (event.target !== els.dialog) return;
      const rect = els.dialog.getBoundingClientRect();
      const outside =
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom;
      if (outside) closeEditor();
    });

    els.editList.addEventListener('click', (event) => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest('button[data-id]');
      if (!button) return;
      removeItem(button.dataset.id);
    });

    window.addEventListener('storage', (event) => {
      if (event.key !== STORAGE_KEY) return;
      state = loadState();
      expireIfStale(Date.now());
      render();
      if (els.dialog.open) renderEditList();
    });
  }

  /* ------------------------------------------------------------------
     Запуск
     ------------------------------------------------------------------ */

  state = loadState();
  const wasStale = expireIfStale(Date.now());

  // Сохраняем уже проверенное состояние: это заодно вычищает
  // повреждённые или подменённые данные из localStorage.
  saveState();

  bindEvents();
  render();
  updateClock();
  setupInstall();
  registerServiceWorker();

  window.setInterval(updateClock, 30000);

  if (wasStale) {
    toast('Прошлая проверка устарела — начата новая');
  }
})();
