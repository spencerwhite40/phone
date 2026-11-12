'use strict';
const crypto = require('node:crypto');
const express = require('express');
const C = require('./crypto');
const twilio = require('./providers/twilio');
const bird = require('./providers/bird');
const { toE164, identityFor } = require('./util');

const httpErr = (status, message) => Object.assign(new Error(message), { status });
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mountApi(app, ctx) {
  const { pool } = ctx;
  const q = (text, params) => pool.query(text, params);
  const json = express.json({ limit: '100kb' });
  const requireUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Sign in required' }));
  const requireOwner = (req, res, next) => (req.user?.role === 'owner' ? next() : res.status(403).json({ error: 'Owner only' }));
  const id = (req) => { if (!UUID.test(req.params.id)) throw httpErr(404, 'Not found'); return req.params.id; };

  // ---- auth ------------------------------------------------------------
  const attempts = new Map();
  const throttled = (key) => {
    const now = Date.now();
    const rec = (attempts.get(key) || []).filter((t) => now - t < 15 * 60 * 1000);
    attempts.set(key, rec);
    return rec.length >= 10;
  };
  const fail = (key) => attempts.get(key).push(Date.now());

  app.post('/api/signup', json, h(async (req, res) => {
    const { company, name, email, password, code } = req.body || {};
    if (ctx.env.SIGNUP_CODE && !C.safeEqual(code || '', ctx.env.SIGNUP_CODE)) throw httpErr(403, 'Invalid signup code');
    if (!company?.trim() || !/^\S+@\S+\.\S+$/.test(email || '') || (password || '').length < 8) {
      throw httpErr(400, 'Company, a valid email, and a password of 8+ characters are required');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const t = await client.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id', [company.trim()]);
      const u = await client.query(
        "INSERT INTO users (tenant_id, email, name, pass_hash, role) VALUES ($1,$2,$3,$4,'owner') RETURNING id, tenant_id, email, name, role",
        [t.rows[0].id, email.trim().toLowerCase(), (name || '').trim(), C.hashPassword(password)],
      );
      await client.query('COMMIT');
      ctx.setSession(res, u.rows[0]);
      res.json({ user: u.rows[0], company: company.trim() });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (e.code === '23505') throw httpErr(409, 'That email is already registered');
      throw e;
    } finally { client.release(); }
  }));

  app.post('/api/login', json, h(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const key = `${req.ip}|${email}`;
    if (throttled(key)) throw httpErr(429, 'Too many attempts. Try again in a few minutes.');
    const { rows } = await q('SELECT u.*, t.name AS company FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.email = $1', [email]);
    const u = rows[0];
    if (!u || !C.verifyPassword(String(req.body?.password || ''), u.pass_hash)) { fail(key); throw httpErr(401, 'Wrong email or password'); }
    ctx.setSession(res, u);
    res.json({ user: { id: u.id, tenant_id: u.tenant_id, email: u.email, name: u.name, role: u.role }, company: u.company });
  }));

  app.post('/api/logout', (req, res) => { ctx.clearSession(res); res.json({ ok: true }); });

  app.get('/api/me', h(async (req, res) => {
    if (!req.user) return res.json({ user: null });
    const t = await q('SELECT name FROM tenants WHERE id = $1', [req.user.tenant_id]);
    res.json({ user: req.user, company: t.rows[0]?.name, needsPublicUrl: !ctx.publicUrl, identity: identityFor(req.user.id) });
  }));

  // Everything below needs a signed-in user.
  app.use('/api', (req, res, next) => (['/signup', '/login', '/logout', '/me'].includes(req.path) ? next() : requireUser(req, res, next)));

  // ---- team ------------------------------------------------------------
  app.get('/api/team', h(async (req, res) => {
    const { rows } = await q('SELECT id, email, name, role, created_at FROM users WHERE tenant_id = $1 ORDER BY created_at', [req.user.tenant_id]);
    res.json({ users: rows });
  }));
  app.post('/api/team', requireOwner, json, h(async (req, res) => {
    const { name, email, password } = req.body || {};
    if (!/^\S+@\S+\.\S+$/.test(email || '') || (password || '').length < 8) throw httpErr(400, 'Valid email and an 8+ character password required');
    try {
      const { rows } = await q(
        "INSERT INTO users (tenant_id, email, name, pass_hash, role) VALUES ($1,$2,$3,$4,'member') RETURNING id, email, name, role",
        [req.user.tenant_id, email.trim().toLowerCase(), (name || '').trim(), C.hashPassword(password)],
      );
      res.json({ user: rows[0] });
    } catch (e) { if (e.code === '23505') throw httpErr(409, 'That email is already registered'); throw e; }
  }));
  app.delete('/api/team/:id', requireOwner, h(async (req, res) => {
    if (id(req) === req.user.id) throw httpErr(400, "You can't remove yourself");
    await q('DELETE FROM users WHERE id = $1 AND tenant_id = $2', [req.params.id, req.user.tenant_id]);
    res.json({ ok: true });
  }));

  // ---- connections (Twilio / Bird accounts) ------------------------------
  const credsOf = (row) => C.decrypt(row.creds_enc, ctx.secret);
  const publicOr400 = () => { if (!ctx.publicUrl) throw httpErr(400, 'PUBLIC_URL is not set on the server, so webhooks cannot be wired.'); };

  app.get('/api/connections', h(async (req, res) => {
    const { rows } = await q(
      `SELECT c.id, c.provider, c.label, c.hook_key, c.created_at,
              (SELECT count(*)::int FROM numbers n WHERE n.connection_id = c.id) AS numbers
         FROM connections c WHERE c.tenant_id = $1 ORDER BY c.created_at`, [req.user.tenant_id]);
    res.json({
      connections: rows.map(({ hook_key, ...c }) => ({
        ...c,
        webhookUrl: c.provider === 'bird' ? `${ctx.publicUrl}/hooks/bird/${c.id}?k=${hook_key}` : undefined,
      })),
    });
  }));

  async function addNumbers(tenantId, connId, list) {
    const added = []; const skipped = [];
    for (const n of list) {
      const r = await q(
        `INSERT INTO numbers (tenant_id, connection_id, e164, label, provider_ref)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (e164) DO NOTHING RETURNING id, e164, provider_ref`,
        [tenantId, connId, n.e164, n.label || n.e164, n.ref || null]);
      (r.rows[0] ? added : skipped).push(r.rows[0] || n.e164);
    }
    return { added, skipped };
  }

  app.post('/api/connections/twilio', requireOwner, json, h(async (req, res) => {
    publicOr400();
    const { label, accountSid, authToken } = req.body || {};
    if (!/^AC[0-9a-f]{32}$/i.test(accountSid || '') || !authToken) throw httpErr(400, 'Account SID (starts with AC) and Auth Token are required');
    let link;
    try { link = await twilio.connect({ accountSid: accountSid.trim(), authToken: authToken.trim() }, ctx.publicUrl); }
    catch (e) { throw httpErr(400, `Twilio said: ${e.message}`); }
    const conn = await q(
      'INSERT INTO connections (tenant_id, provider, label, creds_enc, hook_key) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [req.user.tenant_id, 'twilio', (label || link.accountName).trim(), C.encrypt(link.creds, ctx.secret), crypto.randomBytes(18).toString('base64url')]);
    const { added, skipped } = await addNumbers(req.user.tenant_id, conn.rows[0].id, link.numbers);
    const warnings = [];
    for (const n of added) {
      try { await twilio.configureNumber(link.creds, n.provider_ref, n.id, ctx.publicUrl); }
      catch (e) { warnings.push(`${n.e164}: ${e.message}`); }
    }
    res.json({ id: conn.rows[0].id, added: added.map((n) => n.e164), skipped, warnings });
  }));

  app.post('/api/connections/:id/resync', requireOwner, h(async (req, res) => {
    publicOr400();
    const { rows } = await q("SELECT * FROM connections WHERE id = $1 AND tenant_id = $2 AND provider = 'twilio'", [id(req), req.user.tenant_id]);
    if (!rows[0]) throw httpErr(404, 'Not found');
    const creds = credsOf(rows[0]);
    const { added, skipped } = await addNumbers(req.user.tenant_id, rows[0].id, await twilio.listNumbers(creds));
    const warnings = [];
    const all = await q('SELECT id, e164, provider_ref FROM numbers WHERE connection_id = $1', [rows[0].id]);
    for (const n of all.rows) {
      try { await twilio.configureNumber(creds, n.provider_ref, n.id, ctx.publicUrl); } catch (e) { warnings.push(`${n.e164}: ${e.message}`); }
    }
    res.json({ added: added.map((n) => n.e164), skipped, warnings });
  }));

  app.post('/api/connections/bird', requireOwner, json, h(async (req, res) => {
    publicOr400();
    const { label, accessKey, workspaceId, channelId, number } = req.body || {};
    const e164 = toE164(number);
    if (!accessKey || !UUID.test(workspaceId || '') || !UUID.test(channelId || '') || !e164) {
      throw httpErr(400, 'Access key, workspace ID, channel ID (both UUIDs) and the number are required');
    }
    const creds = { accessKey: accessKey.trim(), workspaceId, channelId };
    await bird.verify(creds);
    const hookKey = crypto.randomBytes(18).toString('base64url');
    const conn = await q(
      'INSERT INTO connections (tenant_id, provider, label, creds_enc, hook_key) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [req.user.tenant_id, 'bird', (label || 'Bird').trim(), C.encrypt(creds, ctx.secret), hookKey]);
    const { added, skipped } = await addNumbers(req.user.tenant_id, conn.rows[0].id, [{ e164, label: label || e164 }]);
    if (!added.length) {
      await q('DELETE FROM connections WHERE id = $1', [conn.rows[0].id]);
      throw httpErr(409, `${e164} is already registered`);
    }
    res.json({ id: conn.rows[0].id, added: added.map((n) => n.e164), skipped, webhookUrl: `${ctx.publicUrl}/hooks/bird/${conn.rows[0].id}?k=${hookKey}` });
  }));

  app.delete('/api/connections/:id', requireOwner, h(async (req, res) => {
    await q('DELETE FROM connections WHERE id = $1 AND tenant_id = $2', [id(req), req.user.tenant_id]);
    res.json({ ok: true });
  }));

  // ---- numbers ---------------------------------------------------------
  app.get('/api/numbers', h(async (req, res) => {
    const { rows } = await q(
      `SELECT n.id, n.connection_id, n.e164, n.label, n.greeting_id, n.forward_to, n.ring_seconds, c.provider, c.label AS connection
         FROM numbers n JOIN connections c ON c.id = n.connection_id
        WHERE n.tenant_id = $1 ORDER BY n.created_at`, [req.user.tenant_id]);
    res.json({ numbers: rows.map((n) => ({ ...n, canCall: n.provider === 'twilio', canText: true })) });
  }));

  app.patch('/api/numbers/:id', requireOwner, json, h(async (req, res) => {
    const b = req.body || {}; const sets = []; const vals = [id(req), req.user.tenant_id];
    const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if ('label' in b) add('label', String(b.label || '').trim().slice(0, 60));
    if ('forward_to' in b) {
      const f = b.forward_to ? toE164(b.forward_to) : null;
      if (b.forward_to && !f) throw httpErr(400, 'Forwarding number is not valid');
      add('forward_to', f);
    }
    if ('ring_seconds' in b) add('ring_seconds', Math.min(60, Math.max(5, parseInt(b.ring_seconds, 10) || 20)));
    if ('greeting_id' in b) {
      if (b.greeting_id) {
        const g = await q('SELECT 1 FROM greetings WHERE id = $1 AND tenant_id = $2', [b.greeting_id, req.user.tenant_id]);
        if (!g.rows[0]) throw httpErr(400, 'Unknown greeting');
      }
      add('greeting_id', b.greeting_id || null);
    }
    if (!sets.length) throw httpErr(400, 'Nothing to update');
    const { rows } = await q(`UPDATE numbers SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING id`, vals);
    if (!rows[0]) throw httpErr(404, 'Not found');
    res.json({ ok: true });
  }));

  // ---- browser calling token ---------------------------------------------
  app.get('/api/voice/token', h(async (req, res) => {
    const numberId = String(req.query.numberId || '');
    if (!UUID.test(numberId)) throw httpErr(400, 'numberId required');
    const { rows } = await q(
      `SELECT c.* FROM numbers n JOIN connections c ON c.id = n.connection_id
        WHERE n.id = $1 AND n.tenant_id = $2 AND c.provider = 'twilio'`, [numberId, req.user.tenant_id]);
    if (!rows[0]) throw httpErr(404, 'That number cannot place calls');
    const identity = identityFor(req.user.id);
    const creds = credsOf(rows[0]);
    if (!creds.apiKeySid || !creds.apiKeySecret || !creds.appSid) throw httpErr(400, 'This Twilio connection is incomplete. Remove it and connect again.');
    res.json({ token: twilio.accessToken(creds, identity, 3600), identity, connectionId: rows[0].id, ttl: 3600 });
  }));

  // ---- greetings -------------------------------------------------------
  app.get('/api/greetings', h(async (req, res) => {
    const { rows } = await q(
      `SELECT g.id, g.name, g.seconds, g.created_at,
              (SELECT count(*)::int FROM numbers n WHERE n.greeting_id = g.id) AS used_by
         FROM greetings g WHERE g.tenant_id = $1 ORDER BY g.created_at DESC`, [req.user.tenant_id]);
    res.json({ greetings: rows });
  }));

  // Browser sends a WAV (it converts whatever was recorded/uploaded). Validate the header.
  app.post('/api/greetings', requireOwner, express.raw({ type: () => true, limit: '8mb' }), h(async (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 1000 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
      throw httpErr(415, 'Greeting must be a WAV file (the app converts recordings for you)');
    }
    const name = String(req.query.name || 'Greeting').trim().slice(0, 60) || 'Greeting';
    const seconds = Math.min(600, Math.max(0, parseInt(req.query.seconds, 10) || 0));
    const { rows } = await q(
      'INSERT INTO greetings (tenant_id, name, seconds, data) VALUES ($1,$2,$3,$4) RETURNING id, name, seconds',
      [req.user.tenant_id, name, seconds, buf]);
    res.json({ greeting: rows[0] });
  }));

  app.get('/api/greetings/:id/audio', h(async (req, res) => {
    const { rows } = await q('SELECT data, mime FROM greetings WHERE id = $1 AND tenant_id = $2', [id(req), req.user.tenant_id]);
    if (!rows[0]) throw httpErr(404, 'Not found');
    res.type(rows[0].mime).send(rows[0].data);
  }));

  app.delete('/api/greetings/:id', requireOwner, h(async (req, res) => {
    await q('DELETE FROM greetings WHERE id = $1 AND tenant_id = $2', [id(req), req.user.tenant_id]);
    res.json({ ok: true });
  }));

  // ---- messages --------------------------------------------------------
  app.get('/api/threads', h(async (req, res) => {
    const { rows } = await q(
      `SELECT DISTINCT ON (m.number_id, m.peer)
              m.number_id, m.peer, m.body, m.direction, m.created_at,
              (SELECT count(*)::int FROM messages u WHERE u.number_id = m.number_id AND u.peer = m.peer AND u.direction = 'in' AND NOT u.read) AS unread
         FROM messages m WHERE m.tenant_id = $1
        ORDER BY m.number_id, m.peer, m.created_at DESC`, [req.user.tenant_id]);
    rows.sort((a, b) => b.created_at - a.created_at);
    res.json({ threads: rows });
  }));

  app.get('/api/thread', h(async (req, res) => {
    const numberId = String(req.query.numberId || ''); const peer = toE164(req.query.peer);
    if (!UUID.test(numberId) || !peer) throw httpErr(400, 'numberId and peer required');
    await q("UPDATE messages SET read = true WHERE tenant_id = $1 AND number_id = $2 AND peer = $3 AND direction = 'in' AND NOT read", [req.user.tenant_id, numberId, peer]);
    const { rows } = await q(
      'SELECT id, direction, body, status, created_at FROM messages WHERE tenant_id = $1 AND number_id = $2 AND peer = $3 ORDER BY created_at ASC LIMIT 500',
      [req.user.tenant_id, numberId, peer]);
    res.json({ messages: rows });
  }));

  app.post('/api/messages', json, h(async (req, res) => {
    const { numberId, to, body } = req.body || {};
    const peer = toE164(to);
    if (!UUID.test(numberId || '') || !peer || !String(body || '').trim()) throw httpErr(400, 'Number, a valid recipient and a message are required');
    if (String(body).length > 1600) throw httpErr(400, 'Message is too long (1600 characters max)');
    const { rows } = await q(
      `SELECT n.id, n.e164, c.provider, c.creds_enc FROM numbers n JOIN connections c ON c.id = n.connection_id
        WHERE n.id = $1 AND n.tenant_id = $2`, [numberId, req.user.tenant_id]);
    const n = rows[0];
    if (!n) throw httpErr(404, 'Number not found');
    const creds = credsOf(n);
    let sent;
    try {
      sent = n.provider === 'twilio'
        ? await twilio.sendSms(creds, n.e164, peer, body)
        : await bird.sendSms(creds, peer, body);
    } catch (e) { throw httpErr(502, `${n.provider === 'twilio' ? 'Twilio' : 'Bird'} could not send: ${e.message}`); }
    const ins = await q(
      `INSERT INTO messages (tenant_id, number_id, direction, peer, body, status, provider_id, read)
       VALUES ($1,$2,'out',$3,$4,$5,$6,true) RETURNING id, direction, body, status, created_at`,
      [req.user.tenant_id, n.id, peer, body, sent.status, sent.id]);
    res.json({ message: ins.rows[0] });
  }));

  // ---- calls + voicemail -------------------------------------------------
  app.get('/api/calls', h(async (req, res) => {
    const { rows } = await q(
      'SELECT id, number_id, direction, peer, status, seconds, created_at FROM calls WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100',
      [req.user.tenant_id]);
    res.json({ calls: rows });
  }));

  app.get('/api/voicemails', h(async (req, res) => {
    const { rows } = await q(
      'SELECT id, number_id, peer, seconds, listened, created_at FROM voicemails WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100',
      [req.user.tenant_id]);
    res.json({ voicemails: rows });
  }));

  app.get('/api/voicemails/:id/audio', h(async (req, res) => {
    const { rows } = await q(
      `SELECT v.recording_url, c.creds_enc FROM voicemails v
         JOIN numbers n ON n.id = v.number_id JOIN connections c ON c.id = n.connection_id
        WHERE v.id = $1 AND v.tenant_id = $2`, [id(req), req.user.tenant_id]);
    if (!rows[0]) throw httpErr(404, 'Not found');
    const upstream = await twilio.fetchRecording(credsOf(rows[0]), rows[0].recording_url);
    if (!upstream.ok) throw httpErr(502, 'Recording is not available yet');
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(Buffer.from(await upstream.arrayBuffer()));
  }));

  app.post('/api/voicemails/:id/listened', h(async (req, res) => {
    await q('UPDATE voicemails SET listened = true WHERE id = $1 AND tenant_id = $2', [id(req), req.user.tenant_id]);
    res.json({ ok: true });
  }));

  app.delete('/api/voicemails/:id', h(async (req, res) => {
    await q('DELETE FROM voicemails WHERE id = $1 AND tenant_id = $2', [id(req), req.user.tenant_id]);
    res.json({ ok: true });
  }));

  app.get('/api/summary', h(async (req, res) => {
    const t = req.user.tenant_id;
    const [m, v] = await Promise.all([
      q("SELECT count(*)::int AS n FROM messages WHERE tenant_id = $1 AND direction = 'in' AND NOT read", [t]),
      q('SELECT count(*)::int AS n FROM voicemails WHERE tenant_id = $1 AND NOT listened', [t]),
    ]);
    res.json({ unreadMessages: m.rows[0].n, newVoicemails: v.rows[0].n });
  }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
}

module.exports = { mountApi };
