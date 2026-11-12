'use strict';
const path = require('node:path');
const express = require('express');
const crypto = require('./crypto');
const { mountApi } = require('./api');
const { mountHooks } = require('./hooks');
const { makeAccess } = require('./access');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createApp({ pool, env }) {
  if (!env.APP_SECRET || env.APP_SECRET.length < 16) throw new Error('APP_SECRET must be set (16+ chars)');
  const publicUrl = (env.PUBLIC_URL || '').replace(/\/+$/, '');
  const secure = publicUrl.startsWith('https://');
  const access = makeAccess(pool);
  const ctx = { pool, env, publicUrl, secure, secret: env.APP_SECRET, access };

  // `user.tenant_id` is the business the session is currently "in" (switchable).
  ctx.setSession = (res, user) => {
    const token = crypto.sign({ u: user.id, t: user.tenant_id, exp: Math.floor(Date.now() / 1000) + 30 * 86400 }, ctx.secret);
    res.setHeader('Set-Cookie', `sid=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}`);
  };
  ctx.clearSession = (res) => res.setHeader('Set-Cookie', `sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  mountHooks(app, ctx);

  // Session for /api. Mutating calls must carry a custom header (blocks cross-site form posts).
  app.use('/api', async (req, res, next) => {
    try {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('x-requested-with') !== 'phone') {
        return res.status(403).json({ error: 'Missing X-Requested-With header' });
      }
      const s = crypto.verify(parseCookies(req.headers.cookie).sid, ctx.secret);
      if (s) req.user = await access.loadUser(s.u, s.t);
      next();
    } catch (e) { next(e); }
  });
  mountApi(app, ctx);

  // PWA shell + the Twilio browser SDK served from our own origin.
  app.get('/vendor/twilio.min.js', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.join(__dirname, '..', 'node_modules', '@twilio', 'voice-sdk', 'dist', 'twilio.min.js'));
  });
  app.get('/sw.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, '..', 'public', 'sw.js'));
  });
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h', index: 'index.html' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error('[phone]', req.method, req.originalUrl, err);
    if (req.path.startsWith('/hooks/')) return res.status(status).type('text/plain').send('error');
    // 502 = a provider refused something; its reason is what the user needs to see.
    res.status(status).json({ error: status >= 500 && status !== 502 ? 'Something went wrong' : err.message });
  });
  return app;
}

module.exports = { createApp, parseCookies };
