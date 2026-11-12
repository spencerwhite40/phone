'use strict';
// Bird adapter (bird.com Channels API). SMS only in v1.
//   POST https://api.bird.com/workspaces/{workspaceId}/channels/{channelId}/messages
//   Authorization: AccessKey <key>
// Bird voice is SIP-trunk based (no browser calling), so calls on Bird numbers are not in v1.
const API = 'https://api.bird.com';

async function sendSms({ accessKey, workspaceId, channelId }, to, body) {
  const res = await fetch(`${API}/workspaces/${workspaceId}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { Authorization: `AccessKey ${accessKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      receiver: { contacts: [{ identifierKey: 'phonenumber', identifierValue: to }] },
      body: { type: 'text', text: { text: body } },
    }),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  if (!res.ok) {
    const err = new Error(json?.message || `Bird ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return { id: json?.id || null, status: json?.status || 'accepted' };
}

// Cheap credential check: a bad key / workspace comes back 401/403/404.
async function verify({ accessKey, workspaceId, channelId }) {
  const res = await fetch(`${API}/workspaces/${workspaceId}/channels/${channelId}`, {
    headers: { Authorization: `AccessKey ${accessKey}` },
  });
  if (!res.ok) {
    const err = new Error(`Bird rejected those credentials (${res.status})`);
    err.status = 400;
    throw err;
  }
}

// Bird webhook envelope for channel events. Tolerant on purpose: only the
// fields we need are read, and anything that is not an inbound SMS returns null.
function parseInbound(payload) {
  const ev = String(payload?.event || '');
  const p = payload?.payload || payload;
  if (ev && !/inbound/i.test(ev)) return null;
  const from = p?.sender?.contact?.identifierValue || p?.sender?.contacts?.[0]?.identifierValue;
  const text = p?.body?.text?.text;
  if (!from || typeof text !== 'string') return null;
  return { from, body: text, id: p?.id || payload?.id || null };
}

module.exports = { sendSms, verify, parseInbound };
