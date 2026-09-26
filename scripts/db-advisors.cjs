const { spawnSync } = require('node:child_process');
const path = require('node:path');
const cli = process.argv[2];
if (!cli) throw new Error('Pass the path to the Supabase CLI executable');
const url = new URL(process.env.POSTGRES_URL);
url.searchParams.set('sslmode', 'verify-full');
url.searchParams.set('sslrootcert', path.join(__dirname, '..', 'supabase', 'prod-ca-2021.crt'));
const result = spawnSync(cli, ['db', 'advisors', '--db-url', url.toString(), '--type', 'security', '--fail-on', 'error'], { encoding: 'utf8' });
let output = (result.stdout || '') + (result.stderr || '');
for (const value of [url.toString(), process.env.POSTGRES_URL, decodeURIComponent(url.password)]) {
  if (value) output = output.split(value).join('[REDACTED]');
}
console.log(output);
process.exitCode = result.status ?? 1;
