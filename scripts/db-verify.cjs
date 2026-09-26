const { Client } = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

async function main() {
  const url = new URL(process.env.POSTGRES_URL);
  url.searchParams.delete('sslmode');
  const client = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 15000,
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync(path.join(__dirname, '..', 'supabase', 'prod-ca-2021.crt'), 'utf8') } });
  await client.connect();
  async function asUser(id, app_metadata = {}, user_metadata = {}) {
    await client.query('set local role authenticated');
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: 'authenticated', app_metadata, user_metadata })]);
  }
  async function denied(sql, params, code) {
    await client.query('savepoint denied_check');
    try { await client.query(sql, params); assert.fail('Expected rejection'); }
    catch (error) { assert.equal(error.code, code); }
    finally { await client.query('rollback to savepoint denied_check'); }
  }
  try {
    await client.query('begin');
    const owner = randomUUID(), other = randomUUID();
    await client.query('insert into auth.users(id) values ($1), ($2)', [owner, other]);
    const p = (await client.query("select extensions.st_y(p) lat, extensions.st_x(p) lng from (select extensions.st_pointonsurface(boundary) p from public.province_boundaries where province_code='25') x")).rows[0];
    await asUser(owner);
    const id = (await client.query('select public.submit_flood_report($1,$2,$3,$4,$5,$6) id', ['help', 'Disposable transaction verification', p.lat, p.lng, 1, '0000000000'])).rows[0].id;
    assert.equal((await client.query('select phone from public.report_contacts where report_id=$1', [id])).rows.length, 1);
    console.log('PASS: owner creates a report and reads their contact');
    await denied('select public.submit_flood_report($1,$2,$3,$4,$5,$6)', ['help', 'outside province', 13.75, 100.5, 1, null], '23514');
    console.log('PASS: database rejects coordinates outside Prachinburi');
    await denied('update public.flood_reports set owner_id=$1 where id=$2', [other, id], '42501');
    console.log('PASS: ownership cannot be reassigned');
    await asUser(other, {}, { role: 'admin' });
    assert.equal((await client.query('select phone from public.report_contacts where report_id=$1', [id])).rows.length, 0);
    assert.equal((await client.query("update public.flood_reports set status='done' where id=$1 returning id", [id])).rows.length, 0);
    console.log('PASS: another user cannot read the phone or change status, including spoofed user_metadata');
    await client.query('set local role anon');
    assert.equal((await client.query('select id from public.flood_reports where id=$1', [id])).rows.length, 1);
    assert.equal((await client.query('select phone from public.report_contacts where report_id=$1', [id])).rows.length, 0);
    await client.query("select set_config('request.jwt.claims', '{}', true)");
    const anonymousId = (await client.query('select public.submit_flood_report($1,$2,$3,$4,$5,$6) id', ['help', 'Anonymous submission', p.lat, p.lng, 1, null])).rows[0].id;
    assert.equal((await client.query('select owner_id from public.flood_reports where id=$1 and owner_id is null', [anonymousId])).rows.length, 1);
    console.log('PASS: public users read reports, cannot read contacts, and can submit without login');
    await asUser(other, { role: 'rescuer' });
    assert.equal((await client.query('select phone from public.report_contacts where report_id=$1', [id])).rows.length, 1);
    assert.equal((await client.query("update public.flood_reports set status='done' where id=$1 returning id", [id])).rows.length, 1);
    console.log('PASS: assigned rescuer can read contact and complete a report');
  } finally {
    await client.query('rollback');
    await client.end();
    console.log('Verification transaction rolled back; no sample reports retained');
  }
  const response = await fetch(process.env.SUPABASE_URL + '/rest/v1/flood_reports?select=id,report_contacts(phone)&limit=1', {
    headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY }
  });
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(await response.json()));
  console.log('PASS: public Supabase Data API responds successfully');
}
main().catch(error => { console.error(error.code || 'VERIFY_ERROR', error.message); process.exitCode = 1; });
