'use strict';
// Real-Postgres flow tests. Set PHONE_TEST_DATABASE_URL to a throwaway database; skipped otherwise.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createPool, ensureSchema } = require('../src/db');
const { createApp } = require('../src/app');
const C = require('../src/crypto');
const { identityFor } = require('../src/util');

const URL_ = process.env.PHONE_TEST_DATABASE_URL;
const SECRET = 'test-secret-test-secret';
const PUBLIC = 'https://phone.test';
const TOKEN = 'twilio-auth-token';

test('call, voicemail, SMS and tenant isolation', { skip: URL_ ? false : 'PHONE_TEST_DATABASE_URL not set' }, async (t) => {
  const pool = createPool(URL_);
  await ensureSchema(pool);
  await pool.query('TRUNCATE tenants CASCADE');
  const server = createApp({ pool, env: { APP_SECRET: SECRET, PUBLIC_URL: PUBLIC } }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await pool.end(); });

  // ---- helpers
  const sign = (path, params) => crypto.createHmac('sha1', TOKEN)
    .update(Object.keys(params).sort().reduce((a, k) => a + k + params[k], PUBLIC + path)).digest('base64');
  const hook = (path, params, { badSig } = {}) => fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': badSig ? 'nope' : sign(path, params) },
    body: new URLSearchParams(params).toString(),
  });
  const signup = async (company, email) => {
    const r = await fetch(base + '/api/signup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'phone' }, body: JSON.stringify({ company, email, password: 'password123' }) });
    assert.equal(r.status, 200);
    const cookie = r.headers.get('set-cookie').split(';')[0];
    const body = await r.json();
    const call = (method, path, data, raw) => fetch(base + '/api' + path, {
      method, headers: { Cookie: cookie, 'X-Requested-With': 'phone', ...(data && !raw ? { 'Content-Type': 'application/json' } : {}) },
      body: raw ? data : data ? JSON.stringify(data) : undefined,
    });
    return { user: body.user, call };
  };
  const seedNumber = async (tenantId, e164, provider = 'twilio', partial = false) => {
    const full = { accountSid: 'AC' + 'a'.repeat(32), authToken: TOKEN, apiKeySid: 'SK' + 'b'.repeat(32), apiKeySecret: 'keysecret', appSid: 'AP' + 'c'.repeat(32) };
    const creds = provider === 'twilio' ? (partial ? { accountSid: full.accountSid, authToken: TOKEN } : full) : { accessKey: 'k', workspaceId: 'w', channelId: 'c' };
    const c = (await pool.query('INSERT INTO connections (tenant_id, provider, label, creds_enc, hook_key) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [tenantId, provider, 'conn', C.encrypt(creds, SECRET), 'hookkey123'])).rows[0].id;
    const n = (await pool.query('INSERT INTO numbers (tenant_id, connection_id, e164) VALUES ($1,$2,$3) RETURNING id', [tenantId, c, e164])).rows[0].id;
    return { connId: c, numberId: n };
  };

  const A = await signup('Alpha Freight', 'alpha@x.co');
  const B = await signup('Beta Haulers', 'beta@x.co');
  const a = await seedNumber(A.user.tenant_id, '+15550000001');
  const b = await seedNumber(B.user.tenant_id, '+15550000002');

  await t.test('inbound call rings the tenant\'s users and forwarding cell', async () => {
    await pool.query('UPDATE numbers SET forward_to = $1, ring_seconds = 25 WHERE id = $2', ['+15559990000', a.numberId]);
    const path = `/hooks/twilio/voice/in/${a.numberId}`;
    const r = await hook(path, { CallSid: 'CAin1', From: '+15551112222', To: '+15550000001' });
    const xml = await r.text();
    assert.equal(r.status, 200);
    assert.match(xml, new RegExp(`<Client>${identityFor(A.user.id)}</Client>`));
    assert.match(xml, /<Number>\+15559990000<\/Number>/);
    assert.match(xml, /timeout="25"/);
    assert.ok(!xml.includes(identityFor(B.user.id)), 'must not ring another tenant');
    const call = (await pool.query("SELECT * FROM calls WHERE provider_id = 'CAin1'")).rows[0];
    assert.equal(call.direction, 'in'); assert.equal(call.peer, '+15551112222');
  });

  await t.test('forged or wrong-account signatures are rejected', async () => {
    const path = `/hooks/twilio/voice/in/${a.numberId}`;
    assert.equal((await hook(path, { CallSid: 'CAx', From: '+1' }, { badSig: true })).status, 403);
    assert.equal((await fetch(base + path, { method: 'POST' })).status, 403);
    assert.equal((await hook('/hooks/twilio/voice/in/not-a-uuid', { CallSid: 'x' })).status, 403);
  });

  await t.test('unanswered call plays the custom greeting then records', async () => {
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(2000)]);
    const up = await A.call('POST', '/greetings?name=Hours&seconds=12', wav, true);
    assert.equal(up.status, 200);
    const gid = (await up.json()).greeting.id;
    assert.equal((await A.call('PATCH', `/numbers/${a.numberId}`, { greeting_id: gid })).status, 200);
    const path = `/hooks/twilio/voice/dialdone/${a.numberId}`;
    const xml = await (await hook(path, { CallSid: 'CAin1', DialCallStatus: 'no-answer' })).text();
    assert.match(xml, new RegExp(`<Play>${PUBLIC}/greeting/${gid}\\.wav</Play>`));
    assert.match(xml, /<Record /);
    assert.equal((await pool.query("SELECT status FROM calls WHERE provider_id = 'CAin1'")).rows[0].status, 'missed');
    const audio = await fetch(`${base}/greeting/${gid}.wav`);
    assert.equal(audio.status, 200); assert.equal(Buffer.from(await audio.arrayBuffer()).length, wav.length);
  });

  await t.test('answered call logs duration and does not go to voicemail', async () => {
    await hook(`/hooks/twilio/voice/in/${a.numberId}`, { CallSid: 'CAin2', From: '+15553334444' });
    const xml = await (await hook(`/hooks/twilio/voice/dialdone/${a.numberId}`, { CallSid: 'CAin2', DialCallStatus: 'completed', DialCallDuration: '42' })).text();
    assert.ok(!xml.includes('<Record'));
    const c = (await pool.query("SELECT status, seconds FROM calls WHERE provider_id = 'CAin2'")).rows[0];
    assert.deepEqual(c, { status: 'completed', seconds: 42 });
  });

  await t.test('voicemail is stored once and listed only for its tenant', async () => {
    const path = `/hooks/twilio/voice/vmstatus/${a.numberId}`;
    const p = { CallSid: 'CAin1', RecordingSid: 'RE1', RecordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/AC/Recordings/RE1', RecordingDuration: '17' };
    assert.equal((await hook(path, p)).status, 204);
    assert.equal((await hook(path, p)).status, 204); // retry from Twilio
    assert.equal((await hook(path, { ...p, RecordingSid: 'RE2', RecordingDuration: '0' })).status, 204); // silence
    const mine = await (await A.call('GET', '/voicemails')).json();
    assert.equal(mine.voicemails.length, 1);
    assert.equal(mine.voicemails[0].peer, '+15551112222'); assert.equal(mine.voicemails[0].seconds, 17);
    assert.equal((await (await B.call('GET', '/voicemails')).json()).voicemails.length, 0);
    assert.equal((await B.call('GET', `/voicemails/${mine.voicemails[0].id}/audio`)).status, 404);
    assert.equal((await B.call('DELETE', `/voicemails/${mine.voicemails[0].id}`)).status, 200);
    assert.equal((await (await A.call('GET', '/voicemails')).json()).voicemails.length, 1, 'B must not delete A\'s voicemail');
  });

  await t.test('outbound browser call dials from the chosen number, only for that tenant\'s users', async () => {
    const path = '/hooks/twilio/voice/out';
    const ok = await (await hook(path, { CallSid: 'CAout1', From: `client:${identityFor(A.user.id)}`, numberId: a.numberId, To: '(555) 777-8888' })).text();
    assert.match(ok, /<Dial callerId="\+15550000001"/); assert.match(ok, /<Number>\+15557778888<\/Number>/);
    const cross = await (await hook(path, { CallSid: 'CAout2', From: `client:${identityFor(B.user.id)}`, numberId: a.numberId, To: '+15557778888' })).text();
    assert.match(cross, /<Reject\/>/);
    const bad = await (await hook(path, { CallSid: 'CAout3', From: `client:${identityFor(A.user.id)}`, numberId: a.numberId, To: 'abc' })).text();
    assert.match(bad, /not valid/);
    assert.ok(!(await pool.query("SELECT 1 FROM calls WHERE provider_id IN ('CAout2','CAout3')")).rowCount);
  });

  await t.test('inbound SMS is stored once, threads are isolated, unread counts clear on open', async () => {
    const path = `/hooks/twilio/sms/${a.numberId}`; const p = { MessageSid: 'SM1', From: '+15556667777', Body: 'Load still open?' };
    assert.equal((await hook(path, p)).status, 200);
    assert.equal((await hook(path, p)).status, 200);
    const th = await (await A.call('GET', '/threads')).json();
    assert.equal(th.threads.length, 1); assert.equal(th.threads[0].unread, 1);
    assert.equal((await (await B.call('GET', '/threads')).json()).threads.length, 0);
    assert.equal((await (await A.call('GET', '/summary')).json()).unreadMessages, 1);
    const open = await (await A.call('GET', `/thread?numberId=${a.numberId}&peer=${encodeURIComponent('+15556667777')}`)).json();
    assert.equal(open.messages[0].body, 'Load still open?');
    assert.equal((await (await A.call('GET', '/summary')).json()).unreadMessages, 0);
    const leak = await (await B.call('GET', `/thread?numberId=${a.numberId}&peer=${encodeURIComponent('+15556667777')}`)).json();
    assert.equal(leak.messages.length, 0);
  });

  await t.test('sending SMS: provider error is surfaced; other tenant cannot use the number', async () => {
    const real = global.fetch;
    global.fetch = (u, i) => (String(u).startsWith(base) ? real(u, i) : Promise.resolve(new Response(JSON.stringify({ message: 'invalid' }), { status: 400 })));
    try {
      const r = await A.call('POST', '/messages', { numberId: a.numberId, to: '+15556667777', body: 'yes' });
      assert.equal(r.status, 502); assert.match((await r.json()).error, /Twilio could not send/);
    } finally { global.fetch = real; }
    assert.equal((await B.call('POST', '/messages', { numberId: a.numberId, to: '+15556667777', body: 'hi' })).status, 404);
    assert.equal((await A.call('POST', '/messages', { numberId: a.numberId, to: '12', body: 'hi' })).status, 400);
  });

  await t.test('bird inbound webhook needs the per-connection key', async () => {
    const bn = await seedNumber(A.user.tenant_id, '+15550000003', 'bird');
    const body = JSON.stringify({ event: 'sms.inbound', payload: { id: 'bm1', sender: { contact: { identifierValue: '+15558889999' } }, body: { text: { text: 'from bird' } } } });
    const post = (k) => fetch(`${base}/hooks/bird/${bn.connId}?k=${k}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal((await post('wrong')).status, 403);
    assert.equal((await post('hookkey123')).status, 200);
    assert.equal((await post('hookkey123')).status, 200);
    const m = (await pool.query("SELECT body, tenant_id FROM messages WHERE provider_id = 'bm1'")).rows;
    assert.equal(m.length, 1); assert.equal(m[0].body, 'from bird'); assert.equal(m[0].tenant_id, A.user.tenant_id);
  });

  await t.test('tenant isolation on numbers, greetings and connections', async () => {
    assert.equal((await B.call('PATCH', `/numbers/${a.numberId}`, { label: 'pwned' })).status, 404);
    const gid = (await (await A.call('GET', '/greetings')).json()).greetings[0].id;
    assert.equal((await B.call('GET', `/greetings/${gid}/audio`)).status, 404);
    assert.equal((await B.call('PATCH', `/numbers/${b.numberId}`, { greeting_id: gid })).status, 400, 'cannot assign another tenant\'s greeting');
    await B.call('DELETE', `/greetings/${gid}`);
    assert.equal((await (await A.call('GET', '/greetings')).json()).greetings.length, 1);
    assert.equal((await B.call('GET', `/voice/token?numberId=${a.numberId}`)).status, 404);
    const mine = await (await A.call('GET', '/connections')).json();
    assert.ok(mine.connections.every((c) => !('creds_enc' in c) && !('hook_key' in c)), 'credentials never leave the server');
    assert.equal((await B.call('DELETE', `/connections/${a.connId}`)).status, 200);
    assert.equal((await pool.query('SELECT 1 FROM connections WHERE id = $1', [a.connId])).rowCount, 1, 'B cannot delete A\'s provider');
  });

  await t.test('voice token is minted for the caller\'s own identity', async () => {
    const res = await A.call('GET', `/voice/token?numberId=${a.numberId}`);
    assert.equal(res.status, 200);
    const r = await res.json();
    const grants = JSON.parse(Buffer.from(r.token.split('.')[1], 'base64url')).grants;
    assert.equal(grants.identity, identityFor(A.user.id));
    assert.equal(r.identity, identityFor(A.user.id));
    assert.match(grants.voice.outgoing.application_sid, /^AP/);
    // a half-configured connection gives a clear 400, not a crash
    const half = await seedNumber(A.user.tenant_id, '+15550000009', 'twilio', true);
    const bad = await A.call('GET', `/voice/token?numberId=${half.numberId}`);
    assert.equal(bad.status, 400); assert.match((await bad.json()).error, /connect again/);
  });

  await t.test('greeting upload rejects non-WAV; csrf header is enforced; members cannot manage', async () => {
    assert.equal((await A.call('POST', '/greetings?name=x', Buffer.from('ID3 not a wav'.repeat(200)), true)).status, 415);
    const noHeader = await fetch(base + '/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(noHeader.status, 403);
    const add = await A.call('POST', '/team', { name: 'Dee', email: 'dee@x.co', password: 'password123' });
    assert.equal(add.status, 200);
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'phone' }, body: JSON.stringify({ email: 'dee@x.co', password: 'password123' }) });
    const dee = login.headers.get('set-cookie').split(';')[0];
    const call = (method, path, data) => fetch(base + '/api' + path, { method, headers: { Cookie: dee, 'X-Requested-With': 'phone', 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
    assert.equal((await call('PATCH', `/numbers/${a.numberId}`, { label: 'x' })).status, 403);
    assert.equal((await call('POST', '/team', { email: 'z@x.co', password: 'password123' })).status, 403);
    assert.equal((await call('GET', '/numbers')).status, 200, 'members can still use the app');
  });

  await t.test('login is throttled after repeated failures', async () => {
    let last;
    for (let i = 0; i < 11; i++) {
      last = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'phone' }, body: JSON.stringify({ email: 'alpha@x.co', password: 'wrong-wrong' }) });
    }
    assert.equal(last.status, 429);
  });
});
