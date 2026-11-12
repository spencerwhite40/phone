'use strict';
const { createPool, ensureSchema } = require('./src/db');
const { createApp } = require('./src/app');

async function main() {
  const pool = createPool();
  await ensureSchema(pool);
  const app = createApp({ pool, env: process.env });
  const port = process.env.PORT || 3100;
  app.listen(port, () => console.log(`[phone] listening on :${port}  public=${process.env.PUBLIC_URL || '(PUBLIC_URL not set)'}`));
}

main().catch((e) => { console.error('[phone] boot failed:', e.message); process.exit(1); });
