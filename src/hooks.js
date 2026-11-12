'use strict';
const express = require('express');
const C = require('./crypto');
const twilio = require('./providers/twilio');
const bird = require('./providers/bird');
const { toE164, esc, twiml, identityFor, userIdFromIdentity } = require('./util');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const xml = (res, body) => res.type('text/xml').send(body);
const num = (v) => parseInt(v, 10) || 0;

function mountHooks(app, ctx) {
  const { pool } = ctx;
  const q = (t, p) => pool.query(t, p);
  const form = express.urlencoded({ extended: false, limit: '100kb' });

  async function numberWithCreds(numberId) {
    if (!UUID.test(numberId || '')) return null;
    const { rows } = await q(
      `SELECT n.*, c.creds_enc, c.provider FROM numbers n JOIN connections c ON c.id = n.connection_id
        WHERE n.id = $1 AND c.provider = 'twilio'`, [numberId]);
    if (!rows[0]) return null;
    return { n: rows[0], creds: C.decrypt(rows[0].creds_enc, ctx.secret) };
  }

  // Reject anything that is not signed by this number's own Twilio account.
  function authentic(req, creds) {
    if (ctx.env.SKIP_TWILIO_SIGNATURE === '1') return true;
    return twilio.validateSignature(creds.authToken, ctx.publicUrl + req.originalUrl, req.body || {}, req.get('x-twilio-signature'));
  }
  async function guarded(req, res, numberId) {
    const found = await numberWithCreds(numberId);
    if (!found || !authentic(req, found.creds)) { res.status(403).type('text/plain').send('forbidden'); return null; }
    return found;
  }

  const hook = (p) => `${ctx.publicUrl}/hooks/twilio/voice/${p}`;
  const upsertCall = (n, direction, peer, sid) => q(
    `INSERT INTO calls (tenant_id, number_id, direction, peer, provider_id) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (provider_id) DO NOTHING`, [n.tenant_id, n.id, direction, peer, sid]);

  // ---- public greeting audio (unguessable UUID; Twilio fetches it) --------
  app.get('/greeting/:id.wav', h(async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).end();
    const { rows } = await q('SELECT data, mime FROM greetings WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=300').type(rows[0].mime).send(rows[0].data);
  }));

  // ---- Twilio voice: outbound (browser -> TwiML app) ---------------------
  app.post('/hooks/twilio/voice/out', form, h(async (req, res) => {
    const found = await guarded(req, res, req.body.numberId);
    if (!found) return;
    const { n } = found;
    const userId = userIdFromIdentity(req.body.From || req.body.Caller);
    const allowedUser = userId && (await ctx.access.canUseNumber(userId, n));
    const to = toE164(req.body.To);
    if (!allowedUser) return xml(res, twiml('<Reject/>'));
    if (!to) return xml(res, twiml('<Say>That number is not valid.</Say>'));
    await upsertCall(n, 'out', to, req.body.CallSid);
    xml(res, twiml(
      `<Dial callerId="${esc(n.e164)}" answerOnBridge="true" action="${esc(hook(`outdone/${n.id}`))}"><Number>${esc(to)}</Number></Dial>`));
  }));

  app.post('/hooks/twilio/voice/outdone/:numberId', form, h(async (req, res) => {
    const found = await guarded(req, res, req.params.numberId);
    if (!found) return;
    const st = req.body.DialCallStatus || 'completed';
    await q('UPDATE calls SET status = $1, seconds = $2 WHERE provider_id = $3 AND tenant_id = $4',
      [st, num(req.body.DialCallDuration), req.body.CallSid, found.n.tenant_id]);
    xml(res, twiml());
  }));

  // ---- Twilio voice: inbound -> ring everyone + forward, else voicemail --
  app.post('/hooks/twilio/voice/in/:numberId', form, h(async (req, res) => {
    const found = await guarded(req, res, req.params.numberId);
    if (!found) return;
    const { n } = found;
    const from = toE164(req.body.From) || req.body.From || 'unknown';
    await upsertCall(n, 'in', from, req.body.CallSid);
    const targets = await ringTargets(n);
    if (!targets.length) return xml(res, twiml(voicemailPrompt(n)));
    xml(res, twiml(dialXml(n, targets, 0)));
  }));

  // Who rings: the people assigned to this number, in order. A number nobody is assigned to
  // rings the business's owners/admins so a call is never dropped. Forwarding cell comes last.
  async function ringTargets(n) {
    let users = (await q(
      `SELECT user_id AS id FROM number_members WHERE number_id = $1 ORDER BY position, created_at`, [n.id])).rows;
    if (!users.length) {
      users = (await q(
        "SELECT user_id AS id FROM memberships WHERE tenant_id = $1 AND role IN ('owner','admin') ORDER BY created_at", [n.tenant_id])).rows;
    }
    const targets = users.map((u) => `<Client>${identityFor(u.id)}</Client>`);
    if (n.forward_to) targets.push(`<Number>${esc(n.forward_to)}</Number>`);
    return targets;
  }

  // 'all' rings everyone at once; 'sequence' rings one at a time, moving on when unanswered.
  function dialXml(n, targets, step) {
    const sequence = n.ring_mode === 'sequence';
    const next = sequence ? `${hook(`dialdone/${n.id}`)}?step=${step + 1}` : hook(`dialdone/${n.id}`);
    const nouns = sequence ? targets[step] : targets.join('');
    return `<Dial timeout="${n.ring_seconds}" answerOnBridge="true" action="${esc(next)}">${nouns}</Dial>`;
  }

  function voicemailPrompt(n) {
    const greeting = n.greeting_id
      ? `<Play>${esc(`${ctx.publicUrl}/greeting/${n.greeting_id}.wav`)}</Play>`
      : `<Say>Sorry, we can't take your call right now. Please leave a message after the beep.</Say>`;
    return `${greeting}<Record maxLength="120" playBeep="true" timeout="6" action="${esc(hook(`vmdone/${n.id}`))}"`
      + ` recordingStatusCallback="${esc(hook(`vmstatus/${n.id}`))}" recordingStatusCallbackEvent="completed"/>`;
  }

  app.post('/hooks/twilio/voice/dialdone/:numberId', form, h(async (req, res) => {
    const found = await guarded(req, res, req.params.numberId);
    if (!found) return;
    const { n } = found;
    const st = req.body.DialCallStatus;
    if (st === 'completed' || st === 'answered') {
      await q("UPDATE calls SET status = 'completed', seconds = $1 WHERE provider_id = $2 AND tenant_id = $3",
        [num(req.body.DialCallDuration), req.body.CallSid, n.tenant_id]);
      return xml(res, twiml());
    }
    if (n.ring_mode === 'sequence') {
      const step = num(req.query.step);
      const targets = await ringTargets(n);
      if (step < targets.length) return xml(res, twiml(dialXml(n, targets, step)));
    }
    await q("UPDATE calls SET status = 'missed' WHERE provider_id = $1 AND tenant_id = $2", [req.body.CallSid, n.tenant_id]);
    xml(res, twiml(voicemailPrompt(n)));
  }));

  app.post('/hooks/twilio/voice/vmdone/:numberId', form, h(async (req, res) => {
    const found = await guarded(req, res, req.params.numberId);
    if (!found) return;
    xml(res, twiml('<Say>Thank you. Goodbye.</Say><Hangup/>'));
  }));

  app.post('/hooks/twilio/voice/vmstatus/:numberId', form, h(async (req, res) => {
    const found = await guarded(req, res, req.params.numberId);
    if (!found) return;
    const { n } = found;
    const secs = num(req.body.RecordingDuration);
    if (req.body.RecordingUrl && secs >= 1) {
      const call = (await q('SELECT peer FROM calls WHERE provider_id = $1 AND tenant_id = $2', [req.body.CallSid, n.tenant_id])).rows[0];
      await q(
        `INSERT INTO voicemails (tenant_id, number_id, peer, recording_url, seconds, provider_id)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (provider_id) DO NOTHING`,
        [n.tenant_id, n.id, call?.peer || 'unknown', req.body.RecordingUrl, secs, req.body.RecordingSid]);
    }
    res.status(204).end();
  }));

  // ---- SMS ---------------------------------------------------------------
  app.post('/hooks/twilio/sms/:numberId', form, h(async (req, res) => {
    const found = await guarded(req, res, req.params.numberId);
    if (!found) return;
    const peer = toE164(req.body.From);
    if (peer) {
      await q(
        `INSERT INTO messages (tenant_id, number_id, direction, peer, body, status, provider_id, read)
         VALUES ($1,$2,'in',$3,$4,'received',$5,false) ON CONFLICT DO NOTHING`,
        [found.n.tenant_id, found.n.id, peer, req.body.Body || '', req.body.MessageSid || null]);
    }
    xml(res, twiml());
  }));

  app.post('/hooks/bird/:connectionId', express.json({ limit: '200kb' }), h(async (req, res) => {
    if (!UUID.test(req.params.connectionId)) return res.status(404).end();
    const { rows } = await q("SELECT id, tenant_id, hook_key FROM connections WHERE id = $1 AND provider = 'bird'", [req.params.connectionId]);
    if (!rows[0] || !C.safeEqual(String(req.query.k || ''), rows[0].hook_key)) return res.status(403).end();
    const msg = bird.parseInbound(req.body);
    const peer = msg && toE164(msg.from);
    if (peer) {
      const n = (await q('SELECT id FROM numbers WHERE connection_id = $1 LIMIT 1', [rows[0].id])).rows[0];
      if (n) {
        await q(
          `INSERT INTO messages (tenant_id, number_id, direction, peer, body, status, provider_id, read)
           VALUES ($1,$2,'in',$3,$4,'received',$5,false) ON CONFLICT DO NOTHING`,
          [rows[0].tenant_id, n.id, peer, msg.body, msg.id]);
      }
    }
    res.status(200).json({ ok: true }); // always 200 so Bird does not retry non-SMS events
  }));
}

module.exports = { mountHooks };
