'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const C = require('../src/crypto');
const { toE164, esc, identityFor, userIdFromIdentity } = require('../src/util');
const twilio = require('../src/providers/twilio');
const bird = require('../src/providers/bird');

test('encrypt/decrypt round-trips and rejects tampering or wrong key', () => {
  const blob = C.encrypt({ a: 1, s: 'secret' }, 'k'.repeat(20));
  assert.deepEqual(C.decrypt(blob, 'k'.repeat(20)), { a: 1, s: 'secret' });
  assert.throws(() => C.decrypt(blob, 'x'.repeat(20)));
  const raw = Buffer.from(blob, 'base64'); raw[raw.length - 1] ^= 1;
  assert.throws(() => C.decrypt(raw.toString('base64'), 'k'.repeat(20)));
});

test('passwords hash, verify, and never collide on the same input', () => {
  const a = C.hashPassword('hunter2hunter2'); const b = C.hashPassword('hunter2hunter2');
  assert.notEqual(a, b);
  assert.ok(C.verifyPassword('hunter2hunter2', a));
  assert.ok(!C.verifyPassword('nope', a));
  assert.ok(!C.verifyPassword('x', 'garbage'));
});

test('session tokens verify, expire, and reject forgeries', () => {
  const S = 's'.repeat(20);
  const good = C.sign({ u: 1, exp: Math.floor(Date.now() / 1000) + 60 }, S);
  assert.equal(C.verify(good, S).u, 1);
  assert.equal(C.verify(good, 'z'.repeat(20)), null);
  assert.equal(C.verify(C.sign({ u: 1, exp: 1 }, S), S), null);
  const [body, mac] = good.split('.');
  const forged = Buffer.from(JSON.stringify({ u: 2, exp: 9e9 })).toString('base64url');
  assert.equal(C.verify(`${forged}.${mac}`, S), null);
  assert.equal(C.verify(`${body}.`, S), null);
  assert.equal(C.verify(undefined, S), null);
});

test('toE164 handles US-first input and rejects junk', () => {
  assert.equal(toE164('(555) 123-4567'), '+15551234567');
  assert.equal(toE164('1 555 123 4567'), '+15551234567');
  assert.equal(toE164('+44 20 7946 0958'), '+442079460958');
  assert.equal(toE164('12345'), null);
  assert.equal(toE164(''), null);
  assert.equal(toE164(null), null);
  assert.equal(toE164('+123'), null);
});

test('client identity round-trips and rejects other shapes', () => {
  const id = '91b9360a-29fb-4efe-b0d5-44c9d42dcba1';
  assert.equal(identityFor(id), 'u_91b9360a29fb4efeb0d544c9d42dcba1');
  assert.equal(userIdFromIdentity(`client:${identityFor(id)}`), id);
  assert.equal(userIdFromIdentity('client:evil'), null);
  assert.equal(userIdFromIdentity(undefined), null);
});

test('xml escaping covers injection characters', () => {
  assert.equal(esc(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;');
});

test('twilio signature matches the documented algorithm', () => {
  const token = 'tok'; const url = 'https://x.test/hooks/a?b=1'; const params = { To: '+1', From: '+2', CallSid: 'CA1' };
  const data = url + 'CallSidCA1From+2To+1';
  const sig = crypto.createHmac('sha1', token).update(data).digest('base64');
  assert.ok(twilio.validateSignature(token, url, params, sig));
  assert.ok(!twilio.validateSignature(token, url, { ...params, To: '+9' }, sig));
  assert.ok(!twilio.validateSignature('other', url, params, sig));
  assert.ok(!twilio.validateSignature(token, url, params, undefined));
});

test('twilio access token is a valid HS256 JWT with a voice grant', () => {
  const t = twilio.accessToken({ accountSid: 'ACx', apiKeySid: 'SKx', apiKeySecret: 'shh', appSid: 'APx' }, 'u_abc', 600);
  const [h, b, s] = t.split('.');
  assert.equal(JSON.parse(Buffer.from(h, 'base64url')).alg, 'HS256');
  const body = JSON.parse(Buffer.from(b, 'base64url'));
  assert.equal(body.iss, 'SKx'); assert.equal(body.sub, 'ACx');
  assert.equal(body.grants.identity, 'u_abc');
  assert.equal(body.grants.voice.outgoing.application_sid, 'APx');
  assert.equal(body.grants.voice.incoming.allow, true);
  assert.ok(body.exp - body.iat === 600);
  assert.equal(s, crypto.createHmac('sha256', 'shh').update(`${h}.${b}`).digest('base64url'));
});

test('recording proxy refuses non-twilio hosts (no SSRF)', async () => {
  await assert.rejects(() => twilio.fetchRecording({ accountSid: 'a', authToken: 'b' }, 'http://169.254.169.254/latest'), /unexpected recording host/);
});

test('bird inbound parser extracts SMS and ignores everything else', () => {
  const ok = { event: 'sms.inbound', payload: { id: 'm1', sender: { contact: { identifierValue: '+15551230000' } }, body: { type: 'text', text: { text: 'hi' } } } };
  assert.deepEqual(bird.parseInbound(ok), { from: '+15551230000', body: 'hi', id: 'm1' });
  assert.equal(bird.parseInbound({ event: 'sms.outbound', payload: ok.payload }), null);
  assert.equal(bird.parseInbound({ event: 'sms.inbound', payload: { body: { text: { text: 'x' } } } }), null);
  assert.equal(bird.parseInbound(null), null);
});

test('bird send posts the documented request shape', async () => {
  const real = global.fetch; let seen;
  global.fetch = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ id: 'abc', status: 'accepted' }), { status: 202 }); };
  try {
    const r = await bird.sendSms({ accessKey: 'K', workspaceId: 'W', channelId: 'C' }, '+15551230000', 'hello');
    assert.equal(seen.url, 'https://api.bird.com/workspaces/W/channels/C/messages');
    assert.equal(seen.init.headers.Authorization, 'AccessKey K');
    const body = JSON.parse(seen.init.body);
    assert.equal(body.receiver.contacts[0].identifierValue, '+15551230000');
    assert.equal(body.body.text.text, 'hello');
    assert.equal(r.id, 'abc');
  } finally { global.fetch = real; }
});
