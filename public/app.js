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
  tab: 'keypad', summary: { unreadMessages: 0, newVoicemails: 0 }, dialValue: '', vmView: 'voicemail', installEvt: null,
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

/* ───────── boot ───────── */
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installEvt = e; });
  window.addEventListener('hashchange', () => { if (state.me) render(); });
  try {
    const me = await api('GET', '/me', undefined, { quiet: true });
    if (me.user) { state.me = me.user; state.company = me.company; state.needsPublicUrl = me.needsPublicUrl; await afterLogin(); }
  } catch { /* show login */ }
  render();
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
      <header class="top"><div class="co">${state.company}</div><select id="asNum" aria-label="Active number"></select></header>
      <main class="main"><div class="page" id="page"></div></main>
      <nav class="nav">${TABS.map(([k, label]) => html`<button data-tab="${k}">${new Raw(ICON[k])}<span>${label}</span><i class="badge hidden"></i></button>`)}</nav>
    </div>`);
    $('.nav').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) location.hash = b.dataset.tab; });
    $('#asNum').addEventListener('change', (e) => { state.numberId = e.target.value; store.set('numberId', state.numberId); render(); });
  }
  paintHeader(); paintBadges();
  document.querySelectorAll('.nav [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));
  clearInterval(threadTimer);
  ({ keypad: renderKeypad, messages: renderMessages, voicemail: renderVoicemail, settings: renderSettings })[state.tab]();
}

function paintHeader() {
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
        state.me = r.user; state.company = r.company; await afterLogin(); location.hash = 'keypad'; render();
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
  return html`<div class="empty"><h2>No numbers yet</h2><p>${isOwner() ? 'Connect Twilio or Bird to bring your numbers in.' : 'Ask your account owner to connect a provider.'}</p>
    ${isOwner() ? html`<button class="btn brand" onclick="location.hash='settings'">Connect a provider</button>` : ''}</div>`;
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
async function renderSettings() {
  const page = $('#page');
  put(page, html`<div class="empty">Loading…</div>`);
  const [nums, gs, cs, team] = await Promise.all([
    api('GET', '/numbers'), api('GET', '/greetings'), api('GET', '/connections'), api('GET', '/team'),
  ]).catch((e) => { toast(e.message); return []; });
  if (!nums) return;
  state.numbers = nums.numbers;
  const greetings = gs.greetings; const owner = isOwner();

  put(page, html`
    ${state.needsPublicUrl && owner ? html`<div class="card"><strong>Set PUBLIC_URL on the server.</strong><div class="small muted">Webhooks and "Connect" need the app's public https address (for example https://phone.example.com).</div></div>` : ''}

    <div class="card stack" id="greetCard">
      <div><h2>Voicemail greetings</h2><div class="small muted">Record in your browser or upload any audio file (up to ${MAX_SECONDS}s). Then pick it for each number below.</div></div>
      ${owner ? html`
      <div class="stack" id="recorder">
        <input id="gName" placeholder="Name, e.g. Business hours" maxlength="60">
        <div class="row wrap"><button class="btn danger" id="recBtn">● Record</button><label class="btn ghost" style="display:inline-flex;align-items:center">Upload audio<input id="gFile" type="file" accept="audio/*" hidden></label></div>
        <div class="rec hidden" id="recLive"><span id="recTime">0:00</span><div class="meter"><i id="recMeter"></i></div></div>
        <div class="hidden stack" id="gPreview"><audio controls id="gAudio"></audio><div class="row"><button class="btn brand" id="gSave">Save greeting</button><button class="btn ghost" id="gDiscard">Discard</button></div></div>
      </div>` : ''}
      <ul class="list" id="gList">${greetings.length ? greetings.map((g) => html`<li data-g="${g.id}"><div class="grow"><strong>${g.name}</strong><div class="small muted">${clock(g.seconds)}${g.used_by ? ` · used by ${g.used_by} number${g.used_by > 1 ? 's' : ''}` : ''}</div></div>
        <button class="btn sm ghost" data-play="${g.id}">Play</button>${owner ? html`<button class="btn sm ghost" data-gdel="${g.id}">Delete</button>` : ''}</li>`)
        : html`<li class="muted small">No greetings yet. Callers will hear a standard "leave a message" prompt.</li>`}</ul>
    </div>

    <div class="card"><h2>Numbers</h2><div class="small muted" style="margin-bottom:6px">Greeting, ring time and an optional cell phone to ring along with the app.</div>
      ${nums.numbers.length ? nums.numbers.map((n) => html`<div class="stack" data-n="${n.id}" style="padding:12px 0;border-top:1px solid var(--line)">
        <div class="row"><strong class="grow">${pretty(n.e164)}</strong><span class="pill">${n.provider}${n.canCall ? '' : ' · text only'}</span></div>
        <label class="f">Name<input data-f="label" value="${n.label}" ${owner ? '' : new Raw('disabled')}></label>
        ${n.canCall ? html`
        <label class="f">Voicemail greeting<select data-f="greeting_id" ${owner ? '' : new Raw('disabled')}><option value="">Standard prompt</option>${greetings.map((g) => html`<option value="${g.id}" ${g.id === n.greeting_id ? new Raw('selected') : ''}>${g.name}</option>`)}</select></label>
        <div class="row"><label class="f grow">Also ring my cell<input data-f="forward_to" type="tel" placeholder="(555) 123-4567" value="${n.forward_to || ''}" ${owner ? '' : new Raw('disabled')}></label>
          <label class="f" style="width:110px">Ring (sec)<input data-f="ring_seconds" type="number" min="5" max="60" value="${n.ring_seconds}" ${owner ? '' : new Raw('disabled')}></label></div>` : html`<div class="small muted">Voicemail isn't available on Bird numbers yet.</div>`}
        ${owner ? html`<button class="btn sm" data-save="${n.id}">Save</button>` : ''}</div>`)
        : html`<div class="empty">No numbers yet. Connect a provider below.</div>`}</div>

    <div class="card stack"><h2>Providers</h2>
      ${cs.connections.length ? html`<ul class="list">${cs.connections.map((c) => html`<li><div class="grow"><strong>${c.label}</strong> <span class="pill">${c.provider}</span><div class="small muted">${c.numbers} number${c.numbers === 1 ? '' : 's'}</div>
        ${c.webhookUrl ? html`<div class="small">Bird inbound webhook (paste in Bird):<input readonly value="${c.webhookUrl}" onclick="this.select()"></div>` : ''}</div>
        ${owner ? html`${c.provider === 'twilio' ? html`<button class="btn sm ghost" data-resync="${c.id}">Sync</button>` : ''}<button class="btn sm ghost" data-cdel="${c.id}">Remove</button>` : ''}</li>`)}</ul>` : ''}
      ${owner ? html`
      <div class="seg" id="provSeg"><button data-p="twilio" class="on">Twilio</button><button data-p="bird">Bird</button></div>
      <form class="stack" id="twForm"><label class="f">Account SID<input name="accountSid" placeholder="AC…" autocomplete="off" required></label><label class="f">Auth Token<input name="authToken" type="password" autocomplete="off" required></label>
        <div class="small muted">One tap: we create the API key + calling app, import your numbers, and point their voice and text webhooks here.</div><div class="err" id="twErr"></div><button class="btn brand">Connect Twilio</button></form>
      <form class="stack hidden" id="brForm"><label class="f">Access key<input name="accessKey" type="password" autocomplete="off" required></label><label class="f">Workspace ID<input name="workspaceId" required></label><label class="f">SMS channel ID<input name="channelId" required></label><label class="f">Channel phone number<input name="number" type="tel" placeholder="+1…" required></label>
        <div class="small muted">Texting only for now. After connecting, copy the webhook URL into Bird so inbound texts arrive here.</div><div class="err" id="brErr"></div><button class="btn brand">Connect Bird</button></form>` : ''}
    </div>

    <div class="card stack"><h2>Team</h2>
      <ul class="list">${team.users.map((u) => html`<li><div class="grow"><strong>${u.name || u.email}</strong><div class="small muted">${u.email} · ${u.role}</div></div>${owner && u.id !== state.me.id ? html`<button class="btn sm ghost" data-udel="${u.id}">Remove</button>` : ''}</li>`)}</ul>
      ${owner ? html`<form class="stack" id="teamForm"><div class="row"><input name="name" placeholder="Name"><input name="email" type="email" placeholder="Email" required></div><div class="row"><input name="password" type="password" placeholder="Temporary password (8+)" minlength="8" required><button class="btn">Add</button></div><div class="err" id="teamErr"></div></form>` : ''}
    </div>

    <div class="card stack"><h2>This device</h2>
      <div class="small muted">Install: on iPhone tap Share → Add to Home Screen. On Android tap ⋮ → Install app. On desktop use the install icon in the address bar.</div>
      <div class="row wrap">${state.installEvt ? html`<button class="btn" id="installBtn">Install app</button>` : ''}<button class="btn ghost" id="logoutBtn">Sign out</button></div>
    </div>`);
  wireSettings(page, greetings);
}

