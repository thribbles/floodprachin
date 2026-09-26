const { Client } = require('pg');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) throw new Error('POSTGRES_URL is required');
  const connectionUrl = new URL(connectionString);
  connectionUrl.searchParams.delete('sslmode');
  const client = new Client({ connectionString: connectionUrl.toString(), connectionTimeoutMillis: 15000,
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync(path.join(__dirname, '..', 'supabase', 'prod-ca-2021.crt'), 'utf8') } });
  await client.connect();
  try {
    const existing = await client.query("select to_regclass('public.flood_reports') as relation");
    if (existing.rows[0].relation) throw new Error('flood_reports already exists; refusing to recreate schema');
    const directory = path.join(__dirname, '..', 'supabase', 'migrations');
    for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) {
      await client.query(fs.readFileSync(path.join(directory, file), 'utf8'));
      console.log('Applied:', file);
    }
    const result = await client.query("select tablename, rowsecurity from pg_tables where schemaname='public' and tablename in ('flood_reports','report_contacts','province_boundaries') order by tablename");
    console.log(JSON.stringify(result.rows));
  } finally { await client.end(); }
}
main().catch(error => { console.error(error.code || 'DB_ERROR', error.message); process.exitCode = 1; });
