import { startRecording, fileToWav, MAX_SECONDS } from '/wav.js';

/* ───────── tiny helpers ───────── */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
class Raw { constructor(s) { this.s = s; } }
const val = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(val).join('') : esc(v ?? ''));
const html = (strs, ...vals) => new Raw(strs.reduce((a, s, i) => a + s + (i < vals.length ? val(vals[i]) : ''), ''));
const put = (el, r) => { el.innerHTML = r.s; };
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

async function api(method, path, body, opts = {}) {
  const headers = { 'X-Requested-With': 'phone' };
  let payload;
  if (body instanceof Blob) { payload = body; } else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch('/api' + path, { method, headers, body: payload, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !opts.quiet && state.me) { state.me = null; render(); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const ICON = {
  keypad: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="5" r="2"/><circle cx="12" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="12" cy="19" r="2"/><circle cx="19" cy="19" r="2"/></svg>',
  messages: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  voicemail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="6.5" cy="12" r="3.5"/><circle cx="17.5" cy="12" r="3.5"/><path d="M6.5 15.5h11"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.6 10.8a15 15 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11 11 0 0 0 3.6.6 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.2.2 2.4.6 3.6a1 1 0 0 1-.25 1z"/></svg>',
};

/* ───────── state ───────── */
const state = {
  me: null, company: '', numbers: [], numberId: store.get('numberId'),
  tab: 'keypad', businesses: [], settingsTab: 'numbers', summary: { unreadMessages: 0, newVoicemails: 0 }, dialValue: '', vmView: 'voicemail', installEvt: null,
};
let pollTimer; let threadTimer;

const TABS = [['keypad', 'Keypad'], ['messages', 'Messages'], ['voicemail', 'Voicemail'], ['settings', 'Settings']];

const e164 = (raw) => {
  const s = String(raw || '').trim(); const d = s.replace(/\D/g, '');
  if (!d) return null;
  if (s.startsWith('+')) return d.length >= 8 && d.length <= 15 ? '+' + d : null;
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return d.length >= 11 && d.length <= 15 ? '+' + d : null;
};
const pretty = (p) => { const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(p || ''); return m ? `(${m[1]}) ${m[2]}-${m[3]}` : p || ''; };
const ago = (iso) => {
  const d = new Date(iso); const s = (Date.now() - d) / 1000;
  if (s < 60) return 'now'; if (s < 3600) return `${Math.floor(s / 60)}m`; if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const numById = (id) => state.numbers.find((n) => n.id === id);
const numLabel = (n) => (n ? n.label || pretty(n.e164) : '');
const currentNumber = () => numById(state.numberId) || state.numbers[0] || null;
const isOwner = () => state.me?.role === 'owner';
const isAdmin = () => ['owner', 'admin'].includes(state.me?.role);

/* ───────── boot ───────── */
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installEvt = e; });
  window.addEventListener('hashchange', () => { if (state.me) render(); });
  try {
    const me = await api('GET', '/me', undefined, { quiet: true });
    if (me.user) { applyMe(me); await afterLogin(); }
  } catch { /* show login */ }
  render();
}

function applyMe(me) {
  state.me = me.user; state.company = me.company; state.businesses = me.businesses || []; state.needsPublicUrl = me.needsPublicUrl;
}

// Move the whole app into another business (operators and people who belong to several).
async function switchBusiness(tenantId) {
  applyMe(await api('POST', '/switch', { tenantId }));
  state.numberId = null; state.dialValue = ''; state.settingsTab = 'numbers';
  await loadNumbers(); location.hash = 'keypad'; render(); registerDevices();
}

async function afterLogin() {
  await loadNumbers();
  startPolling();
  registerDevices();
}

async function loadNumbers() {
  const r = await api('GET', '/numbers');
  state.numbers = r.numbers;
  if (!numById(state.numberId)) state.numberId = (r.numbers.find((n) => n.canCall) || r.numbers[0])?.id || null;
}

function startPolling() {
  clearInterval(pollTimer);
  const tick = async () => {
    if (!state.me || document.hidden) return;
    try {
      state.summary = await api('GET', '/summary', undefined, { quiet: true });
      paintBadges();
      if (state.tab === 'messages' && !location.hash.split('/')[2]) renderMessages();
    } catch { /* offline */ }
  };
  tick(); pollTimer = setInterval(tick, 8000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
}

function paintBadges() {
  const m = state.summary.unreadMessages; const v = state.summary.newVoicemails;
  const set = (tab, n) => { const b = $(`.nav [data-tab="${tab}"] .badge`); if (b) { b.textContent = n > 99 ? '99+' : n; b.classList.toggle('hidden', !n); } };
  set('messages', m); set('voicemail', v);
  const total = m + v;
  document.title = total ? `(${total}) Haulers Phone` : 'Haulers Phone';
  if ('setAppBadge' in navigator) (total ? navigator.setAppBadge(total) : navigator.clearAppBadge()).catch(() => {});
}

/* ───────── render root ───────── */
function render() {
  const app = $('#app');
  if (!state.me) return renderAuth(app);
  const [tab] = (location.hash.slice(1) || 'keypad').split('/');
  state.tab = TABS.some((t) => t[0] === tab) ? tab : 'keypad';
  if (!$('.shell')) {
    put(app, html`<div class="shell">
      <header class="top"><div class="co" id="coName"></div><select id="asBiz" class="hidden" aria-label="Business"></select><select id="asNum" aria-label="Active number"></select></header>
      <main class="main"><div class="page" id="page"></div></main>
      <nav class="nav">${TABS.map(([k, label]) => html`<button data-tab="${k}">${new Raw(ICON[k])}<span>${label}</span><i class="badge hidden"></i></button>`)}</nav>
    </div>`);
    $('.nav').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) location.hash = b.dataset.tab; });
    $('#asBiz').addEventListener('change', (e) => switchBusiness(e.target.value).catch((err) => toast(err.message)));
    $('#asNum').addEventListener('change', (e) => { state.numberId = e.target.value; store.set('numberId', state.numberId); render(); });
  }
  paintHeader(); paintBadges();
  document.querySelectorAll('.nav [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));
  clearInterval(threadTimer);
  ({ keypad: renderKeypad, messages: renderMessages, voicemail: renderVoicemail, settings: renderSettings })[state.tab]();
}