function wireSettings(page, greetings) {
  const refresh = async () => { await loadNumbers(); paintHeader(); renderSettings(); };
  const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };

  page.onclick = guard(async (e) => { // assigned (not added) so re-renders never stack handlers
    const t = e.target;
    const play = t.closest('[data-play]'); if (play) { const a = new Audio(`/api/greetings/${play.dataset.play}/audio`); a.play(); return; }
    const gd = t.closest('[data-gdel]'); if (gd && confirm('Delete this greeting? Numbers using it fall back to the standard prompt.')) { await api('DELETE', `/greetings/${gd.dataset.gdel}`); return refresh(); }
    const sv = t.closest('[data-save]');
    if (sv) {
      const box = sv.closest('[data-n]'); const body = {};
      box.querySelectorAll('[data-f]').forEach((i) => { body[i.dataset.f] = i.value; });
      await api('PATCH', `/numbers/${sv.dataset.save}`, body); toast('Saved'); await loadNumbers(); paintHeader(); return renderSettings();
    }
    const rs = t.closest('[data-resync]'); if (rs) { rs.disabled = true; const r = await api('POST', `/connections/${rs.dataset.resync}/resync`, {}); toast(r.added.length ? `Added ${r.added.length} number(s)` : 'Up to date'); return refresh(); }
    const cd = t.closest('[data-cdel]'); if (cd && confirm('Remove this provider and its numbers, messages and voicemail from the app? (Nothing changes in your Twilio/Bird account.)')) { await api('DELETE', `/connections/${cd.dataset.cdel}`); return refresh(); }
    const ud = t.closest('[data-udel]'); if (ud && confirm('Remove this person?')) { await api('DELETE', `/team/${ud.dataset.udel}`); return renderSettings(); }
    if (t.closest('#logoutBtn')) { await api('POST', '/logout', {}); state.me = null; rtc.devices.forEach((p) => p.then((d) => d.destroy()).catch(() => {})); rtc.devices.clear(); $('#app').innerHTML = ''; return render(); }
    if (t.closest('#installBtn')) { state.installEvt.prompt(); }
    const seg = t.closest('#provSeg [data-p]');
    if (seg) { page.querySelectorAll('#provSeg button').forEach((b) => b.classList.toggle('on', b === seg)); $('#twForm').classList.toggle('hidden', seg.dataset.p !== 'twilio'); $('#brForm').classList.toggle('hidden', seg.dataset.p !== 'bird'); }
  });

  const submit = (sel, errSel, path, done) => {
    const f = $(sel, page); if (!f) return;
    f.onsubmit = async (e) => {
      e.preventDefault(); const btn = f.querySelector('button:not([type=button])'); btn.disabled = true; $(errSel).textContent = '';
      try { const r = await api('POST', path, Object.fromEntries(new FormData(f))); await done(r); } catch (err) { $(errSel).textContent = err.message; } finally { btn.disabled = false; }
    };
  };
  submit('#twForm', '#twErr', '/connections/twilio', async (r) => { toast(`Imported ${r.added.length} number(s)${r.warnings.length ? ' · some webhooks need attention' : ''}`); await refresh(); registerDevices(); });
  submit('#brForm', '#brErr', '/connections/bird', async () => { toast('Bird connected. Copy its webhook URL into Bird.'); await refresh(); });
  submit('#teamForm', '#teamErr', '/team', async () => { toast('Person added'); renderSettings(); });

  // greeting recorder
  const rec = { handle: null, wav: null };
  const show = (id, on) => $(id, page)?.classList.toggle('hidden', !on);
  const preview = (wav) => { rec.wav = wav; $('#gAudio', page).src = URL.createObjectURL(wav.blob); show('#gPreview', true); show('#recLive', false); $('#recBtn', page).textContent = '● Record'; };
  const recBtn = $('#recBtn', page);
  if (recBtn) {
    recBtn.onclick = guard(async () => {
      if (rec.handle) { const h = rec.handle; rec.handle = null; return preview(h.stop()); }
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Recording needs https and a microphone');
      try {
        rec.handle = await startRecording((level, secs) => {
          $('#recMeter', page).style.width = Math.min(100, level * 140) + '%'; $('#recTime', page).textContent = clock(secs);
          if (secs >= MAX_SECONDS && rec.handle) { const h = rec.handle; rec.handle = null; preview(h.stop()); }
        });
      } catch { throw new Error('Allow microphone access to record'); }
      show('#recLive', true); show('#gPreview', false); recBtn.textContent = '■ Stop';
    });
    $('#gFile', page).onchange = guard(async (e) => { const f = e.target.files[0]; if (!f) return; const w = await fileToWav(f); if (!$('#gName', page).value) $('#gName', page).value = f.name.replace(/\.[^.]+$/, '').slice(0, 60); preview(w); e.target.value = ''; });
    $('#gDiscard', page).onclick = () => { rec.wav = null; show('#gPreview', false); };
    $('#gSave', page).onclick = guard(async () => {
      if (!rec.wav) return; const name = $('#gName', page).value.trim() || 'Greeting';
      await api('POST', `/greetings?name=${encodeURIComponent(name)}&seconds=${rec.wav.seconds}`, rec.wav.blob);
      toast('Greeting saved. Pick it for a number below.'); renderSettings();
    });
  }
  void greetings;
}

boot();
