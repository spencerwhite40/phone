'use strict';

// Normalise user input to E.164. US-first: 10 digits => +1.
function toE164(input, defaultCountry = '1') {
  if (input == null) return null;
  const s = String(input).trim();
  const digits = s.replace(/\D/g, '');
  if (!digits) return null;
  if (s.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+${defaultCountry}${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return null;
}

const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const twiml = (inner = '') => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;

// Twilio Client identities may only contain [A-Za-z0-9_].
const identityFor = (userId) => `u_${String(userId).replace(/-/g, '')}`;
const userIdFromIdentity = (identity) => {
  const m = /^(?:client:)?u_([0-9a-f]{32})$/.exec(String(identity || ''));
  if (!m) return null;
  const h = m[1];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

module.exports = { toE164, esc, twiml, identityFor, userIdFromIdentity };
