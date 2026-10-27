(() => {
  'use strict';

  const BOARD_URL = 'https://cgquvuclhkqxwebpgsdx.supabase.co/functions/v1/cave-board';
  const CACHE_KEY = 'cave-graphics-board', OUTBOX_KEY = 'cave-graphics-outbox', PREFS_KEY = 'cave-graphics-prefs';
  const LEGACY_KEYS = ['cave-graphics-panel-cache', 'cave-graphics-access'];
  const TRASH_TTL = 48 * 60 * 60 * 1000, POLL_MS = 20000, UNDO_MS = 6000;
  const STATUS = { pendiente: 'Pendiente', proceso: 'En proceso', listo: 'Listo' };
  const NEXT_STATUS = { pendiente: 'proceso', proceso: 'listo', listo: 'pendiente' };
  const PRIORITY = { normal: 'Normal', alta: 'Alta', urgente: 'Urgente' };
  const PRIORITY_RANK = { urgente: 0, alta: 1, normal: 2 };
  const FIELDS = { text: 'text', client: 'client', description: 'description', date: 'date', phone: 'phone', paymentAmount: 'payment_amount', amountDue: 'amount_due', paidInFull: 'paid_in_full', awaitingPickup: 'awaiting_pickup', status: 'status', priority: 'priority', checklist: 'checklist', deletedAt: 'deleted_at', completedAt: 'completed_at' };
  const VIEWS = {
    active: { title: 'Proyectos activos', subtitle: 'Tu flujo creativo, ordenado.', empty: ['layers-3', 'Tu tablero está listo', 'Crea un proyecto para comenzar.'] },
    pickup: { title: 'Falta de entrega', subtitle: 'Trabajos terminados que esperan a que el cliente los retire.', empty: ['package-check', 'Nada pendiente de retiro', 'Los trabajos listos aparecerán aquí.'] },
    done: { title: 'Entregados', subtitle: 'Historial de trabajos que el cliente ya retiró.', empty: ['archive', 'Aún no hay entregas', 'Al confirmar una entrega quedará guardada aquí.'] },
    trash: { title: 'Papelera', subtitle: 'Se eliminan 48 horas después. Aun así puedes recuperarlos desde Actividad.', empty: ['trash-2', 'La papelera está vacía', 'Lo que envíes a la papelera aparecerá aquí.'] },
    activity: { title: 'Actividad', subtitle: 'Últimos cambios del tablero. Lo eliminado se puede recuperar.', empty: ['history', 'Sin actividad reciente', 'Los cambios aparecerán aquí.'] },
  };
  const FILTERS = {
    all: ['Todos', () => true],
    late: ['Vencidos', t => days(t.date) < 0],
    today: ['Hoy', t => days(t.date) === 0],
    week: ['7 días', t => { const d = days(t.date); return d !== null && d >= 0 && d <= 7; }],
    priority: ['Prioritarios', t => t.priority !== 'normal'],
    owing: ['Con saldo', t => !t.paidInFull && t.amountDue > 0],
  };
  const ACTIVITY = {
    created: ['sparkles', '', () => 'Proyecto creado'],
    updated: ['pencil', '', e => e.detail ? 'Cambió ' + e.detail : 'Proyecto editado'],
    status: ['circle-dot', '', e => 'Estado: ' + e.detail],
    trashed: ['trash-2', 'bad', () => 'Enviado a la papelera'],
    restored: ['rotate-ccw', 'good', () => 'Restaurado de la papelera'],
    delivered: ['circle-check', 'good', () => 'Entregado al cliente'],
    reopened: ['rotate-ccw', '', () => 'Proyecto reabierto'],
    pickup: ['package-check', '', () => 'Listo, falta que lo retiren'],
    deleted: ['trash-2', 'bad', () => 'Eliminado definitivamente'],
    debt_added: ['wallet-cards', '', e => 'Cobro agregado por ' + money(e.detail)],
    debt_paid: ['circle-check', 'good', () => 'Cobro saldado'],
  };

  const $ = id => document.getElementById(id);
  const els = {
    form: $('task-form'), input: $('task-input'), client: $('client-input'), desc: $('desc-input'), date: $('date-input'), datePicker: $('date-picker'), priority: $('priority-input'), phone: $('phone-input'), payment: $('payment-input'), due: $('due-input'), paid: $('paid-in-full'),
    list: $('task-list'), toolbar: $('toolbar'), filters: $('filters'), sort: $('sort-select'), search: $('search-input'), title: $('board-title'), subtitle: $('board-subtitle'),
    debtForm: $('debt-form'), debtClient: $('debt-client'), debtAmount: $('debt-amount'), debtList: $('debt-list'), debtTotal: $('debt-total'), debtCount: $('debt-count'),
    sync: $('sync-status'), syncText: $('sync-text'), lastSync: $('last-sync-text'), active: $('active-count'), today: $('today-count'), overdue: $('overdue-count'),
    activeBadge: $('active-badge'), pickup: $('pickup-count'), done: $('done-count'), trash: $('trash-count'), toggle: $('view-toggle'), refresh: $('refresh-btn'), toast: $('toast'),
    modal: $('modal-bg'), editForm: $('edit-form'), close: $('modal-close'), delivery: $('delivery-bg'), deliveryClose: $('delivery-close'), deliveryPending: $('delivery-pending'), deliveryCollected: $('delivery-collected'),
  };
  const prefs = load(PREFS_KEY, {});
  const state = {
    tasks: [], debts: [], activity: [], outbox: [], lastSync: 0, view: 'active', query: '',
    filter: FILTERS[prefs.filter] ? prefs.filter : 'all', sort: ['date', 'priority', 'recent'].includes(prefs.sort) ? prefs.sort : 'date',
    editing: null, deliveryId: null, flushing: false, fetching: false, failures: 0, retryTimer: null, refreshTimer: null, toastTimer: null,
  };

  // ---------- helpers ----------
  function load(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
  function store(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ } }
  function num(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }
  function stamp(v) { return v === null || v === undefined || v === '' ? null : typeof v === 'number' ? v : Date.parse(v) || null; }
  function uid() { return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2); }
  function money(n) { return '$' + num(n).toLocaleString('es', { maximumFractionDigits: 2 }); }
  function fmtDate(d) { return d ? new Intl.DateTimeFormat('es', { day: '2-digit', month: 'short' }).format(new Date(d + 'T00:00:00')) : 'Sin fecha'; }
  function fmtStamp(t) { return t ? new Intl.DateTimeFormat('es', { day: '2-digit', month: 'short' }).format(new Date(t)) : ''; }
  function days(d) { if (!d) return null; const today = new Date(); today.setHours(0, 0, 0, 0); return Math.round((new Date(d + 'T00:00:00') - today) / 86400000); }
  function ago(at) {
    const seconds = Math.round((stamp(at) - Date.now()) / 1000), rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
    for (const [unit, size] of [['day', 86400], ['hour', 3600], ['minute', 60]]) if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
    return 'hace un momento';
  }
  function whatsapp(phone) { let digits = String(phone || '').replace(/\D/g, ''); if (digits.length === 10) digits = '1' + digits; return digits.length >= 8 ? 'https://wa.me/' + digits : null; }
  function paint(root) { window.CaveIcons?.paint(root); }

  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key in el && !key.includes('-')) el[key] = value;
      else el.setAttribute(key, value === true ? '' : value);
    }
    el.append(...children.flat().filter(child => child !== null && child !== undefined && child !== false));
    return el;
  }
  const icon = name => h('i', { 'data-lucide': name });
  const chip = (cls, text, ico) => h('span', { class: 'chip ' + cls }, icon(ico), text);
  const iconButton = (name, label, cls, onclick) => h('button', { type: 'button', class: 'icon ' + cls, title: label, 'aria-label': label, onclick }, icon(name));

  // ---------- data ----------
  function cleanChecklist(value) {
    return Array.isArray(value) ? value.filter(item => item && String(item.text || '').trim()).slice(0, 40).map(item => ({ id: String(item.id || uid()).slice(0, 40), text: String(item.text).trim().slice(0, 200), done: item.done === true })) : [];
  }
  function clean(row) {
    return {
      id: String(row.id), text: String(row.text || '').trim(), client: String(row.client || '').trim(), description: String(row.description || '').trim(), date: row.date || '', phone: String(row.phone || '').trim(),
      paymentAmount: num(row.payment_amount), amountDue: num(row.amount_due), paidInFull: row.paid_in_full === true, awaitingPickup: row.awaiting_pickup === true,
      status: STATUS[row.status] ? row.status : 'pendiente', priority: PRIORITY[row.priority] ? row.priority : 'normal', checklist: cleanChecklist(row.checklist),
      createdAt: stamp(row.created_at) || Date.now(), updatedAt: stamp(row.updated_at) || stamp(row.created_at) || Date.now(), deletedAt: stamp(row.deleted_at), completedAt: stamp(row.completed_at),
    };
  }
  function toRow(t) {
    return {
      id: t.id, text: t.text, client: t.client || null, description: t.description || null, date: t.date || null, phone: t.phone || null,
      payment_amount: t.paymentAmount || 0, amount_due: t.paidInFull ? 0 : (t.amountDue || 0), paid_in_full: !!t.paidInFull, awaiting_pickup: !!t.awaitingPickup,
      status: t.status, priority: t.priority, checklist: t.checklist, deleted_at: t.deletedAt || null, completed_at: t.completedAt || null, created_at: t.createdAt, updated_at: t.updatedAt,
    };
  }
  const cleanDebt = d => ({ id: String(d.id), client: String(d.client || '').trim(), amountDue: num(d.amount_due), note: String(d.note || '').trim(), createdAt: stamp(d.created_at) || Date.now() });
  const debtRow = d => ({ id: d.id, client: d.client, amount_due: d.amountDue, note: d.note || null, created_at: d.createdAt });
  const expired = t => t.deletedAt && Date.now() - t.deletedAt > TRASH_TTL;
  const sortByRecent = (a, b) => b.updatedAt - a.updatedAt;

  function hydrate() {
    LEGACY_KEYS.forEach(key => { try { localStorage.removeItem(key); sessionStorage.removeItem(key); } catch { /* ignore */ } });
    const cached = load(CACHE_KEY, {});
    state.tasks = (cached.tasks || []).map(clean).filter(t => t.text && !expired(t));
    state.debts = (cached.debts || []).map(cleanDebt).filter(d => d.client && d.amountDue > 0);
    state.activity = Array.isArray(cached.activity) ? cached.activity : [];
    state.lastSync = cached.lastSync || 0;
    state.outbox = load(OUTBOX_KEY, []).filter(op => op && op.body && op.body.operation);
  }
  function save() { store(CACHE_KEY, { tasks: state.tasks.map(toRow), debts: state.debts.map(debtRow), activity: state.activity, lastSync: state.lastSync }); }
  function saveOutbox() { store(OUTBOX_KEY, state.outbox); }

  // ---------- sync: every change shows up at once and is saved in the background ----------
  async function send(body) {
    let res;
    try {
      res = await fetch(BOARD_URL, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { method: 'GET' });
    } catch {
      throw Object.assign(new Error('Sin conexión'), { retry: true });
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    throw Object.assign(new Error(data.error || 'No se pudo guardar.'), { retry: res.status >= 500 || res.status === 429 });
  }

  function enqueue(body) { state.outbox.push({ id: uid(), body }); saveOutbox(); updateSync(); flush(); }
  const pendingFor = id => state.outbox.some(op => op.body.id === id || op.body.task?.id === id || op.body.debt?.id === id);

  async function flush() {
    if (state.flushing || !state.outbox.length) return;
    state.flushing = true;
    clearTimeout(state.retryTimer);
    let rejected = false;
    try {
      while (state.outbox.length) {
        const op = state.outbox[0];
        let result;
        try {
          result = await send(op.body);
        } catch (error) {
          if (error.retry) {
            state.failures++;
            state.retryTimer = setTimeout(flush, Math.min(30000, 2000 * 2 ** (state.failures - 1)));
            return;
          }
          state.outbox.shift();
          saveOutbox();
          rejected = true;
          toast(error.message, 'err');
          continue;
        }
        state.failures = 0;
        state.outbox.shift();
        saveOutbox();
        accept(op.body, result);
      }
    } finally {
      state.flushing = false;
      updateSync();
    }
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(fetchLatest, rejected ? 0 : 1500);
  }

  // Server copy wins only when no newer local change for that row is still waiting.
  function accept(body, result) {
    const row = result && result.data;
    if (!row || pendingFor(row.id)) return;
    if (body.operation === 'insert' || body.operation === 'update') {
      const task = clean(row), index = state.tasks.findIndex(t => t.id === task.id);
      if (index >= 0) state.tasks[index] = task; else if (body.operation === 'insert') state.tasks.push(task);
    } else if (body.operation === 'debt_insert') {
      const debt = cleanDebt(row), index = state.debts.findIndex(d => d.id === debt.id);
      if (index >= 0) state.debts[index] = debt;
    }
    save();
  }

  async function fetchLatest(manual = false) {
    if (state.fetching) return;
    if (state.outbox.length) { flush(); return; }
    state.fetching = true;
    if (manual === true) setSync('syncing', 'Actualizando');
    try {
      const data = await send();
      if (state.outbox.length) return;
      state.tasks = (data.data || []).map(clean).filter(t => t.text && !expired(t));
      state.debts = (data.debts || []).map(cleanDebt).filter(d => d.client && d.amountDue > 0);
      state.activity = Array.isArray(data.activity) ? data.activity : [];
      state.lastSync = Date.now();
      state.failures = 0;
      save();
      render();
      if (manual === true) toast('Tablero actualizado', 'ok');
    } catch (error) {
      if (!error.retry) toast(error.message, 'err');
      else if (manual === true) toast('Sin conexión. Tus cambios se guardan aquí y se enviarán solos.', 'err');
      if (error.retry) state.failures = Math.max(state.failures, 1);
    } finally {
      state.fetching = false;
      updateSync();
    }
  }

  function setSync(kind, label) { els.sync.className = 'connection ' + kind; els.syncText.textContent = label; }
  function updateSync() {
    const pending = state.outbox.length;
    if (!navigator.onLine || state.failures) setSync('offline', pending ? 'Sin conexión · ' + pending + ' por enviar' : 'Sin conexión');
    else if (pending) setSync('syncing', 'Guardando');
    else if (!state.lastSync) setSync('syncing', 'Conectando');
    else setSync('live', 'En vivo');
    if (state.lastSync) els.lastSync.textContent = 'Sincronizado ' + new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' }).format(new Date(state.lastSync)) + ' · N nuevo · / buscar';
  }

  // ---------- actions ----------
  function upsertLocal(task) {
    const index = state.tasks.findIndex(t => t.id === task.id);
    if (index >= 0) state.tasks[index] = task; else state.tasks.push(task);
    save();
    render();
  }

  function addTask(data) {
    const now = Date.now();
    const task = clean({
      id: uid(), text: data.text, client: data.client, description: data.description, date: data.date, phone: data.phone, priority: data.priority,
      payment_amount: data.payment, amount_due: data.paid ? 0 : data.due, paid_in_full: !!data.paid, status: 'pendiente', created_at: now, updated_at: now,
    });
    if (!task.text) return;
    if (!FILTERS[state.filter][1](task)) state.filter = 'all';
    if (state.view !== 'active') switchView('active');
    upsertLocal(task);
    enqueue({ operation: 'insert', task: toRow(task) });
    toast('Proyecto creado', 'ok', () => eraseTask(task.id, false));
  }

  function patch(id, changes, message, undoable = true) {
    const before = state.tasks.find(t => t.id === id);
    if (!before) return;
    const keys = Object.keys(changes).filter(key => JSON.stringify(before[key]) !== JSON.stringify(changes[key]));
    if (!keys.length) return;
    const next = { ...before, ...changes, updatedAt: Date.now() };
    const row = toRow(next), payload = {};
    for (const key of keys) payload[FIELDS[key]] = row[FIELDS[key]];
    if ('amountDue' in payload || 'paid_in_full' in payload) Object.assign(payload, { amount_due: row.amount_due, paid_in_full: row.paid_in_full });
    upsertLocal(next);
    enqueue({ operation: 'update', id, task: payload });
    const previous = Object.fromEntries(keys.map(key => [key, before[key]]));
    if (message) toast(message, 'ok', undoable ? () => patch(id, previous, 'Acción deshecha', false) : null);
  }

  function eraseTask(id, undoable = true) {
    const before = state.tasks.find(t => t.id === id);
    if (!before) return;
    state.tasks = state.tasks.filter(t => t.id !== id);
    save();
    render();
    enqueue({ operation: 'delete', id });
    if (undoable) toast('Eliminado definitivamente', 'ok', () => reinsert(before, 'Proyecto recuperado'));
  }

  function reinsert(task, message) {
    const restored = { ...task, updatedAt: Date.now() };
    upsertLocal(restored);
    enqueue({ operation: 'insert', task: toRow(restored) });
    if (message) toast(message, 'ok');
  }

  const cycleStatus = id => { const t = state.tasks.find(x => x.id === id); if (t) patch(id, { status: NEXT_STATUS[t.status] }, 'Estado: ' + STATUS[NEXT_STATUS[t.status]]); };
  const trashTask = id => patch(id, { deletedAt: Date.now() }, 'Movido a la papelera');
  const restoreTask = id => patch(id, { deletedAt: null }, 'Proyecto restaurado');
  const reopenTask = id => patch(id, { completedAt: null, awaitingPickup: false, status: 'proceso' }, 'Proyecto reabierto');

  function finishDelivery(collected) {
    const id = state.deliveryId;
    closeDelivery();
    if (!id) return;
    if (collected) patch(id, { completedAt: Date.now(), awaitingPickup: false, status: 'listo' }, 'Entregado. Lo encuentras en Entregados');
    else patch(id, { awaitingPickup: true, status: 'listo' }, 'Movido a falta de entrega');
  }

  function addDebt(client, amount) {
    const debt = { id: uid(), client: client.trim().slice(0, 220), amountDue: Math.round(num(amount) * 100) / 100, note: '', createdAt: Date.now() };
    if (!debt.client || debt.amountDue <= 0) return;
    state.debts.unshift(debt);
    save();
    render();
    enqueue({ operation: 'debt_insert', debt: debtRow(debt) });
    toast('Cobro agregado', 'ok', () => settleDebt(debt.id, false));
  }

  function settleDebt(id, undoable = true) {
    const before = state.debts.find(d => d.id === id);
    if (!before) return;
    state.debts = state.debts.filter(d => d.id !== id);
    save();
    render();
    enqueue({ operation: 'debt_delete', id });
    if (undoable) toast('Cobro marcado como pagado', 'ok', () => restoreDebt(before, 'Cobro restaurado'));
  }

  function restoreDebt(debt, message) {
    state.debts.unshift(debt);
    save();
    render();
    enqueue({ operation: 'debt_insert', debt: debtRow(debt) });
    if (message) toast(message, 'ok');
  }

  function recover(entry) {
    if (!entry.row) return;
    if (entry.table === 'debts') restoreDebt(cleanDebt(entry.row), 'Cobro recuperado');
    else reinsert({ ...clean(entry.row), deletedAt: null }, 'Proyecto recuperado en el tablero');
  }

  // ---------- views ----------
  const board = () => state.tasks.filter(t => !t.deletedAt && !t.completedAt && !t.awaitingPickup);
  const awaiting = () => state.tasks.filter(t => !t.deletedAt && !t.completedAt && t.awaitingPickup);
  const delivered = () => state.tasks.filter(t => !t.deletedAt && t.completedAt);
  const trashed = () => state.tasks.filter(t => t.deletedAt && !expired(t));

  function matches(t) {
    const q = state.query.toLowerCase().trim();
    return !q || [t.text, t.client, t.description, t.phone, STATUS[t.status], PRIORITY[t.priority], ...t.checklist.map(i => i.text)].join(' ').toLowerCase().includes(q);
  }

  function sortTasks(items) {
    const byDate = (a, b) => (a.date || '9999-99-99').localeCompare(b.date || '9999-99-99');
    const byPriority = (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (state.view === 'done') return items.sort((a, b) => b.completedAt - a.completedAt);
    if (state.view === 'trash') return items.sort((a, b) => b.deletedAt - a.deletedAt);
    if (state.sort === 'recent') return items.sort(sortByRecent);
    if (state.sort === 'priority') return items.sort((a, b) => byPriority(a, b) || byDate(a, b) || sortByRecent(a, b));
    return items.sort((a, b) => byDate(a, b) || byPriority(a, b) || sortByRecent(a, b));
  }

  function due(t) {
    const d = days(t.date);
    if (d === 0) return ['today', 'Entrega hoy', 'sun'];
    if (d !== null && d < 0) return ['urgent', 'Vencida ' + Math.abs(d) + 'd', 'circle-alert'];
    if (d !== null) return ['', 'Entrega ' + fmtDate(t.date), 'calendar'];
    return ['', 'Sin fecha', 'calendar'];
  }

  function renderTask(t, index) {
    const view = state.view, d = due(t), meta = [];
    if (view === 'done') meta.push(chip('done', 'Entregado ' + fmtStamp(t.completedAt), 'circle-check'));
    else meta.push(chip(d[0], d[1], d[2]));
    if (view === 'active' || view === 'pickup') meta.push(h('button', { type: 'button', class: 'chip s-' + t.status, title: 'Cambiar estado', onclick: () => cycleStatus(t.id) }, icon('circle-dot'), STATUS[t.status]));
    if (t.priority !== 'normal') meta.push(chip(t.priority === 'urgente' ? 'urgent' : 'today', PRIORITY[t.priority], 'flag'));
    if (t.checklist.length) {
      const done = t.checklist.filter(item => item.done).length;
      meta.push(h('button', { type: 'button', class: 'chip' + (done === t.checklist.length ? ' done' : ''), title: 'Ver checklist', onclick: () => openEdit(t.id) }, icon('list-checks'), done + '/' + t.checklist.length));
    }
    if (t.paidInFull) meta.push(chip('done', 'Pago completo', 'circle-check'));
    else if (t.amountDue) meta.push(chip('urgent', 'Debe ' + money(t.amountDue), 'wallet-cards'));
    if (t.paymentAmount) meta.push(chip('', 'Abonó ' + money(t.paymentAmount), 'wallet'));

    const actions = [];
    const link = whatsapp(t.phone);
    if (link && view !== 'trash') actions.push(h('a', { class: 'icon wa', href: link, target: '_blank', rel: 'noopener noreferrer', title: 'Escribir por WhatsApp', 'aria-label': 'Escribir por WhatsApp' }, icon('message-circle')));
    if (view === 'active' || view === 'pickup') actions.push(iconButton('pencil', 'Editar', '', () => openEdit(t.id)), iconButton('check', 'Confirmar entrega', 'complete', () => openDelivery(t.id)), iconButton('trash-2', 'Mover a papelera', 'remove', () => trashTask(t.id)));
    else if (view === 'done') actions.push(iconButton('rotate-ccw', 'Reabrir proyecto', '', () => reopenTask(t.id)), iconButton('trash-2', 'Mover a papelera', 'remove', () => trashTask(t.id)));
    else actions.push(iconButton('rotate-ccw', 'Restaurar', '', () => restoreTask(t.id)), iconButton('trash-2', 'Eliminar definitivamente', 'remove', () => eraseTask(t.id)));

    const tone = t.priority === 'urgente' ? 'urgente' : t.status;
    return h('li', { class: 'task status-' + tone, style: 'animation-delay:' + Math.min(index * 35, 300) + 'ms' },
      h('span', { class: 'task-bar' }),
      h('div', {},
        h('p', { class: 'task-title', text: t.text, onclick: () => openEdit(t.id) }),
        h('p', { class: 'task-client', text: t.client || 'Proyecto sin cliente' }),
        t.description ? h('p', { class: 'task-notes', text: t.description }) : null,
        h('div', { class: 'task-meta' }, meta)),
      h('div', { class: 'task-actions' }, actions));
  }

  function renderActivity() {
    const q = state.query.toLowerCase().trim();
    return state.activity.filter(e => ACTIVITY[e.kind] && (!q || String(e.label).toLowerCase().includes(q))).map((e, index) => {
      const [ico, tone, describe] = ACTIVITY[e.kind];
      const gone = e.row && (e.table === 'debts' ? !state.debts.some(d => d.id === e.rowId) : !state.tasks.some(t => t.id === e.rowId));
      return h('li', { class: 'activity-item', style: 'animation-delay:' + Math.min(index * 25, 300) + 'ms' },
        h('span', { class: 'activity-icon ' + tone }, icon(ico)),
        h('div', {}, h('strong', { text: e.label || 'Sin nombre' }), h('span', { text: describe(e) })),
        h('div', { class: 'activity-side' }, ago(e.at), gone ? h('button', { type: 'button', class: 'recover', text: 'Recuperar', onclick: () => recover(e) }) : null));
    });
  }

  function emptyState(view) {
    const [ico, title, hint] = VIEWS[view].empty;
    const searching = state.query || (state.filter !== 'all' && (view === 'active' || view === 'pickup'));
    return h('li', { class: 'empty' }, icon(searching ? 'search' : ico), h('strong', { text: searching ? 'No encontramos coincidencias' : title }), h('span', { text: searching ? 'Prueba otro término o filtro.' : hint }));
  }

  function renderFilters(base) {
    els.filters.replaceChildren(...Object.entries(FILTERS).map(([key, [label, test]]) => {
      const count = key === 'all' ? base.length : base.filter(test).length;
      return h('button', { type: 'button', class: 'filter' + (state.filter === key ? ' active' : ''), 'aria-pressed': String(state.filter === key), onclick: () => { state.filter = key; store(PREFS_KEY, { filter: state.filter, sort: state.sort }); render(); } }, label, h('b', { text: String(count) }));
    }));
  }

  function renderDebts() {
    const fromProjects = state.tasks.filter(t => !t.deletedAt && !t.paidInFull && t.amountDue > 0).map(t => ({ id: t.id, client: t.client || 'Cliente sin nombre', amountDue: t.amountDue, label: t.text, project: true }));
    const debts = [...state.debts.map(d => ({ ...d, label: 'Registro directo · toca si ya pagó', project: false })), ...fromProjects].sort((a, b) => b.amountDue - a.amountDue);
    els.debtTotal.textContent = money(debts.reduce((sum, d) => sum + d.amountDue, 0));
    els.debtCount.textContent = debts.length + ' ' + (debts.length === 1 ? 'cliente con saldo' : 'clientes con saldo');
    if (!debts.length) { els.debtList.replaceChildren(h('li', { class: 'debt-empty', text: 'No hay cobros pendientes.' })); return; }
    els.debtList.replaceChildren(...debts.slice(0, 6).map(d => h('li', { title: d.project ? 'Abrir proyecto' : 'Marcar como pagado', onclick: () => d.project ? openEdit(d.id) : settleDebt(d.id) },
      h('div', {}, h('strong', { text: d.client }), h('span', { text: d.label })), h('b', { text: money(d.amountDue) }))));
  }

  function render() {
    const view = state.view, active = board(), pickup = awaiting(), done = delivered(), trash = trashed();
    els.active.textContent = active.length;
    els.activeBadge.textContent = active.length;
    els.pickup.textContent = pickup.length;
    els.done.textContent = done.length;
    els.trash.textContent = trash.length;
    els.today.textContent = [...active, ...pickup].filter(t => days(t.date) === 0).length;
    els.overdue.textContent = active.filter(t => days(t.date) < 0 || t.priority === 'urgente').length;
    els.title.textContent = VIEWS[view].title;
    els.subtitle.textContent = VIEWS[view].subtitle;
    renderDebts();

    const filterable = view === 'active' || view === 'pickup';
    els.toolbar.hidden = !filterable;
    let items;
    if (view === 'activity') items = renderActivity();
    else {
      const base = { active, pickup, done, trash }[view];
      if (filterable) renderFilters(base);
      const test = filterable ? FILTERS[state.filter][1] : () => true;
      items = sortTasks(base.filter(t => test(t) && matches(t))).map(renderTask);
    }
    els.list.replaceChildren(...(items.length ? items : [emptyState(view)]));
    paint(document);
  }

  function switchView(view) {
    state.view = view;
    els.toggle.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    render();
  }

  // ---------- modals ----------
  function openEdit(id) {
    const t = state.tasks.find(x => x.id === id);
    if (!t) return;
    state.editing = id;
    const items = t.checklist.map(item => ({ ...item }));
    const field = (label, control) => h('div', { class: 'field' }, h('label', { text: label, htmlFor: control.id }), control);
    const select = (id, options, value) => h('select', { id }, Object.entries(options).map(([key, label]) => h('option', { value: key, text: label, selected: key === value })));
    const text = h('input', { id: 'e-text', required: true, maxLength: 220, value: t.text });
    const client = h('input', { id: 'e-client', maxLength: 220, value: t.client });
    const desc = h('textarea', { id: 'e-desc', maxLength: 5000, value: t.description });
    const date = h('input', { id: 'e-date', type: 'date', value: t.date });
    const status = select('e-status', STATUS, t.status);
    const priority = select('e-priority', PRIORITY, t.priority);
    const payment = h('input', { id: 'e-payment', type: 'number', min: '0', step: '0.01', value: String(t.paymentAmount) });
    const owed = h('input', { id: 'e-due', type: 'number', min: '0', step: '0.01', value: String(t.amountDue) });
    const paid = h('input', { id: 'e-paid', type: 'checkbox', checked: t.paidInFull });
    const phone = h('input', { id: 'e-phone', type: 'tel', maxLength: 80, value: t.phone });
    const list = h('ul', { class: 'checklist-edit' });
    const newItem = h('input', { id: 'e-check', maxLength: 200, placeholder: 'Agregar paso (Enter)', onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); addItem(); } } });
    function addItem() { const value = newItem.value.trim(); if (!value || items.length >= 40) return; items.push({ id: uid(), text: value, done: false }); newItem.value = ''; drawList(); newItem.focus(); }
    function drawList() {
      list.replaceChildren(...items.map((item, index) => h('li', { class: item.done ? 'check-done' : '' },
        h('input', { type: 'checkbox', checked: item.done, 'aria-label': 'Paso completado', onchange: e => { item.done = e.target.checked; e.target.parentElement.classList.toggle('check-done', item.done); } }),
        h('input', { class: 'check-text', maxLength: 200, value: item.text, 'aria-label': 'Paso', oninput: e => { item.text = e.target.value; } }),
        iconButton('x', 'Quitar paso', 'remove', () => { items.splice(index, 1); drawList(); }))));
      paint(list);
    }
    drawList();
    els.editForm.replaceChildren(
      field('Nombre del proyecto', text), field('Cliente', client), field('Notas creativas', desc),
      h('div', { class: 'split' }, field('Entrega', date), field('Prioridad', priority)),
      h('div', { class: 'split' }, field('Estado', status), field('Contacto', phone)),
      h('div', { class: 'split' }, field('Abono', payment), field('Saldo pendiente', owed)),
      h('label', { class: 'payment-toggle' }, paid, h('span', { text: 'Cliente pagó completo' })),
      h('div', { class: 'field' }, h('label', { text: 'Checklist', htmlFor: 'e-check' }), list, h('div', { class: 'check-add' }, newItem, h('button', { type: 'button', 'aria-label': 'Agregar paso', onclick: addItem }, icon('plus')))),
      h('div', { class: 'edit-actions' }, h('button', { class: 'secondary', type: 'button', text: 'Cancelar', onclick: closeModal }), h('button', { class: 'save', type: 'submit', text: 'Guardar cambios' })));
    els.editForm.onsubmit = e => {
      e.preventDefault();
      const name = text.value.trim();
      if (!name) return;
      closeModal();
      patch(id, {
        text: name, client: client.value.trim(), description: desc.value.trim(), date: date.value, phone: phone.value.trim(), status: status.value, priority: priority.value,
        paymentAmount: num(payment.value), amountDue: paid.checked ? 0 : num(owed.value), paidInFull: paid.checked, checklist: cleanChecklist(items),
      }, 'Cambios guardados');
    };
    els.modal.classList.add('show');
    paint(els.editForm);
    text.focus();
  }
  function closeModal() { els.modal.classList.remove('show'); state.editing = null; }
  function openDelivery(id) { state.deliveryId = id; els.delivery.classList.add('show'); els.deliveryCollected.focus(); }
  function closeDelivery() { els.delivery.classList.remove('show'); state.deliveryId = null; }

  function toast(text, kind = '', undo = null) {
    clearTimeout(state.toastTimer);
    let used = false;
    const parts = [icon(kind === 'ok' ? 'circle-check' : kind === 'err' ? 'circle-alert' : 'info'), h('span', { text })];
    if (undo) parts.push(h('button', { type: 'button', class: 'toast-undo', text: 'Deshacer', onclick: () => { if (used) return; used = true; els.toast.classList.remove('show'); undo(); } }));
    els.toast.replaceChildren(...parts);
    els.toast.className = 'toast show ' + kind;
    paint(els.toast);
    state.toastTimer = setTimeout(() => els.toast.classList.remove('show'), undo ? UNDO_MS : 2800);
  }

  // ---------- events ----------
  els.form.onsubmit = e => {
    e.preventDefault();
    addTask({ text: els.input.value, client: els.client.value, description: els.desc.value, date: els.date.value, priority: els.priority.value, phone: els.phone.value, payment: els.payment.value, due: els.due.value, paid: els.paid.checked });
    els.form.reset();
    els.input.focus();
  };
  els.debtForm.onsubmit = e => { e.preventDefault(); addDebt(els.debtClient.value, els.debtAmount.value); els.debtForm.reset(); };
  els.datePicker.onclick = () => { if (els.date.showPicker) els.date.showPicker(); else els.date.focus(); };
  els.search.oninput = e => { state.query = e.target.value; render(); };
  els.sort.value = state.sort;
  els.sort.onchange = () => { state.sort = els.sort.value; store(PREFS_KEY, { filter: state.filter, sort: state.sort }); render(); };
  els.toggle.onclick = e => { const b = e.target.closest('[data-view]'); if (b) switchView(b.dataset.view); };
  els.refresh.onclick = () => fetchLatest(true);
  els.close.onclick = closeModal;
  els.modal.onclick = e => { if (e.target === els.modal) closeModal(); };
  els.deliveryClose.onclick = closeDelivery;
  els.deliveryPending.onclick = () => finishDelivery(false);
  els.deliveryCollected.onclick = () => finishDelivery(true);
  els.delivery.onclick = e => { if (e.target === els.delivery) closeDelivery(); };
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeModal(); closeDelivery(); return; }
    const target = document.activeElement, typing = target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable);
    if (typing || e.metaKey || e.ctrlKey || e.altKey || els.modal.classList.contains('show')) return;
    if (e.key === '/') { e.preventDefault(); els.search.focus(); }
    else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); els.input.focus(); }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) fetchLatest(); });
  window.addEventListener('focus', () => fetchLatest());
  window.addEventListener('online', () => { state.failures = 0; updateSync(); state.outbox.length ? flush() : fetchLatest(); });
  window.addEventListener('offline', updateSync);
  setInterval(() => { if (!document.hidden) fetchLatest(); }, POLL_MS);
  setInterval(() => { if (state.view === 'activity' || state.tasks.some(expired)) { state.tasks = state.tasks.filter(t => !expired(t)); render(); } }, 60000);

  hydrate();
  render();
  updateSync();
  if (state.outbox.length) flush(); else fetchLatest();
})();
