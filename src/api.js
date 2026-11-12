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
const EMAIL = /^\S+@\S+\.\S+$/;
const RING_MODES = ['all', 'sequence'];

function mountApi(app, ctx) {
  const { pool, access } = ctx;
  const q = (text, params) => pool.query(text, params);
  const json = express.json({ limit: '100kb' });
  const requireUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Sign in required' }));
  const requireAdmin = (req, res, next) => (access.isAdmin(req.user) ? next() : res.status(403).json({ error: 'Admins only' }));
  const requireOwner = (req, res, next) => (req.user?.role === 'owner' ? next() : res.status(403).json({ error: 'Owner only' }));
  const requirePlatform = (req, res, next) => (req.user?.is_platform_admin ? next() : res.status(403).json({ error: 'Operator only' }));
  const id = (req) => { if (!UUID.test(req.params.id)) throw httpErr(404, 'Not found'); return req.params.id; };
  const allowed = (req) => access.allowedNumberIds(req.user); // null = all numbers in this business

  // ---- who am I -------------------------------------------------------
  async function mePayload(user) {
    const [t, businesses] = await Promise.all([
      q('SELECT name FROM tenants WHERE id = $1', [user.tenant_id]),
      access.businessesFor(user),
    ]);
    return {
      user: { id: user.id, email: user.email, name: user.name, role: user.role, tenant_id: user.tenant_id, is_platform_admin: user.is_platform_admin },
      company: t.rows[0]?.name, businesses, needsPublicUrl: !ctx.publicUrl, identity: identityFor(user.id),
    };
  }

  // ---- auth ------------------------------------------------------------
  const attempts = new Map();
  const throttled = (key) => {
    const now = Date.now();
    const rec = (attempts.get(key) || []).filter((t) => now - t < 15 * 60 * 1000);
    attempts.set(key, rec);
    return rec.length >= 10;
  };
  const fail = (key) => attempts.get(key).push(Date.now());

  // The very first account on a fresh install becomes the operator (platform admin).
  app.post('/api/signup', json, h(async (req, res) => {
    const { company, name, email, password, code } = req.body || {};
    if (ctx.env.SIGNUP_CODE && !C.safeEqual(code || '', ctx.env.SIGNUP_CODE)) throw httpErr(403, 'Invalid signup code');
    if (!company?.trim() || !EMAIL.test(email || '') || (password || '').length < 8) {
      throw httpErr(400, 'Company, a valid email, and a password of 8+ characters are required');
    }
    const client = await pool.connect();
    let user;
    try {
      await client.query('BEGIN');
      const first = (await client.query('SELECT count(*)::int AS n FROM users')).rows[0].n === 0;
      const t = await client.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id', [company.trim()]);
      const u = await client.query(
        "INSERT INTO users (tenant_id, email, name, pass_hash, role, is_platform_admin) VALUES ($1,$2,$3,$4,'owner',$5) RETURNING id",
        [t.rows[0].id, email.trim().toLowerCase(), (name || '').trim(), C.hashPassword(password), first]);
      await client.query("INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1,$2,'owner')", [u.rows[0].id, t.rows[0].id]);
      await client.query('COMMIT');
      user = { id: u.rows[0].id, tenant_id: t.rows[0].id };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (e.code === '23505') throw httpErr(409, 'That email is already registered');
      throw e;
    } finally { client.release(); }
    ctx.setSession(res, user);
    res.json(await mePayload(await access.loadUser(user.id, user.tenant_id)));
  }));

  app.post('/api/login', json, h(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const key = `${req.ip}|${email}`;
    if (throttled(key)) throw httpErr(429, 'Too many attempts. Try again in a few minutes.');
    const u = (await q('SELECT * FROM users WHERE email = $1', [email])).rows[0];
    if (!u || !C.verifyPassword(String(req.body?.password || ''), u.pass_hash)) { fail(key); throw httpErr(401, 'Wrong email or password'); }
    // Land in their home business if they still belong to it, otherwise the first one they do.
    let tenantId = (await access.loadUser(u.id, u.tenant_id)) ? u.tenant_id : null;
    if (!tenantId) tenantId = (await access.businessesFor(u))[0]?.id;
    const user = tenantId && (await access.loadUser(u.id, tenantId));
    if (!user) throw httpErr(403, 'Your account is not attached to any business. Ask an admin to add you.');
    ctx.setSession(res, user);
    res.json(await mePayload(user));
  }));

  app.post('/api/logout', (req, res) => { ctx.clearSession(res); res.json({ ok: true }); });

  app.get('/api/me', h(async (req, res) => {
    if (!req.user) return res.json({ user: null });
    res.json(await mePayload(req.user));
  }));

  // Everything below needs a signed-in user.
  app.use('/api', (req, res, next) => (['/signup', '/login', '/logout', '/me'].includes(req.path) ? next() : requireUser(req, res, next)));

  app.post('/api/switch', json, h(async (req, res) => {
    const tenantId = String(req.body?.tenantId || '');
    const user = UUID.test(tenantId) && (await access.loadUser(req.user.id, tenantId));
    if (!user) throw httpErr(403, 'You do not have access to that business');
    ctx.setSession(res, user);
    res.json(await mePayload(user));
  }));

  app.post('/api/password', json, h(async (req, res) => {
    const { current, next } = req.body || {};
    const u = (await q('SELECT pass_hash FROM users WHERE id = $1', [req.user.id])).rows[0];
    if (!C.verifyPassword(String(current || ''), u.pass_hash)) throw httpErr(400, 'Current password is wrong');
    if (String(next || '').length < 8) throw httpErr(400, 'New password must be 8+ characters');
    await q('UPDATE users SET pass_hash = $1 WHERE id = $2', [C.hashPassword(next), req.user.id]);
    res.json({ ok: true });
  }));

  // ---- businesses (operator) -------------------------------------------
  app.get('/api/businesses', h(async (req, res) => {
    if (!req.user.is_platform_admin) return res.json({ businesses: await access.businessesFor(req.user) });
    const { rows } = await q(
      `SELECT t.id, t.name, 'owner' AS role,
              (SELECT count(*)::int FROM numbers n WHERE n.tenant_id = t.id) AS numbers,
              (SELECT count(*)::int FROM memberships m WHERE m.tenant_id = t.id) AS people
         FROM tenants t ORDER BY t.created_at`);
    res.json({ businesses: rows });
  }));

  app.post('/api/businesses', requirePlatform, json, h(async (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 80);
    if (!name) throw httpErr(400, 'Business name is required');
    const { rows } = await q('INSERT INTO tenants (name) VALUES ($1) RETURNING id, name', [name]);
    res.json({ business: rows[0] });
  }));

  app.patch('/api/businesses/:id', json, h(async (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 80);
    if (!name) throw httpErr(400, 'Business name is required');
    const u = await access.loadUser(req.user.id, id(req));
    if (u?.role !== 'owner') throw httpErr(403, 'Owner only');
    await q('UPDATE tenants SET name = $1 WHERE id = $2', [name, req.params.id]);
    res.json({ ok: true });
  }));

  app.delete('/api/businesses/:id', requirePlatform, h(async (req, res) => {
    const t = id(req);
    if (t === req.user.tenant_id) throw httpErr(400, 'Switch to a different business before deleting this one');
    const busy = (await q(
      `SELECT (SELECT count(*)::int FROM numbers WHERE tenant_id = $1) AS numbers,
              (SELECT count(*)::int FROM connections WHERE tenant_id = $1) AS connections`, [t])).rows[0];
    if (busy.numbers || busy.connections) throw httpErr(409, 'Move its numbers to another business and remove its providers first');
    await q('DELETE FROM tenants WHERE id = $1', [t]);
    res.json({ ok: true });
  }));

  // Every number across every business, for assigning them.
  app.get('/api/admin/numbers', requirePlatform, h(async (req, res) => {
    const { rows } = await q(
      `SELECT n.id, n.e164, n.label, n.tenant_id, t.name AS business, c.provider
         FROM numbers n JOIN tenants t ON t.id = n.tenant_id JOIN connections c ON c.id = n.connection_id
        ORDER BY t.created_at, n.created_at`);
    res.json({ numbers: rows });
  }));

  // Move a number into another business. Its history moves with it; people assignments and greeting reset.
  app.post('/api/numbers/:id/move', requirePlatform, json, h(async (req, res) => {
    const to = String(req.body?.tenantId || '');
    if (!UUID.test(to) || !(await q('SELECT 1 FROM tenants WHERE id = $1', [to])).rows[0]) throw httpErr(400, 'Unknown business');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const n = await client.query('UPDATE numbers SET tenant_id = $2, greeting_id = NULL WHERE id = $1 RETURNING id', [id(req), to]);
      if (!n.rows[0]) { await client.query('ROLLBACK'); throw httpErr(404, 'Not found'); }
      await client.query('DELETE FROM number_members WHERE number_id = $1', [req.params.id]);
      await client.query('DELETE FROM greetings WHERE number_id = $1', [req.params.id]);
      for (const t of ['messages', 'calls', 'voicemails']) await client.query(`UPDATE ${t} SET tenant_id = $2 WHERE number_id = $1`, [req.params.id, to]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    res.json({ ok: true });
  }));

  // ---- people ----------------------------------------------------------
  app.get('/api/team', requireAdmin, h(async (req, res) => {
    const { rows } = await q(
      `SELECT u.id, u.email, u.name, m.role,
              COALESCE((SELECT array_agg(nm.number_id) FROM number_members nm JOIN numbers n ON n.id = nm.number_id
                         WHERE nm.user_id = u.id AND n.tenant_id = m.tenant_id), '{}') AS number_ids
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = $1 ORDER BY m.created_at`, [req.user.tenant_id]);
    res.json({ users: rows });
  }));

  // Replace a person's number assignments inside this business.
  async function setAssignments(client, tenantId, userId, numberIds) {
    const valid = (await client.query('SELECT id FROM numbers WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [tenantId, numberIds])).rows.map((r) => r.id);
    await client.query('DELETE FROM number_members WHERE user_id = $1 AND number_id IN (SELECT id FROM numbers WHERE tenant_id = $2)', [userId, tenantId]);
    for (const nid of valid) {
      await client.query(
        `INSERT INTO number_members (number_id, user_id, position)
         VALUES ($1, $2, (SELECT count(*)::int FROM number_members WHERE number_id = $1))`, [nid, userId]);
    }
  }
  const idList = (v) => (Array.isArray(v) ? v.filter((x) => UUID.test(x)) : []);

  app.post('/api/team', requireAdmin, json, h(async (req, res) => {
    const { name, email, password } = req.body || {};
    const role = req.body?.role === 'admin' ? 'admin' : 'member';
    if (role === 'admin' && req.user.role !== 'owner') throw httpErr(403, 'Only the owner can add admins');
    const mail = String(email || '').trim().toLowerCase();
    if (!EMAIL.test(mail)) throw httpErr(400, 'A valid email is required');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let user = (await client.query('SELECT id FROM users WHERE email = $1', [mail])).rows[0];
      const existed = !!user;
      if (!user) {
        if ((password || '').length < 8) throw httpErr(400, 'Give them a temporary password of 8+ characters');
        user = (await client.query(
          'INSERT INTO users (tenant_id, email, name, pass_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [req.user.tenant_id, mail, String(name || '').trim(), C.hashPassword(password), role])).rows[0];
      }
      const m = await client.query(
        'INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING user_id', [user.id, req.user.tenant_id, role]);
      if (!m.rows[0]) throw httpErr(409, 'That person is already in this business');
      await setAssignments(client, req.user.tenant_id, user.id, idList(req.body?.numberIds));
      await client.query('COMMIT');
      res.json({ id: user.id, existed });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }
  }));

  app.patch('/api/team/:id', requireAdmin, json, h(async (req, res) => {
    const uid = id(req); const t = req.user.tenant_id;
    const m = (await q('SELECT role FROM memberships WHERE user_id = $1 AND tenant_id = $2', [uid, t])).rows[0];
    if (!m) throw httpErr(404, 'Not found');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if ('role' in (req.body || {})) {
        if (req.user.role !== 'owner') throw httpErr(403, 'Only the owner can change roles');
        if (uid === req.user.id) throw httpErr(400, "You can't change your own role");
        if (!['admin', 'member'].includes(req.body.role)) throw httpErr(400, 'Role must be admin or member');
        if (m.role === 'owner') throw httpErr(400, "The owner's role can't be changed");
        await client.query('UPDATE memberships SET role = $3 WHERE user_id = $1 AND tenant_id = $2', [uid, t, req.body.role]);
      }
      if ('numberIds' in (req.body || {})) await setAssignments(client, t, uid, idList(req.body.numberIds));
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    res.json({ ok: true });
  }));

  app.delete('/api/team/:id', requireAdmin, h(async (req, res) => {
    const uid = id(req); const t = req.user.tenant_id;
    if (uid === req.user.id) throw httpErr(400, "You can't remove yourself");
    const m = (await q('SELECT role FROM memberships WHERE user_id = $1 AND tenant_id = $2', [uid, t])).rows[0];
    if (!m) throw httpErr(404, 'Not found');
    if (m.role === 'owner' && req.user.role !== 'owner') throw httpErr(403, 'Only an owner can remove an owner');
    if (m.role === 'owner' && (await q("SELECT count(*)::int AS n FROM memberships WHERE tenant_id = $1 AND role = 'owner'", [t])).rows[0].n < 2) {
      throw httpErr(400, 'A business needs at least one owner');
    }
    await q('DELETE FROM number_members WHERE user_id = $1 AND number_id IN (SELECT id FROM numbers WHERE tenant_id = $2)', [uid, t]);
    await q('DELETE FROM memberships WHERE user_id = $1 AND tenant_id = $2', [uid, t]);
    // A person with no business left (and not the operator) is deleted outright.
    await q(`DELETE FROM users u WHERE u.id = $1 AND NOT u.is_platform_admin
               AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id)`, [uid]);
    res.json({ ok: true });
  }));

  // ---- providers (Twilio / Bird accounts) ------------------------------
  const credsOf = (row) => C.decrypt(row.creds_enc, ctx.secret);
  const publicOr400 = () => { if (!ctx.publicUrl) throw httpErr(400, 'PUBLIC_URL is not set on the server, so webhooks cannot be wired.'); };
  // The operator manages every provider; an owner manages only their own business's.
  const connScope = (req) => (req.user.is_platform_admin ? ['TRUE', []] : ['c.tenant_id = $1', [req.user.tenant_id]]);

  app.get('/api/connections', requireOwner, h(async (req, res) => {
    const [where, params] = connScope(req);
    const { rows } = await q(
      `SELECT c.id, c.provider, c.label, c.hook_key, c.created_at, t.name AS business,
              (SELECT count(*)::int FROM numbers n WHERE n.connection_id = c.id) AS numbers
         FROM connections c JOIN tenants t ON t.id = c.tenant_id WHERE ${where} ORDER BY c.created_at`, params);
    res.json({
      connections: rows.map(({ hook_key, ...c }) => ({
        ...c, webhookUrl: c.provider === 'bird' ? `${ctx.publicUrl}/hooks/bird/${c.id}?k=${hook_key}` : undefined,
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
    const [where, params] = connScope(req);
    const { rows } = await q(`SELECT c.* FROM connections c WHERE c.id = $${params.length + 1} AND c.provider = 'twilio' AND ${where}`, [...params, id(req)]);
    if (!rows[0]) throw httpErr(404, 'Not found');
    const creds = credsOf(rows[0]);
    // New numbers land in the active business; the operator moves them from there.
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
    const [where, params] = connScope(req);
    await q(`DELETE FROM connections c WHERE c.id = $${params.length + 1} AND ${where}`, [...params, id(req)]);
    res.json({ ok: true });
  }));

  // ---- numbers ---------------------------------------------------------
  app.get('/api/numbers', h(async (req, res) => {
    const ids = await allowed(req);
    const { rows } = await q(
      `SELECT n.id, n.connection_id, n.e164, n.label, n.greeting_id, n.forward_to, n.ring_seconds, n.ring_mode, c.provider, c.label AS connection,
              COALESCE((SELECT json_agg(json_build_object('id', u.id, 'name', COALESCE(NULLIF(u.name, ''), u.email)) ORDER BY nm.position)
                          FROM number_members nm JOIN users u ON u.id = nm.user_id WHERE nm.number_id = n.id), '[]') AS people
         FROM numbers n JOIN connections c ON c.id = n.connection_id
        WHERE n.tenant_id = $1 AND ($2::uuid[] IS NULL OR n.id = ANY($2)) ORDER BY n.created_at`, [req.user.tenant_id, ids]);
    res.json({ numbers: rows.map((n) => ({ ...n, canCall: n.provider === 'twilio', canText: true })) });
  }));

  // Admins change anything; an assigned member may only pick their number's greeting.
  app.patch('/api/numbers/:id', json, h(async (req, res) => {
    const nid = id(req); const b = req.body || {};
    const ids = await allowed(req);
    const n = (await q('SELECT id FROM numbers WHERE id = $1 AND tenant_id = $2 AND ($3::uuid[] IS NULL OR id = ANY($3))', [nid, req.user.tenant_id, ids])).rows[0];
    if (!n) throw httpErr(404, 'Not found');
    const admin = access.isAdmin(req.user);
    if (!admin && Object.keys(b).some((k) => k !== 'greeting_id')) throw httpErr(403, 'Only admins can change that');
    const sets = []; const vals = [nid];
    const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if ('label' in b) add('label', String(b.label || '').trim().slice(0, 60));
    if ('forward_to' in b) {
      const f = b.forward_to ? toE164(b.forward_to) : null;
      if (b.forward_to && !f) throw httpErr(400, 'Forwarding number is not valid');
      add('forward_to', f);
    }
    if ('ring_seconds' in b) add('ring_seconds', Math.min(60, Math.max(5, parseInt(b.ring_seconds, 10) || 20)));
    if ('ring_mode' in b) { if (!RING_MODES.includes(b.ring_mode)) throw httpErr(400, 'Unknown ring mode'); add('ring_mode', b.ring_mode); }
    if ('greeting_id' in b) {
      if (b.greeting_id) {
        const g = await q('SELECT 1 FROM greetings WHERE id = $1 AND tenant_id = $2 AND (number_id IS NULL OR number_id = $3)', [b.greeting_id, req.user.tenant_id, nid]);
        if (!g.rows[0]) throw httpErr(400, 'Unknown greeting');
      }
      add('greeting_id', b.greeting_id || null);
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (sets.length) await client.query(`UPDATE numbers SET ${sets.join(', ')} WHERE id = $1`, vals);
      if ('people' in b) {
        // keep the order the admin chose: it is the ring order in sequence mode
        const wanted = [...new Set(idList(b.people))];
        const members = new Set((await client.query(
          'SELECT user_id FROM memberships WHERE tenant_id = $1 AND user_id = ANY($2::uuid[])', [req.user.tenant_id, wanted])).rows.map((r) => r.user_id));
        const valid = wanted.filter((u) => members.has(u));
        await client.query('DELETE FROM number_members WHERE number_id = $1', [nid]);
        for (let i = 0; i < valid.length; i++) {
          await client.query('INSERT INTO number_members (number_id, user_id, position) VALUES ($1,$2,$3)', [nid, valid[i], i]);
        }
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    if (!sets.length && !('people' in b)) throw httpErr(400, 'Nothing to update');
    res.json({ ok: true });
  }));

  // ---- browser calling token ---------------------------------------------
  app.get('/api/voice/token', h(async (req, res) => {
    const numberId = String(req.query.numberId || '');
    if (!UUID.test(numberId)) throw httpErr(400, 'numberId required');
    const ids = await allowed(req);
    const { rows } = await q(
      `SELECT c.* FROM numbers n JOIN connections c ON c.id = n.connection_id
        WHERE n.id = $1 AND n.tenant_id = $2 AND c.provider = 'twilio' AND ($3::uuid[] IS NULL OR n.id = ANY($3))`, [numberId, req.user.tenant_id, ids]);
    if (!rows[0]) throw httpErr(404, 'That number cannot place calls');
    const identity = identityFor(req.user.id);
    const creds = credsOf(rows[0]);
    if (!creds.apiKeySid || !creds.apiKeySecret || !creds.appSid) throw httpErr(400, 'This Twilio connection is incomplete. Remove it and connect again.');
    res.json({ token: twilio.accessToken(creds, identity, 3600), identity, connectionId: rows[0].id, ttl: 3600 });
  }));

  // ---- greetings -------------------------------------------------------
  // Admins see every greeting in the business; a member sees their own and those of their numbers.
  const GREETING_VISIBLE = '($2::uuid[] IS NULL OR g.number_id = ANY($2) OR g.created_by = $3)';

  app.get('/api/greetings', h(async (req, res) => {
    const ids = await allowed(req);
    const { rows } = await q(
      `SELECT g.id, g.name, g.seconds, g.number_id, g.created_at,
              (SELECT count(*)::int FROM numbers n WHERE n.greeting_id = g.id) AS used_by
         FROM greetings g WHERE g.tenant_id = $1 AND ${GREETING_VISIBLE} ORDER BY g.created_at DESC`, [req.user.tenant_id, ids, req.user.id]);
    res.json({ greetings: rows });
  }));

  // The browser sends a WAV (it converts whatever was recorded or uploaded). With ?numberId it also becomes that number's active greeting.
  app.post('/api/greetings', express.raw({ type: () => true, limit: '8mb' }), h(async (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 1000 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
      throw httpErr(415, 'Greeting must be a WAV file (the app converts recordings for you)');
    }
    const numberId = req.query.numberId ? String(req.query.numberId) : null;
    if (numberId) {
      const ids = await allowed(req);
      const ok = UUID.test(numberId) && (await q('SELECT 1 FROM numbers WHERE id = $1 AND tenant_id = $2 AND ($3::uuid[] IS NULL OR id = ANY($3))', [numberId, req.user.tenant_id, ids])).rows[0];
      if (!ok) throw httpErr(404, 'Number not found');
    } else if (!access.isAdmin(req.user)) throw httpErr(403, 'Pick a number for this greeting');
    if ((await q('SELECT count(*)::int AS n FROM greetings WHERE tenant_id = $1', [req.user.tenant_id])).rows[0].n >= 200) {
      throw httpErr(400, 'Too many greetings. Delete some you no longer use.');
    }
    const name = String(req.query.name || 'Greeting').trim().slice(0, 60) || 'Greeting';
    const seconds = Math.min(600, Math.max(0, parseInt(req.query.seconds, 10) || 0));
    const { rows } = await q(
      'INSERT INTO greetings (tenant_id, name, seconds, data, number_id, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, seconds, number_id',
      [req.user.tenant_id, name, seconds, buf, numberId, req.user.id]);
    if (numberId) await q('UPDATE numbers SET greeting_id = $1 WHERE id = $2', [rows[0].id, numberId]);
    res.json({ greeting: rows[0] });
  }));

  app.get('/api/greetings/:id/audio', h(async (req, res) => {
    const ids = await allowed(req);
    const { rows } = await q(`SELECT g.data, g.mime FROM greetings g WHERE g.id = $4 AND g.tenant_id = $1 AND ${GREETING_VISIBLE}`, [req.user.tenant_id, ids, req.user.id, id(req)]);
    if (!rows[0]) throw httpErr(404, 'Not found');
    res.type(rows[0].mime).send(rows[0].data);
  }));

  app.delete('/api/greetings/:id', h(async (req, res) => {
    const g = (await q('SELECT created_by FROM greetings WHERE id = $1 AND tenant_id = $2', [id(req), req.user.tenant_id])).rows[0];
    if (!g) throw httpErr(404, 'Not found');
    if (!access.isAdmin(req.user) && g.created_by !== req.user.id) throw httpErr(403, 'You can only delete your own greetings');
    await q('DELETE FROM greetings WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  }));

  // ---- messages --------------------------------------------------------
  // Every list below is scoped to the business and, for members, to their assigned numbers ($2 = allowed ids or null).
  app.get('/api/threads', h(async (req, res) => {
    const ids = await allowed(req);
    const { rows } = await q(
      `SELECT DISTINCT ON (m.number_id, m.peer)
              m.number_id, m.peer, m.body, m.direction, m.created_at,
              (SELECT count(*)::int FROM messages u WHERE u.number_id = m.number_id AND u.peer = m.peer AND u.direction = 'in' AND NOT u.read) AS unread
         FROM messages m WHERE m.tenant_id = $1 AND ($2::uuid[] IS NULL OR m.number_id = ANY($2))
        ORDER BY m.number_id, m.peer, m.created_at DESC`, [req.user.tenant_id, ids]);
    rows.sort((a, b) => b.created_at - a.created_at);
    res.json({ threads: rows });
  }));

  app.get('/api/thread', h(async (req, res) => {
    const numberId = String(req.query.numberId || ''); const peer = toE164(req.query.peer);
    if (!UUID.test(numberId) || !peer) throw httpErr(400, 'numberId and peer required');
    const ids = await allowed(req);
    if (ids && !ids.includes(numberId)) return res.json({ messages: [] });
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
    const ids = await allowed(req);
    const { rows } = await q(
      `SELECT n.id, n.e164, c.provider, c.creds_enc FROM numbers n JOIN connections c ON c.id = n.connection_id
        WHERE n.id = $1 AND n.tenant_id = $2 AND ($3::uuid[] IS NULL OR n.id = ANY($3))`, [numberId, req.user.tenant_id, ids]);
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
    const ids = await allowed(req);
    const { rows } = await q(
      `SELECT id, number_id, direction, peer, status, seconds, created_at FROM calls
        WHERE tenant_id = $1 AND ($2::uuid[] IS NULL OR number_id = ANY($2)) ORDER BY created_at DESC LIMIT 100`, [req.user.tenant_id, ids]);
    res.json({ calls: rows });
  }));

  app.get('/api/voicemails', h(async (req, res) => {
    const ids = await allowed(req);
    const { rows } = await q(
      `SELECT id, number_id, peer, seconds, listened, created_at FROM voicemails
        WHERE tenant_id = $1 AND ($2::uuid[] IS NULL OR number_id = ANY($2)) ORDER BY created_at DESC LIMIT 100`, [req.user.tenant_id, ids]);
    res.json({ voicemails: rows });
  }));

  app.get('/api/voicemails/:id/audio', h(async (req, res) => {
    const ids = await allowed(req);
    const { rows } = await q(
      `SELECT v.recording_url, c.creds_enc FROM voicemails v
         JOIN numbers n ON n.id = v.number_id JOIN connections c ON c.id = n.connection_id
        WHERE v.id = $1 AND v.tenant_id = $2 AND ($3::uuid[] IS NULL OR v.number_id = ANY($3))`, [id(req), req.user.tenant_id, ids]);
    if (!rows[0]) throw httpErr(404, 'Not found');
    const upstream = await twilio.fetchRecording(credsOf(rows[0]), rows[0].recording_url);
    if (!upstream.ok) throw httpErr(502, 'Recording is not available yet');
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(Buffer.from(await upstream.arrayBuffer()));
  }));

  app.post('/api/voicemails/:id/listened', h(async (req, res) => {
    const ids = await allowed(req);
    await q('UPDATE voicemails SET listened = true WHERE id = $1 AND tenant_id = $2 AND ($3::uuid[] IS NULL OR number_id = ANY($3))', [id(req), req.user.tenant_id, ids]);
    res.json({ ok: true });
  }));

  app.delete('/api/voicemails/:id', h(async (req, res) => {
    const ids = await allowed(req);
    await q('DELETE FROM voicemails WHERE id = $1 AND tenant_id = $2 AND ($3::uuid[] IS NULL OR number_id = ANY($3))', [id(req), req.user.tenant_id, ids]);
    res.json({ ok: true });
  }));

  app.get('/api/summary', h(async (req, res) => {
    const t = req.user.tenant_id; const ids = await allowed(req);
    const [m, v] = await Promise.all([
      q("SELECT count(*)::int AS n FROM messages WHERE tenant_id = $1 AND direction = 'in' AND NOT read AND ($2::uuid[] IS NULL OR number_id = ANY($2))", [t, ids]),
      q('SELECT count(*)::int AS n FROM voicemails WHERE tenant_id = $1 AND NOT listened AND ($2::uuid[] IS NULL OR number_id = ANY($2))', [t, ids]),
    ]);
    res.json({ unreadMessages: m.rows[0].n, newVoicemails: v.rows[0].n });
  }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
}

module.exports = { mountApi };
