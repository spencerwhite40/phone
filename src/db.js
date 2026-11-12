'use strict';
const { Pool } = require('pg');

// One multi-statement query: it runs on a single connection, so a table and
// its indexes can never race across pooled connections.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email text NOT NULL UNIQUE,
  name text NOT NULL DEFAULT '',
  pass_hash text NOT NULL,
  role text NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('twilio','bird')),
  label text NOT NULL DEFAULT '',
  creds_enc text NOT NULL,
  hook_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS greetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  mime text NOT NULL DEFAULT 'audio/wav',
  seconds integer NOT NULL DEFAULT 0,
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  e164 text NOT NULL UNIQUE,
  label text NOT NULL DEFAULT '',
  provider_ref text,
  greeting_id uuid REFERENCES greetings(id) ON DELETE SET NULL,
  forward_to text,
  ring_seconds integer NOT NULL DEFAULT 20,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number_id uuid NOT NULL REFERENCES numbers(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('in','out')),
  peer text NOT NULL,
  body text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'sent',
  provider_id text,
  read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages (tenant_id, number_id, peer, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS messages_provider_uq ON messages (number_id, provider_id) WHERE provider_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number_id uuid NOT NULL REFERENCES numbers(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('in','out')),
  peer text NOT NULL,
  status text NOT NULL DEFAULT 'started',
  seconds integer NOT NULL DEFAULT 0,
  provider_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calls_recent_idx ON calls (tenant_id, created_at DESC);
CREATE TABLE IF NOT EXISTS voicemails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number_id uuid NOT NULL REFERENCES numbers(id) ON DELETE CASCADE,
  peer text NOT NULL,
  recording_url text NOT NULL,
  seconds integer NOT NULL DEFAULT 0,
  provider_id text UNIQUE,
  listened boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS voicemails_recent_idx ON voicemails (tenant_id, created_at DESC);

-- v2: one operator login across many businesses, people assigned to numbers.
-- Everything below is idempotent; the backfills only touch rows that still need it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_admin boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS memberships (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tenant_id)
);
INSERT INTO memberships (user_id, tenant_id, role)
  SELECT id, tenant_id, CASE WHEN role IN ('owner','admin') THEN role ELSE 'member' END FROM users
  ON CONFLICT DO NOTHING;
UPDATE users SET is_platform_admin = true
  WHERE id = (SELECT id FROM users ORDER BY created_at LIMIT 1)
    AND NOT EXISTS (SELECT 1 FROM users WHERE is_platform_admin);
CREATE TABLE IF NOT EXISTS number_members (
  number_id uuid NOT NULL REFERENCES numbers(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (number_id, user_id)
);
CREATE INDEX IF NOT EXISTS number_members_user_idx ON number_members (user_id);
ALTER TABLE numbers ADD COLUMN IF NOT EXISTS ring_mode text NOT NULL DEFAULT 'all';
ALTER TABLE greetings ADD COLUMN IF NOT EXISTS number_id uuid REFERENCES numbers(id) ON DELETE CASCADE;
ALTER TABLE greetings ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL;
`;

function createPool(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL is not set');
  const local = /localhost|127\.0\.0\.1/.test(url) || process.env.PGSSLMODE === 'disable';
  return new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: 8 });
}

async function ensureSchema(pool) {
  await pool.query(SCHEMA);
}

module.exports = { createPool, ensureSchema, SCHEMA };