function paintHeader() {
  $('#coName').textContent = state.company;
  const biz = $('#asBiz'); const many = state.businesses.length > 1;
  biz.classList.toggle('hidden', !many); $('#coName').classList.toggle('hidden', many);
  if (many) put(biz, html`${state.businesses.map((b) => html`<option value="${b.id}" ${b.id === state.me.tenant_id ? new Raw('selected') : ''}>${b.name}</option>`)}`);
  const sel = $('#asNum');
  if (!state.numbers.length) { sel.classList.add('hidden'); return; }
  sel.classList.remove('hidden');
  put(sel, html`${state.numbers.map((n) => html`<option value="${n.id}" ${n.id === state.numberId ? new Raw('selected') : ''}>${state.numbers.length > 1 || !n.label ? numLabel(n) : pretty(n.e164)}</option>`)}`);
}

/* ───────── auth ───────── */
function renderAuth(app) {
  let mode = 'login';
  const draw = () => {
    put(app, html`<div class="auth"><form class="card stack" id="authForm">
      <img class="logo" src="/icons/icon-192.png" alt="">
      <h2 class="center">${mode === 'login' ? 'Sign in' : 'Create your company'}</h2>
      ${mode === 'signup' ? html`<label class="f">Company<input name="company" autocomplete="organization" required></label><label class="f">Your name<input name="name" autocomplete="name"></label>` : ''}
      <label class="f">Email<input name="email" type="email" autocomplete="email" required></label>
      <label class="f">Password<input name="password" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" minlength="${mode === 'login' ? 1 : 8}" required></label>
      ${mode === 'signup' ? html`<label class="f">Signup code (only if your host set one)<input name="code" autocomplete="off"></label>` : ''}
      <div class="err" id="authErr"></div>
      <button class="btn brand" style="width:100%">${mode === 'login' ? 'Sign in' : 'Create account'}</button>
      <button type="button" class="btn ghost sm" id="swap" style="width:100%">${mode === 'login' ? 'New here? Create a company' : 'Have an account? Sign in'}</button>
    </form></div>`);
    $('#swap').onclick = () => { mode = mode === 'login' ? 'signup' : 'login'; draw(); };
    $('#authForm').onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      try {
        const r = await api('POST', mode === 'login' ? '/login' : '/signup', body, { quiet: true });
        applyMe(r); await afterLogin(); location.hash = 'keypad'; render();
      } catch (err) { $('#authErr').textContent = err.message; }
    };
  };
  draw();
}

/* ───────── keypad + calling ───────── */
const KEYS = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']];

