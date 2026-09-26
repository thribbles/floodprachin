const { Client } = require('pg');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const filename = process.argv[2];
  if (!filename || path.basename(filename) !== filename || !/^\d{14}_[a-z0-9_]+\.sql$/.test(filename)) {
    throw new Error('Pass one exact migration filename, for example 20260926103040_assistance_points_and_drive_attachments.sql');
  }
  const migrationPath = path.join(__dirname, '..', 'supabase', 'migrations', filename);
  if (!fs.existsSync(migrationPath)) throw new Error(`Migration not found: ${filename}`);
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) throw new Error('POSTGRES_URL is required');
  const connectionUrl = new URL(connectionString);
  connectionUrl.searchParams.delete('sslmode');
  const client = new Client({ connectionString: connectionUrl.toString(), connectionTimeoutMillis: 15000,
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync(path.join(__dirname, '..', 'supabase', 'prod-ca-2021.crt'), 'utf8') } });
  await client.connect();
  try {
    const exists = await client.query("select to_regclass('public.assistance_points') as relation");
    if (exists.rows[0].relation && filename.includes('create_flood_database')) throw new Error('assistance_points already exists; migration would duplicate schema');
    await client.query(fs.readFileSync(migrationPath, 'utf8'));
    const result = await client.query("select tablename, rowsecurity from pg_tables where schemaname='public' and tablename='assistance_points'");
    if (result.rows.length !== 1 || !result.rows[0].rowsecurity) throw new Error('Migration verification failed');
    console.log(`Applied and verified: ${filename}`);
  } finally { await client.end(); }
}
main().catch(error => { console.error(error.code || 'DB_ERROR', error.message); process.exitCode = 1; });
