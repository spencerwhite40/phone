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
    const body = await r.json();
    return { user: body.user, call: caller(r.headers.get('set-cookie').split(';')[0]) };
  };
  // A caller keeps its cookie, and follows a business switch (the server rotates it).
  const caller = (initial) => {
    let cookie = initial;
    return async (method, path, data, raw) => {
      const res = await fetch(base + '/api' + path, {
        method, headers: { Cookie: cookie, 'X-Requested-With': 'phone', ...(data && !raw ? { 'Content-Type': 'application/json' } : {}) },
        body: raw ? data : data ? JSON.stringify(data) : undefined,
      });
      if (path === '/switch' && res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
      return res;
    };
  };
  const loginAs = async (email, password) => {
    const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'phone' }, body: JSON.stringify({ email, password }) });
    assert.equal(r.status, 200);
    return { me: await r.json(), call: caller(r.headers.get('set-cookie').split(';')[0]) };
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

  await t.test('greeting upload rejects non-WAV; csrf header is enforced', async () => {
    assert.equal((await A.call('POST', '/greetings?name=x', Buffer.from('ID3 not a wav'.repeat(200)), true)).status, 415);
    const noHeader = await fetch(base + '/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(noHeader.status, 403);
  });

  const wavBuf = () => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(2000)]);
  const a2 = await seedNumber(A.user.tenant_id, '+15550000011');
  let dee; let deeId;

  await t.test('the operator is the first account; later signups are ordinary owners', async () => {
    assert.equal(A.user.is_platform_admin, true);
    assert.equal(B.user.is_platform_admin, false);
    assert.equal((await B.call('POST', '/businesses', { name: 'Nope' })).status, 403);
    assert.equal((await B.call('GET', '/admin/numbers')).status, 403);
  });

  await t.test('members see and use only the numbers assigned to them', async () => {
    const add = await A.call('POST', '/team', { name: 'Dee', email: 'dee@x.co', password: 'password123' });
    assert.equal(add.status, 200); deeId = (await add.json()).id;
    dee = await loginAs('dee@x.co', 'password123');
    assert.equal((await (await dee.call('GET', '/numbers')).json()).numbers.length, 0, 'unassigned member sees nothing');
    assert.equal((await dee.call('GET', '/team')).status, 403);

    assert.equal((await A.call('PATCH', `/team/${deeId}`, { numberIds: [a.numberId] })).status, 200);
    const mine = (await (await dee.call('GET', '/numbers')).json()).numbers;
    assert.deepEqual(mine.map((n) => n.id), [a.numberId]);
    assert.deepEqual(mine[0].people.map((p) => p.id), [deeId]);

    // activity on the other number is invisible and unusable
    await pool.query("INSERT INTO messages (tenant_id, number_id, direction, peer, body, read) VALUES ($1,$2,'in','+15551119999','secret',false)", [A.user.tenant_id, a2.numberId]);
    await pool.query("INSERT INTO voicemails (tenant_id, number_id, peer, recording_url, seconds, provider_id) VALUES ($1,$2,'+15551119999','https://api.twilio.com/x',5,'RE-a2')", [A.user.tenant_id, a2.numberId]);
    const th = (await (await dee.call('GET', '/threads')).json()).threads;
    assert.ok(th.every((x) => x.number_id === a.numberId));
    assert.ok((await (await dee.call('GET', '/voicemails')).json()).voicemails.every((v) => v.number_id === a.numberId));
    assert.equal((await (await dee.call('GET', `/thread?numberId=${a2.numberId}&peer=${encodeURIComponent('+15551119999')}`)).json()).messages.length, 0);
    assert.equal((await dee.call('POST', '/messages', { numberId: a2.numberId, to: '+15551119999', body: 'x' })).status, 404);
    assert.equal((await dee.call('GET', `/voice/token?numberId=${a2.numberId}`)).status, 404);
    const sum = await (await dee.call('GET', '/summary')).json();
    const all = await (await A.call('GET', '/summary')).json();
    assert.ok(all.unreadMessages > sum.unreadMessages, 'badges are scoped too');
  });

  await t.test('a member can set voicemail greetings for their number, but nothing else', async () => {
    assert.equal((await dee.call('PATCH', `/numbers/${a.numberId}`, { label: 'x' })).status, 403);
    assert.equal((await dee.call('PATCH', `/numbers/${a.numberId}`, { forward_to: '+15550001234' })).status, 403);
    assert.equal((await dee.call('PATCH', `/numbers/${a2.numberId}`, { greeting_id: null })).status, 404);
    const up = await dee.call('POST', `/greetings?name=Dee%20greeting&seconds=9&numberId=${a.numberId}`, wavBuf(), true);
    assert.equal(up.status, 200);
    const gid = (await up.json()).greeting.id;
    const n = (await (await dee.call('GET', '/numbers')).json()).numbers[0];
    assert.equal(n.greeting_id, gid, 'uploaded greeting becomes active for that number');
    assert.equal((await dee.call('POST', `/greetings?name=x&numberId=${a2.numberId}`, wavBuf(), true)).status, 404);
    assert.equal((await dee.call('POST', '/greetings?name=x', wavBuf(), true)).status, 403, 'no business-wide library for members');
    const xml = await (await hook(`/hooks/twilio/voice/dialdone/${a.numberId}`, { CallSid: 'CAg1', DialCallStatus: 'no-answer' })).text();
    assert.match(xml, new RegExp(`/greeting/${gid}\\.wav`));
    const ownerGreeting = (await (await A.call('GET', '/greetings')).json()).greetings.find((g) => g.name === 'Hours');
    assert.equal((await dee.call('DELETE', `/greetings/${ownerGreeting.id}`)).status, 403, "can't delete someone else's greeting");
    assert.equal((await dee.call('DELETE', `/greetings/${gid}`)).status, 200);
  });

  await t.test('inbound calls ring only the people assigned, in order when set to sequence', async () => {
    await pool.query('UPDATE numbers SET forward_to = NULL WHERE id = $1', [a2.numberId]);
    // nobody assigned -> owners/admins, so a call is never dropped
    let xml = await (await hook(`/hooks/twilio/voice/in/${a2.numberId}`, { CallSid: 'CAr0', From: '+15552220000' })).text();
    assert.match(xml, new RegExp(identityFor(A.user.id)));
    assert.ok(!xml.includes(identityFor(deeId)));

    assert.equal((await A.call('PATCH', `/numbers/${a2.numberId}`, { people: [deeId, A.user.id], ring_mode: 'sequence' })).status, 200);
    xml = await (await hook(`/hooks/twilio/voice/in/${a2.numberId}`, { CallSid: 'CAr1', From: '+15552220000' })).text();
    assert.ok(xml.includes(identityFor(deeId)) && !xml.includes(identityFor(A.user.id)), 'first target only');
    xml = await (await hook(`/hooks/twilio/voice/dialdone/${a2.numberId}?step=1`, { CallSid: 'CAr1', DialCallStatus: 'no-answer' })).text();
    assert.ok(xml.includes(identityFor(A.user.id)) && !xml.includes(identityFor(deeId)), 'second target next');
    assert.match(xml, /dialdone\/[0-9a-f-]+\?step=2/);
    xml = await (await hook(`/hooks/twilio/voice/dialdone/${a2.numberId}?step=2`, { CallSid: 'CAr1', DialCallStatus: 'no-answer' })).text();
    assert.match(xml, /<Record /, 'everyone tried -> voicemail');

    assert.equal((await A.call('PATCH', `/numbers/${a2.numberId}`, { ring_mode: 'all' })).status, 200);
    xml = await (await hook(`/hooks/twilio/voice/in/${a2.numberId}`, { CallSid: 'CAr2', From: '+15552220000' })).text();
    assert.ok(xml.includes(identityFor(deeId)) && xml.includes(identityFor(A.user.id)), 'all at once');
    assert.equal((await A.call('PATCH', `/numbers/${a2.numberId}`, { ring_mode: 'bogus' })).status, 400);
  });

  await t.test('outbound calls need access to that specific number', async () => {
    const out = (uid, numberId) => hook('/hooks/twilio/voice/out', { CallSid: `CAo${Math.random()}`, From: `client:${identityFor(uid)}`, numberId, To: '+15557778888' }).then((r) => r.text());
    assert.match(await out(deeId, a.numberId), /<Dial /);
    assert.match(await out(deeId, a2.numberId), /<Dial /, 'Dee is assigned to a2 too by now');
    await A.call('PATCH', `/numbers/${a2.numberId}`, { people: [A.user.id] });
    assert.match(await out(deeId, a2.numberId), /<Reject\/>/, 'no longer assigned');
  });

  await t.test('operator creates businesses, switches into them and moves numbers', async () => {
    const created = await (await A.call('POST', '/businesses', { name: 'Gamma Logistics' })).json();
    const gamma = created.business.id;
    assert.equal((await B.call('POST', '/switch', { tenantId: gamma })).status, 403, 'another owner cannot enter Gamma');
    const sw = await A.call('POST', '/switch', { tenantId: gamma });
    assert.equal(sw.status, 200); assert.equal((await sw.json()).company, 'Gamma Logistics');
    assert.equal((await (await A.call('GET', '/numbers')).json()).numbers.length, 0, 'fresh business is empty');

    assert.equal((await A.call('POST', `/numbers/${a2.numberId}/move`, { tenantId: gamma })).status, 200);
    const moved = (await (await A.call('GET', '/numbers')).json()).numbers;
    assert.deepEqual(moved.map((n) => n.id), [a2.numberId]);
    assert.equal(moved[0].people.length, 0, 'assignments reset on move');
    const th = (await (await A.call('GET', '/threads')).json()).threads;
    assert.ok(th.some((x) => x.number_id === a2.numberId), 'history moves with the number');
    assert.equal((await dee.call('GET', '/numbers').then((r) => r.json())).numbers.every((n) => n.id !== a2.numberId), true);

    const all = (await (await A.call('GET', '/admin/numbers')).json()).numbers;
    assert.ok(all.find((n) => n.id === a2.numberId).business === 'Gamma Logistics');
    assert.equal((await A.call('DELETE', `/businesses/${gamma}`)).status, 400, 'cannot delete the business you are standing in');

    // add an existing person (Dee) to Gamma by email: no password needed, she keeps one login
    const again = await (await A.call('POST', '/team', { email: 'dee@x.co', numberIds: [a2.numberId] })).json();
    assert.equal(again.existed, true);
    const me = await (await dee.call('GET', '/me')).json();
    assert.equal(me.businesses.length, 2);
    const inGamma = await dee.call('POST', '/switch', { tenantId: gamma });
    assert.equal((await inGamma.json()).user.role, 'member');
    assert.deepEqual((await (await dee.call('GET', '/numbers')).json()).numbers.map((n) => n.id), [a2.numberId]);
    assert.equal((await dee.call('POST', '/switch', { tenantId: B.user.tenant_id })).status, 403);

    // removing her from Gamma keeps her login and her other business
    assert.equal((await A.call('DELETE', `/team/${deeId}`)).status, 200);
    assert.equal((await pool.query('SELECT 1 FROM users WHERE id = $1', [deeId])).rowCount, 1);
    assert.equal((await dee.call('GET', '/numbers')).status, 401, 'her session inside Gamma stops at once');
    assert.equal((await (await loginAs('dee@x.co', 'password123')).call('GET', '/me').then((r) => r.json())).businesses.length, 1);

    // businesses with numbers cannot be deleted; empty ones can
    assert.equal((await A.call('POST', '/switch', { tenantId: A.user.tenant_id })).status, 200);
    assert.equal((await A.call('DELETE', `/businesses/${gamma}`)).status, 409);
    assert.equal((await A.call('POST', `/numbers/${a2.numberId}/move`, { tenantId: A.user.tenant_id })).status, 200);
    assert.equal((await A.call('DELETE', `/businesses/${gamma}`)).status, 200);
  });

  await t.test('people: roles, last-owner protection, password change, full removal', async () => {
    assert.equal((await A.call('DELETE', `/team/${A.user.id}`)).status, 400, 'cannot remove yourself');
    const adminAdd = await A.call('POST', '/team', { name: 'Ann', email: 'ann@x.co', password: 'password123', role: 'admin' });
    const annId = (await adminAdd.json()).id;
    const ann = await loginAs('ann@x.co', 'password123');
    assert.equal(ann.me.user.role, 'admin');
    assert.equal((await ann.call('GET', '/team')).status, 200);
    assert.equal((await ann.call('POST', '/team', { email: 'zed@x.co', password: 'password123', role: 'admin' })).status, 403, 'admins cannot mint admins');
    assert.equal((await ann.call('PATCH', `/team/${deeId}`, { role: 'admin' })).status, 403, 'only the owner changes roles');
    assert.equal((await A.call('PATCH', `/team/${A.user.id}`, { role: 'member' })).status, 400);

    assert.equal((await ann.call('POST', '/password', { current: 'wrong', next: 'newpassword1' })).status, 400);
    assert.equal((await ann.call('POST', '/password', { current: 'password123', next: 'newpassword1' })).status, 200);
    await loginAs('ann@x.co', 'newpassword1');

    assert.equal((await A.call('DELETE', `/team/${annId}`)).status, 200);
    assert.equal((await pool.query('SELECT 1 FROM users WHERE id = $1', [annId])).rowCount, 0, 'no business left -> account removed');
    assert.equal((await ann.call('GET', '/numbers')).status, 401, 'their session stops working immediately');
  });

  await t.test('login is throttled after repeated failures', async () => {
    let last;
    for (let i = 0; i < 11; i++) {
      last = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'phone' }, body: JSON.stringify({ email: 'alpha@x.co', password: 'wrong-wrong' }) });
    }
    assert.equal(last.status, 429);
  });
});