function renderKeypad() {
  const page = $('#page'); const n = currentNumber();
  if (!n) return put(page, emptyNumbers());
  put(page, html`<div class="dial">
    <input class="num" id="dialNum" inputmode="tel" autocomplete="off" placeholder="Enter number" value="${state.dialValue}" aria-label="Number to call">
    <div class="pad">${KEYS.map(([k, sub]) => html`<button data-k="${k}">${k}<small>${sub}</small></button>`)}</div>
    <div class="dial-actions">
      <button class="round" id="msgBtn" title="Message">${new Raw(ICON.messages.replace('<svg', '<svg width="26" height="26"'))}</button>
      <button class="call-btn" id="callBtn">${new Raw(ICON.phone)} Call</button>
      <button class="round" id="delBtn" title="Delete">⌫</button>
    </div>
    ${n.canCall ? '' : html`<p class="small muted center" style="margin-top:14px">${numLabel(n)} is a Bird number: texting works; calling isn't available yet.</p>`}
  </div>`);
  const input = $('#dialNum');
  input.oninput = () => { state.dialValue = input.value; };
  const add = (k) => { input.value += k; state.dialValue = input.value; };
  let held;
  $('.pad').addEventListener('pointerdown', (e) => {
    const b = e.target.closest('[data-k]'); if (!b) return;
    if (b.dataset.k === '0') { held = setTimeout(() => { held = 'plus'; add('+'); }, 500); }
  });
  $('.pad').addEventListener('pointerup', (e) => {
    const b = e.target.closest('[data-k]'); if (!b) return;
    if (b.dataset.k === '0') { if (held === 'plus') { held = null; return; } clearTimeout(held); }
    add(b.dataset.k);
  });
  $('.pad').addEventListener('pointerleave', () => clearTimeout(held));
  $('#delBtn').onclick = () => { input.value = input.value.slice(0, -1); state.dialValue = input.value; };
  $('#callBtn').onclick = () => placeCall(input.value);
  $('#msgBtn').onclick = () => { const p = e164(input.value); if (!p) return toast('Enter a number first'); location.hash = `messages/${n.id}/${encodeURIComponent(p)}`; };
}

function emptyNumbers() {
  return html`<div class="empty"><h2>No numbers yet</h2><p>${isOwner() ? 'Connect Twilio or Bird to bring your numbers in, or move numbers here from the Businesses tab.' : isAdmin() ? 'Ask the owner to add numbers to this business.' : 'No numbers are assigned to you yet. Ask an admin to assign one.'}</p>
    ${isOwner() ? html`<button class="btn brand" onclick="location.hash='settings'">Open settings</button>` : ''}</div>`;
}

const rtc = { devices: new Map(), overlay: null };

function loadSdk() {
  if (window.Twilio?.Device) return Promise.resolve();
  return new Promise((ok, bad) => {
    const s = document.createElement('script'); s.src = '/vendor/twilio.min.js'; s.onload = ok;
    s.onerror = () => bad(new Error('Could not load the calling library')); document.head.append(s);
  });
}

// One Device per provider account. The map holds the promise so concurrent callers share it.
function ensureDevice(num) {
  if (rtc.devices.has(num.connection_id)) return rtc.devices.get(num.connection_id);
  const p = (async () => {
    await loadSdk();
    const first = await api('GET', `/voice/token?numberId=${num.id}`);
    const dev = new window.Twilio.Device(first.token, { codecPreferences: ['opus', 'pcmu'], closeProtection: true });
    dev.on('tokenWillExpire', async () => { try { dev.updateToken((await api('GET', `/voice/token?numberId=${num.id}`, undefined, { quiet: true })).token); } catch { /* retry next cycle */ } });
    dev.on('incoming', (call) => onIncoming(call));
    // 31000/31005 are signaling hiccups the SDK retries on its own; don't nag.
    dev.on('error', (e) => { if (![31000, 31005, 31009].includes(e.code)) toast(e.message || 'Call error'); });
    await dev.register();
    return dev;
  })();
  rtc.devices.set(num.connection_id, p);
  p.catch(() => rtc.devices.delete(num.connection_id));
  return p;
}

// Ring in the app while it is open. (Phones can't be woken by a PWA; set "ring my cell too" in Settings.)
function registerDevices() {
  const seen = new Set();
  for (const n of state.numbers) {
    if (!n.canCall || seen.has(n.connection_id)) continue;
    seen.add(n.connection_id);
    ensureDevice(n).catch(() => {});
  }
}

async function placeCall(raw) {
  const to = e164(raw); const n = currentNumber();
  if (!to) return toast('Enter a valid number');
  if (!n?.canCall) return toast('This number can only send texts for now');
  try {
    const dev = await ensureDevice(n);
    const call = await dev.connect({ params: { To: to, numberId: n.id } });
    showCall({ call, who: pretty(to), via: `from ${numLabel(n)}`, incoming: false });
  } catch (err) {
    toast(/permission|denied|NotAllowed/i.test(err.message) ? 'Allow microphone access to place calls' : err.message);
  }
}

function onIncoming(call) {
  const from = call.parameters?.From || 'Unknown'; const to = call.parameters?.To;
  const n = state.numbers.find((x) => x.e164 === to);
  showCall({ call, who: pretty(from), via: n ? `to ${numLabel(n)}` : '', incoming: true });
}

function showCall({ call, who, via, incoming }) {
  closeCall();
  const el = document.createElement('div'); el.className = 'overlay'; document.body.append(el);
  let timer; let secs = 0; let muted = false; let live = !incoming;
  const draw = () => put(el, html`
    <div class="via">${incoming && !live ? 'Incoming call' : live ? 'On call' : 'Calling…'}</div>
    <div class="who">${who}</div><div class="via">${via}</div>
    <div class="time">${live ? clock(secs) : ' '}</div>
    ${live ? html`<div class="mini">${KEYS.map(([k]) => html`<button data-dtmf="${k}">${k}</button>`)}</div>` : ''}
    <div class="acts">
      ${incoming && !live ? html`<button class="end" data-a="reject">Decline</button><button class="ok" data-a="accept">Answer</button>`
        : html`<button class="${muted ? 'on' : ''}" data-a="mute">${muted ? 'Unmute' : 'Mute'}</button><button class="end" data-a="hang">End</button>`}
    </div>`);
  el.addEventListener('click', (e) => {
    const d = e.target.closest('[data-dtmf]'); if (d) return call.sendDigits(d.dataset.dtmf);
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
    if (a === 'accept') call.accept(); else if (a === 'reject') { call.reject(); closeCall(); } else if (a === 'hang') { call.disconnect(); closeCall(); }
    else if (a === 'mute') { muted = !muted; call.mute(muted); draw(); }
  });
  const start = () => { live = true; draw(); timer = setInterval(() => { secs++; const t = $('.overlay .time'); if (t) t.textContent = clock(secs); }, 1000); };
  call.on('accept', start);
  const end = () => { closeCall(); };
  call.on('disconnect', end); call.on('cancel', end); call.on('reject', end); call.on('error', (e) => { toast(e.message || 'Call failed'); end(); });
  rtc.overlay = { el, stop: () => clearInterval(timer) };
  draw();
}
function closeCall() { if (rtc.overlay) { rtc.overlay.stop(); rtc.overlay.el.remove(); rtc.overlay = null; } }

/* ───────── messages ───────── */
function renderMessages() {
  const [, numberId, peerEnc] = location.hash.slice(1).split('/');
  if (numberId && peerEnc) return renderThread(numberId, decodeURIComponent(peerEnc));
  const page = $('#page');
  api('GET', '/threads').then(({ threads }) => {
    if (state.tab !== 'messages' || location.hash.split('/')[2]) return;
    put(page, html`<div class="row" style="margin-bottom:12px"><h2 class="grow">Messages</h2><button class="btn brand sm" id="newMsg">New</button></div>
      ${threads.length ? html`<div class="card" style="padding:4px 16px"><ul class="list">${threads.map((t) => html`
        <li data-open="${t.number_id}|${t.peer}" style="cursor:pointer">
          <div class="avatar">${(pretty(t.peer).replace(/\D/g, '').slice(-2)) || '#'}</div>
          <div class="grow"><div class="row"><strong class="grow">${pretty(t.peer)}</strong><span class="small muted">${ago(t.created_at)}</span></div>
            <div class="small muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${t.direction === 'out' ? 'You: ' : ''}${t.body}</div>
            ${state.numbers.length > 1 ? html`<span class="pill">${numLabel(numById(t.number_id))}</span>` : ''}</div>
          ${t.unread ? html`<i class="dot"></i>` : ''}</li>`)}</ul></div>`
        : html`<div class="empty">No conversations yet.</div>`}`);
    page.querySelectorAll('[data-open]').forEach((li) => li.onclick = () => { const [nid, p] = li.dataset.open.split('|'); location.hash = `messages/${nid}/${encodeURIComponent(p)}`; });
    $('#newMsg').onclick = () => {
      const n = currentNumber(); if (!n) return toast('Connect a number first');
      const p = prompt(`Text from ${numLabel(n)} to which number?`); const to = e164(p);
      if (p && !to) return toast('That number does not look right');
      if (to) location.hash = `messages/${n.id}/${encodeURIComponent(to)}`;
    };
  }).catch((e) => toast(e.message));
}

async function renderThread(numberId, peer) {
  const page = $('#page'); const n = numById(numberId);
  put(page, html`<div class="row" style="margin-bottom:6px">
      <button class="btn ghost sm" id="back">‹ Back</button><div class="grow"><strong>${pretty(peer)}</strong><div class="small muted">via ${numLabel(n)}</div></div>
      ${n?.canCall ? html`<button class="btn brand sm" id="callPeer">Call</button>` : ''}</div>
    <div class="thread"><div class="bubbles" id="bubbles"></div>
      <form class="composer" id="composer"><textarea id="body" rows="1" placeholder="Text message" maxlength="1600"></textarea><button class="btn brand">Send</button></form></div>`);
  $('#back').onclick = () => { location.hash = 'messages'; };
  if (n?.canCall) $('#callPeer').onclick = () => { state.numberId = numberId; store.set('numberId', numberId); placeCall(peer); };
  let lastKey = '';
  const load = async () => {
    const { messages } = await api('GET', `/thread?numberId=${numberId}&peer=${encodeURIComponent(peer)}`, undefined, { quiet: true });
    const key = messages.map((m) => m.id).join();
    if (key === lastKey) return; lastKey = key;
    const box = $('#bubbles'); if (!box) return;
    const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 80 || !box.children.length;
    put(box, html`${messages.map((m) => html`<div class="bubble ${m.direction}">${m.body}<time>${new Date(m.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${m.status === 'failed' ? ' · failed' : ''}</time></div>`)}`);
    if (atEnd) box.scrollTop = box.scrollHeight;
    state.summary = await api('GET', '/summary', undefined, { quiet: true }); paintBadges();
  };
  await load().catch((e) => toast(e.message));
  threadTimer = setInterval(() => load().catch(() => {}), 5000);
  const ta = $('#body');
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(min-width: 900px)').matches) { e.preventDefault(); $('#composer').requestSubmit(); } });
  $('#composer').onsubmit = async (e) => {
    e.preventDefault(); const body = ta.value.trim(); if (!body) return;
    const btn = e.target.querySelector('button'); btn.disabled = true;
    try { await api('POST', '/messages', { numberId, to: peer, body }); ta.value = ''; ta.style.height = 'auto'; lastKey = ''; await load(); const box = $('#bubbles'); box.scrollTop = box.scrollHeight; }
    catch (err) { toast(err.message); } finally { btn.disabled = false; }
  };
}

/* ───────── voicemail + recents ───────── */
async function renderVoicemail() {
  const page = $('#page');
  put(page, html`<div class="seg"><button data-v="voicemail" class="${state.vmView === 'voicemail' ? 'on' : ''}">Voicemail</button><button data-v="recents" class="${state.vmView === 'recents' ? 'on' : ''}">Recent calls</button></div><div id="vmBody"><div class="empty">Loading…</div></div>`);
  page.querySelector('.seg').onclick = (e) => { const b = e.target.closest('[data-v]'); if (b) { state.vmView = b.dataset.v; renderVoicemail(); } };
  const body = $('#vmBody');
  try {
    if (state.vmView === 'voicemail') {
      const { voicemails } = await api('GET', '/voicemails');
      if (!voicemails.length) return put(body, html`<div class="empty">No voicemail. Callers who miss you can leave one after your greeting.</div>`);
      put(body, html`<div class="card" style="padding:4px 16px"><ul class="list">${voicemails.map((v) => html`
        <li style="align-items:flex-start;flex-wrap:wrap" data-id="${v.id}">
          ${v.listened ? '' : html`<i class="dot" style="margin-top:8px"></i>`}
          <div class="grow"><div class="row"><strong class="grow">${pretty(v.peer)}</strong><span class="small muted">${ago(v.created_at)} · ${clock(v.seconds)}</span></div>
            <div class="small muted">to ${numLabel(numById(v.number_id))}</div>
            <audio controls preload="none" src="/api/voicemails/${v.id}/audio" style="margin-top:8px"></audio>
            <div class="row" style="margin-top:8px"><button class="btn sm brand" data-call="${v.peer}">Call back</button><button class="btn sm ghost" data-text="${v.peer}">Text</button><span class="grow"></span><button class="btn sm ghost" data-del="${v.id}">Delete</button></div></div>
        </li>`)}</ul></div>`);
      body.querySelectorAll('audio').forEach((a) => a.addEventListener('play', () => { const li = a.closest('li'); api('POST', `/voicemails/${li.dataset.id}/listened`, {}).then(() => { li.querySelector('.dot')?.remove(); api('GET', '/summary', undefined, { quiet: true }).then((s) => { state.summary = s; paintBadges(); }); }).catch(() => {}); }));
      body.addEventListener('click', async (e) => {
        const c = e.target.closest('[data-call]'); const t = e.target.closest('[data-text]'); const d = e.target.closest('[data-del]');
        if (c) placeCall(c.dataset.call);
        if (t) location.hash = `messages/${state.numberId}/${encodeURIComponent(t.dataset.text)}`;
        if (d && confirm('Delete this voicemail?')) { await api('DELETE', `/voicemails/${d.dataset.del}`).catch((x) => toast(x.message)); renderVoicemail(); }
      });
    } else {
      const { calls } = await api('GET', '/calls');
      if (!calls.length) return put(body, html`<div class="empty">No calls yet.</div>`);
      put(body, html`<div class="card" style="padding:4px 16px"><ul class="list">${calls.map((c) => html`
        <li data-peer="${c.peer}" style="cursor:pointer"><div class="avatar">${c.direction === 'out' ? '↗' : c.status === 'missed' ? '✕' : '↙'}</div>
          <div class="grow"><strong ${c.status === 'missed' ? new Raw('style="color:var(--danger)"') : ''}>${pretty(c.peer)}</strong>
            <div class="small muted">${c.direction === 'out' ? 'Outgoing' : c.status === 'missed' ? 'Missed' : 'Incoming'} · ${numLabel(numById(c.number_id))}${c.seconds ? ' · ' + clock(c.seconds) : ''}</div></div>
          <span class="small muted">${ago(c.created_at)}</span></li>`)}</ul></div>`);
      body.querySelectorAll('[data-peer]').forEach((li) => li.onclick = () => { state.dialValue = li.dataset.peer; location.hash = 'keypad'; });
    }
  } catch (e) { put(body, html`<div class="empty">${e.message}</div>`); }
}

/* ───────── settings ───────── */
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };
const ringLabel = { all: 'Ring everyone at once', sequence: 'Ring one at a time, in order' };

async function renderSettings() {
  const page = $('#page');
  const tabs = [['numbers', 'Numbers'], ...(isAdmin() ? [['people', 'People']] : []), ...(isOwner() ? [['providers', 'Providers']] : []),
    ...(state.me.is_platform_admin ? [['businesses', 'Businesses']] : []), ['account', 'Account']];
  if (!tabs.some((t) => t[0] === state.settingsTab)) state.settingsTab = 'numbers';
  put(page, html`<div class="seg" id="setSeg">${tabs.map(([k, l]) => html`<button data-s="${k}" class="${k === state.settingsTab ? 'on' : ''}">${l}</button>`)}</div><div id="setBody"><div class="empty">Loading…</div></div>`);
  $('#setSeg').onclick = (e) => { const b = e.target.closest('[data-s]'); if (b) { state.settingsTab = b.dataset.s; renderSettings(); } };
  const body = $('#setBody');
  try { await ({ numbers: tabNumbers, people: tabPeople, providers: tabProviders, businesses: tabBusinesses, account: tabAccount })[state.settingsTab](body); }
  catch (e) { put(body, html`<div class="empty">${e.message}</div>`); }
}

/* ---- greeting recorder (one per number card) ---- */
const recorderHtml = () => html`<div class="stack recorder">
  <input class="r-name" placeholder="Name, e.g. After hours" maxlength="60">
  <div class="row wrap"><button type="button" class="btn danger r-rec">● Record</button>
    <label class="btn ghost" style="display:inline-flex;align-items:center">Upload audio<input class="r-file" type="file" accept="audio/*" hidden></label></div>
  <div class="rec hidden r-live"><span class="r-time">0:00</span><div class="meter"><i class="r-meter"></i></div></div>
  <div class="hidden stack r-prev"><audio controls class="r-audio"></audio>
    <div class="row"><button type="button" class="btn brand r-save">Save and use for this number</button><button type="button" class="btn ghost r-discard">Discard</button></div></div>
</div>`;

function mountRecorder(root, { numberId, onSaved }) {
  const $r = (s) => $(s, root);
  const rec = { handle: null, wav: null };
  const show = (s, on) => $r(s).classList.toggle('hidden', !on);
  const preview = (wav) => { rec.wav = wav; $r('.r-audio').src = URL.createObjectURL(wav.blob); show('.r-prev', true); show('.r-live', false); $r('.r-rec').textContent = '● Record'; };
  $r('.r-rec').onclick = guard(async () => {
    if (rec.handle) { const h = rec.handle; rec.handle = null; return preview(h.stop()); }
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Recording needs https and a microphone');
    try {
      rec.handle = await startRecording((level, secs) => {
        $r('.r-meter').style.width = Math.min(100, level * 140) + '%'; $r('.r-time').textContent = clock(secs);
        if (secs >= MAX_SECONDS && rec.handle) { const h = rec.handle; rec.handle = null; preview(h.stop()); }
      });
    } catch { throw new Error('Allow microphone access to record'); }
    show('.r-live', true); show('.r-prev', false); $r('.r-rec').textContent = '■ Stop';
  });
  $r('.r-file').onchange = guard(async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const w = await fileToWav(f);
    if (!$r('.r-name').value) $r('.r-name').value = f.name.replace(/\.[^.]+$/, '').slice(0, 60);
    preview(w); e.target.value = '';
  });
  $r('.r-discard').onclick = () => { rec.wav = null; show('.r-prev', false); };
  $r('.r-save').onclick = guard(async () => {
    if (!rec.wav) return;
    const name = $r('.r-name').value.trim() || 'Greeting';
    await api('POST', `/greetings?name=${encodeURIComponent(name)}&seconds=${rec.wav.seconds}&numberId=${numberId}`, rec.wav.blob);
    toast('Greeting saved and active'); onSaved();
  });
}

/* ---- numbers ---- */
function peopleRows(n, team) {
  const inOrder = n.people.map((p) => team.find((u) => u.id === p.id)).filter(Boolean);
  const rest = team.filter((u) => !n.people.some((p) => p.id === u.id));
  return [...inOrder.map((u) => [u, true]), ...rest.map((u) => [u, false])];
}

async function tabNumbers(body) {
  const admin = isAdmin();
  const [nums, gs, team] = await Promise.all([api('GET', '/numbers'), api('GET', '/greetings'), admin ? api('GET', '/team') : { users: [] }]);
  state.numbers = nums.numbers; paintHeader();
  if (!nums.numbers.length) return put(body, emptyNumbers());
  put(body, html`${state.needsPublicUrl && admin ? html`<div class="card"><strong>Set PUBLIC_URL on the server.</strong><div class="small muted">Webhooks need the app's public https address.</div></div>` : ''}
    ${nums.numbers.map((n) => html`<div class="card stack" data-n="${n.id}">
      <div class="row"><strong class="grow" style="font-size:18px">${pretty(n.e164)}</strong><span class="pill">${n.provider}${n.canCall ? '' : ' · text only'}</span></div>
      ${admin ? html`<label class="f">Name<input data-f="label" value="${n.label}" maxlength="60"></label>` : html`<div class="muted">${n.label}</div>`}

      ${n.canCall ? html`
      ${admin ? html`<div><div class="small muted" style="margin-bottom:6px">Who gets calls to this number (tick people; use ▲▼ to set the order)</div>
        <div class="people">${team.users.length ? peopleRows(n, team.users).map(([u, on]) => html`<div class="row" data-u="${u.id}" style="padding:4px 0">
          <input type="checkbox" style="width:22px;min-height:22px" ${on ? new Raw('checked') : ''}><span class="grow">${u.name || u.email} <span class="small muted">${u.role}</span></span>
          <button type="button" class="btn sm ghost" data-up>▲</button><button type="button" class="btn sm ghost" data-down>▼</button></div>`)
          : html`<div class="small muted">Add people on the People tab first.</div>`}</div>
        <div class="small muted">If nobody is ticked, the owners and admins get the call.</div></div>
      <label class="f">Ringing<select data-f="ring_mode">${Object.entries(ringLabel).map(([k, v]) => html`<option value="${k}" ${n.ring_mode === k ? new Raw('selected') : ''}>${v}</option>`)}</select></label>
      <div class="row"><label class="f grow">Also ring this cell<input data-f="forward_to" type="tel" placeholder="(555) 123-4567" value="${n.forward_to || ''}"></label>
        <label class="f" style="width:110px">Ring (sec)<input data-f="ring_seconds" type="number" min="5" max="60" value="${n.ring_seconds}"></label></div>` : html`<div class="small muted">Rings: ${n.people.length ? n.people.map((p) => p.name).join(', ') : 'owners and admins'}</div>`}

      <div class="stack"><label class="f">Voicemail greeting
        <div class="row"><select data-f="greeting_id" class="grow"><option value="">Standard prompt</option>${gs.greetings.filter((g) => !g.number_id || g.number_id === n.id).map((g) => html`<option value="${g.id}" ${g.id === n.greeting_id ? new Raw('selected') : ''}>${g.name} (${clock(g.seconds)})</option>`)}</select>
          <button type="button" class="btn sm ghost" data-play>Play</button></div></label>
        <details><summary class="small" style="cursor:pointer;color:var(--accent)">Record or upload a new greeting</summary><div style="margin-top:10px" class="rec-slot">${recorderHtml()}</div></details></div>` : html`<div class="small muted">Voicemail and calling aren't available on Bird numbers yet.</div>`}
      <button class="btn sm" data-save>Save</button></div>`)}`);

  body.querySelectorAll('[data-n]').forEach((card) => {
    const n = nums.numbers.find((x) => x.id === card.dataset.n);
    const slot = $('.rec-slot', card);
    if (slot) mountRecorder(slot, { numberId: n.id, onSaved: () => tabNumbers(body) });
    card.addEventListener('click', guard(async (e) => {
      const row = e.target.closest('[data-u]');
      if (e.target.closest('[data-up]') && row.previousElementSibling) row.parentNode.insertBefore(row, row.previousElementSibling);
      if (e.target.closest('[data-down]') && row.nextElementSibling) row.parentNode.insertBefore(row.nextElementSibling, row);
      if (e.target.closest('[data-play]')) { const g = $('[data-f=greeting_id]', card).value; if (g) new Audio(`/api/greetings/${g}/audio`).play(); else toast('That is the standard prompt'); }
      if (e.target.closest('[data-save]')) {
        const patch = { greeting_id: $('[data-f=greeting_id]', card)?.value || null };
        if (admin) {
          patch.label = $('[data-f=label]', card).value;
          if (n.canCall) {
            patch.people = [...card.querySelectorAll('[data-u]')].filter((r) => $('input', r).checked).map((r) => r.dataset.u);
            patch.ring_mode = $('[data-f=ring_mode]', card).value;
            patch.forward_to = $('[data-f=forward_to]', card).value;
            patch.ring_seconds = $('[data-f=ring_seconds]', card).value;
          }
        } else if (!n.canCall) return;
        if (!n.canCall) delete patch.greeting_id;
        await api('PATCH', `/numbers/${n.id}`, patch); toast('Saved'); await tabNumbers(body);
      }
    }));
  });
}

/* ---- people ---- */
async function tabPeople(body) {
  const [team, nums] = await Promise.all([api('GET', '/team'), api('GET', '/numbers')]);
  const owner = isOwner();
  const numberBoxes = (sel = []) => nums.numbers.length ? nums.numbers.map((n) => html`<label class="row small" style="padding:3px 0"><input type="checkbox" value="${n.id}" style="width:20px;min-height:20px" ${sel.includes(n.id) ? new Raw('checked') : ''}>${n.label} · ${pretty(n.e164)}</label>`) : html`<div class="small muted">No numbers in this business yet.</div>`;
  put(body, html`<div class="card"><h2>People in ${state.company}</h2><div class="small muted" style="margin-bottom:6px">Members only see the numbers you tick for them.</div>
    <ul class="list">${team.users.map((u) => html`<li data-p="${u.id}" style="flex-wrap:wrap;align-items:flex-start">
      <div class="grow"><strong>${u.name || u.email}</strong><div class="small muted">${u.email}</div></div>
      <span class="pill">${u.role}</span>
      <details style="width:100%"><summary class="small" style="cursor:pointer;color:var(--accent)">Numbers and role</summary><div class="stack" style="margin-top:8px">
        <div class="nums">${numberBoxes(u.number_ids)}</div>
        ${owner && u.role !== 'owner' && u.id !== state.me.id ? html`<label class="f">Role<select data-role><option value="member" ${u.role === 'member' ? new Raw('selected') : ''}>Member</option><option value="admin" ${u.role === 'admin' ? new Raw('selected') : ''}>Admin</option></select></label>` : ''}
        <div class="row"><button class="btn sm" data-save>Save</button>${u.id !== state.me.id ? html`<button class="btn sm ghost" data-del>Remove</button>` : ''}</div></div></details></li>`)}</ul></div>
    <form class="card stack" id="addPerson"><h2>Add a person</h2>
      <div class="row"><input name="name" placeholder="Name"><input name="email" type="email" placeholder="Email" required></div>
      <input name="password" type="password" minlength="8" placeholder="Temporary password (skip if they already have an account)">
      ${owner ? html`<label class="f">Role<select name="role"><option value="member">Member</option><option value="admin">Admin</option></select></label>` : ''}
      <div><div class="small muted">Numbers they can use</div><div class="nums">${numberBoxes()}</div></div>
      <div class="err" id="addErr"></div><button class="btn brand">Add person</button></form>`);
  const checked = (root) => [...root.querySelectorAll('.nums input:checked')].map((i) => i.value);
  body.querySelector('.list').addEventListener('click', guard(async (e) => {
    const li = e.target.closest('[data-p]'); if (!li) return;
    if (e.target.closest('[data-save]')) {
      const patch = { numberIds: checked(li) }; const role = $('[data-role]', li); if (role) patch.role = role.value;
      await api('PATCH', `/team/${li.dataset.p}`, patch); toast('Saved'); tabPeople(body);
    }
    if (e.target.closest('[data-del]') && confirm('Remove this person from the business?')) { await api('DELETE', `/team/${li.dataset.p}`); tabPeople(body); }
  }));
  $('#addPerson').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target; const data = Object.fromEntries(new FormData(f)); data.numberIds = checked(f);
    try { const r = await api('POST', '/team', data); toast(r.existed ? 'Added. They use their existing login.' : 'Person added. Share the temporary password with them.'); tabPeople(body); }
    catch (err) { $('#addErr').textContent = err.message; }
  };
}

/* ---- providers ---- */
async function tabProviders(body) {
  const cs = await api('GET', '/connections');
  put(body, html`<div class="card stack"><h2>Providers</h2>
    ${cs.connections.length ? html`<ul class="list">${cs.connections.map((c) => html`<li><div class="grow"><strong>${c.label}</strong> <span class="pill">${c.provider}</span>
      <div class="small muted">${c.numbers} number${c.numbers === 1 ? '' : 's'}${state.me.is_platform_admin ? ` · ${c.business}` : ''}</div>
      ${c.webhookUrl ? html`<div class="small">Bird inbound webhook (paste in Bird):<input readonly value="${c.webhookUrl}" onclick="this.select()"></div>` : ''}</div>
      ${c.provider === 'twilio' ? html`<button class="btn sm ghost" data-resync="${c.id}">Sync</button>` : ''}<button class="btn sm ghost" data-cdel="${c.id}">Remove</button></li>`)}</ul>` : html`<div class="small muted">Nothing connected yet.</div>`}
    <div class="seg" id="provSeg"><button data-p="twilio" class="on">Twilio</button><button data-p="bird">Bird</button></div>
    <form class="stack" id="twForm"><label class="f">Account SID<input name="accountSid" placeholder="AC…" autocomplete="off" required></label><label class="f">Auth Token<input name="authToken" type="password" autocomplete="off" required></label>
      <div class="small muted">We create the API key and calling app, import your numbers and point their voice and text webhooks here. New numbers land in ${state.company}; move them to other businesses from the Businesses tab.</div><div class="err" id="twErr"></div><button class="btn brand">Connect Twilio</button></form>
    <form class="stack hidden" id="brForm"><label class="f">Access key<input name="accessKey" type="password" autocomplete="off" required></label><label class="f">Workspace ID<input name="workspaceId" required></label><label class="f">SMS channel ID<input name="channelId" required></label><label class="f">Channel phone number<input name="number" type="tel" placeholder="+1…" required></label>
      <div class="small muted">Texting only for now. After connecting, copy the webhook URL into Bird so inbound texts arrive.</div><div class="err" id="brErr"></div><button class="btn brand">Connect Bird</button></form></div>`);
  const refresh = async () => { await loadNumbers(); paintHeader(); tabProviders(body); };
  body.onclick = guard(async (e) => {
    const t = e.target;
    const rs = t.closest('[data-resync]'); if (rs) { rs.disabled = true; const r = await api('POST', `/connections/${rs.dataset.resync}/resync`, {}); toast(r.added.length ? `Added ${r.added.length} number(s)` : 'Up to date'); return refresh(); }
    const cd = t.closest('[data-cdel]'); if (cd && confirm('Remove this provider and its numbers, messages and voicemail from the app? (Nothing changes in your Twilio/Bird account.)')) { await api('DELETE', `/connections/${cd.dataset.cdel}`); return refresh(); }
    const seg = t.closest('#provSeg [data-p]');
    if (seg) { body.querySelectorAll('#provSeg button').forEach((b) => b.classList.toggle('on', b === seg)); $('#twForm').classList.toggle('hidden', seg.dataset.p !== 'twilio'); $('#brForm').classList.toggle('hidden', seg.dataset.p !== 'bird'); }
  });
  const submit = (sel, errSel, path, done) => {
    const f = $(sel, body);
    f.onsubmit = async (e) => {
      e.preventDefault(); const btn = f.querySelector('button'); btn.disabled = true; $(errSel).textContent = '';
      try { await done(await api('POST', path, Object.fromEntries(new FormData(f)))); } catch (err) { $(errSel).textContent = err.message; } finally { btn.disabled = false; }
    };
  };
  submit('#twForm', '#twErr', '/connections/twilio', async (r) => { toast(`Imported ${r.added.length} number(s)${r.warnings.length ? ' · some webhooks need attention' : ''}`); await refresh(); registerDevices(); });
  submit('#brForm', '#brErr', '/connections/bird', async () => { toast('Bird connected. Copy its webhook URL into Bird.'); await refresh(); });
}

/* ---- businesses (operator) ---- */
async function tabBusinesses(body) {
  const [bs, all] = await Promise.all([api('GET', '/businesses'), api('GET', '/admin/numbers')]);
  put(body, html`<div class="card"><h2>Businesses</h2><div class="small muted" style="margin-bottom:6px">Each business has its own people, numbers, messages and voicemail. You can open any of them.</div>
    <ul class="list">${bs.businesses.map((b) => html`<li data-b="${b.id}"><div class="grow"><strong>${b.name}</strong><div class="small muted">${b.numbers} number${b.numbers === 1 ? '' : 's'} · ${b.people} ${b.people === 1 ? 'person' : 'people'}</div></div>
      ${b.id === state.me.tenant_id ? html`<span class="pill">current</span>` : html`<button class="btn sm" data-go>Open</button><button class="btn sm ghost" data-del>Delete</button>`}</li>`)}</ul></div>
    <form class="card stack" id="newBiz"><h2>New business</h2><input name="name" placeholder="Business name" maxlength="80" required><div class="err" id="bizErr"></div><button class="btn brand">Create</button></form>
    <div class="card"><h2>Assign numbers to businesses</h2><div class="small muted" style="margin-bottom:6px">Moving a number takes its texts, calls and voicemail with it and clears who was assigned to it.</div>
      <ul class="list">${all.numbers.map((n) => html`<li data-num="${n.id}"><div class="grow"><strong>${pretty(n.e164)}</strong><div class="small muted">${n.label} · ${n.provider}</div></div>
        <select data-move style="max-width:55%">${bs.businesses.map((b) => html`<option value="${b.id}" ${b.id === n.tenant_id ? new Raw('selected') : ''}>${b.name}</option>`)}</select></li>`)}</ul>
      ${all.numbers.length ? '' : html`<div class="empty">No numbers yet. Connect Twilio on the Providers tab.</div>`}</div>`);
  body.onclick = guard(async (e) => {
    const li = e.target.closest('[data-b]'); if (!li) return;
    if (e.target.closest('[data-go]')) { await switchBusiness(li.dataset.b); }
    if (e.target.closest('[data-del]') && confirm('Delete this business? It must have no numbers or providers.')) { await api('DELETE', `/businesses/${li.dataset.b}`); tabBusinesses(body); }
  });
  body.onchange = guard(async (e) => {
    const sel = e.target.closest('[data-move]'); if (!sel) return;
    const li = sel.closest('[data-num]'); const name = sel.options[sel.selectedIndex].text;
    if (!confirm(`Move this number to ${name}? Its history moves too and assignments reset.`)) return tabBusinesses(body);
    await api('POST', `/numbers/${li.dataset.num}/move`, { tenantId: sel.value }); toast(`Moved to ${name}`); await loadNumbers(); paintHeader(); tabBusinesses(body);
  });
  $('#newBiz').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('POST', '/businesses', { name: new FormData(e.target).get('name') }); toast('Business created'); tabBusinesses(body); }
    catch (err) { $('#bizErr').textContent = err.message; }
  };
}

