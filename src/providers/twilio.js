'use strict';
// Twilio adapter. Plain REST + hand-rolled JWT / signature so there is no SDK to babysit.
const crypto = require('node:crypto');
const { safeEqual } = require('../crypto');

const API = 'https://api.twilio.com/2010-04-01';

function basic(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

async function rest(creds, method, path, form, { auth } = {}) {
  const url = path.startsWith('http') ? path : `${API}/Accounts/${creds.accountSid}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: auth || basic(creds.accountSid, creds.authToken),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = new Error(json?.message || `Twilio ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// X-Twilio-Signature: base64(HMAC-SHA1(authToken, url + sorted(key+value)...))
function validateSignature(authToken, url, params, signature) {
  if (!signature) return false;
  const data = Object.keys(params || {}).sort().reduce((acc, k) => acc + k + params[k], url);
  const want = crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
  return safeEqual(want, signature);
}

// Access token for the browser Voice SDK (HS256 JWT signed with an API key secret).
function accessToken({ accountSid, apiKeySid, apiKeySecret, appSid }, identity, ttl = 3600) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b({ typ: 'JWT', alg: 'HS256', cty: 'twilio-fpa;v=1' });
  const body = b({
    jti: `${apiKeySid}-${now}`,
    iss: apiKeySid,
    sub: accountSid,
    iat: now,
    exp: now + ttl,
    grants: {
      identity,
      voice: { incoming: { allow: true }, outgoing: { application_sid: appSid } },
    },
  });
  const sig = crypto.createHmac('sha256', apiKeySecret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

// Verify the account, mint an API key + TwiML app, and list the numbers on it.
async function connect({ accountSid, authToken }, publicUrl) {
  const creds = { accountSid, authToken };
  const acct = await rest(creds, 'GET', '.json'); // also proves the SID + token pair is valid
  const key = await rest(creds, 'POST', '/Keys.json', { FriendlyName: 'Haulers Phone' });
  const app = await rest(creds, 'POST', '/Applications.json', {
    FriendlyName: 'Haulers Phone',
    VoiceUrl: `${publicUrl}/hooks/twilio/voice/out`,
    VoiceMethod: 'POST',
  });
  return {
    creds: { accountSid, authToken, apiKeySid: key.sid, apiKeySecret: key.secret, appSid: app.sid },
    accountName: acct?.friendly_name || accountSid,
    numbers: await listNumbers(creds),
  };
}

async function listNumbers(creds) {
  const nums = await rest(creds, 'GET', '/IncomingPhoneNumbers.json?PageSize=100');
  return (nums.incoming_phone_numbers || []).map((n) => ({
    e164: n.phone_number, label: n.friendly_name || n.phone_number, ref: n.sid,
  }));
}

// Point a number's voice + SMS webhooks at us.
async function configureNumber(creds, providerRef, numberId, publicUrl) {
  return rest(creds, 'POST', `/IncomingPhoneNumbers/${providerRef}.json`, {
    VoiceUrl: `${publicUrl}/hooks/twilio/voice/in/${numberId}`,
    VoiceMethod: 'POST',
    SmsUrl: `${publicUrl}/hooks/twilio/sms/${numberId}`,
    SmsMethod: 'POST',
  });
}

async function sendSms(creds, from, to, body) {
  const r = await rest(creds, 'POST', '/Messages.json', { From: from, To: to, Body: body });
  return { id: r.sid, status: r.status || 'queued' };
}

// Recordings sit behind Twilio auth; proxy them for the signed-in tenant.
async function fetchRecording(creds, url) {
  const u = new URL(url);
  if (u.hostname !== 'api.twilio.com') throw new Error('unexpected recording host');
  return fetch(u.toString().replace(/\.(json|mp3|wav)$/, '') + '.mp3', {
    headers: { Authorization: basic(creds.accountSid, creds.authToken) },
  });
}

module.exports = { connect, listNumbers, configureNumber, sendSms, accessToken, validateSignature, fetchRecording };