/* ---- account ---- */
async function tabAccount(body) {
  put(body, html`<div class="card stack"><h2>${state.me.name || state.me.email}</h2><div class="small muted">${state.me.email} · ${state.me.is_platform_admin ? 'operator' : state.me.role} in ${state.company}</div></div>
    <form class="card stack" id="pwForm"><h2>Change password</h2><input name="current" type="password" placeholder="Current password" autocomplete="current-password" required>
      <input name="next" type="password" placeholder="New password (8+ characters)" minlength="8" autocomplete="new-password" required><div class="err" id="pwErr"></div><button class="btn">Update password</button></form>
    <div class="card stack"><h2>This device</h2>
      <div class="small muted">Install: on iPhone tap Share → Add to Home Screen. On Android tap ⋮ → Install app. On desktop use the install icon in the address bar.</div>
      <div class="row wrap">${state.installEvt ? html`<button class="btn" id="installBtn">Install app</button>` : ''}<button class="btn ghost" id="logoutBtn">Sign out</button></div></div>`);
  $('#pwForm').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('POST', '/password', Object.fromEntries(new FormData(e.target))); toast('Password updated'); e.target.reset(); $('#pwErr').textContent = ''; }
    catch (err) { $('#pwErr').textContent = err.message; }
  };
  $('#installBtn')?.addEventListener('click', () => state.installEvt.prompt());
  $('#logoutBtn').onclick = guard(async () => {
    await api('POST', '/logout', {}); state.me = null; rtc.devices.forEach((p) => p.then((d) => d.destroy()).catch(() => {})); rtc.devices.clear(); $('#app').innerHTML = ''; render();
  });
}

boot();
