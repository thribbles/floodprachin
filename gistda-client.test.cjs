const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseChecks, fetchChecks, endpoint } = require('./gistda-client');
const fixture = { status: 200, errMsg: '', data: [
  { servicename: 'flooding', source: 'GISTDA', datetime: '24/09/2569 00:00 น.' },
  { servicename: 'floodwarnwms', source: 'GISTDA', datetime: '26/09/2569 10:26 น.' },
  { servicename: 'rain30wms', source: 'GSMAP', datetime: '26/09/2569 10:37 น.' }
] };
test('preserves all services and Buddhist-era provider timestamps', () => {
  assert.deepEqual(parseChecks(fixture), fixture.data);
  assert.deepEqual(parseChecks({ status: 200, data: [] }), []);
});
test('rejects application errors and malformed service records', () => {
  assert.throws(() => parseChecks({ status: 407 }), /API key/);
  assert.throws(() => parseChecks({ status: 200, data: [{}] }), /ไม่ครบถ้วน/);
  assert.throws(() => parseChecks({ status: 500, data: [] }), /ไม่ถูกต้อง/);
});
test('requests the supplied endpoint with encoded key, without location data', async () => {
  const result = await fetchChecks(' fake+key&value ', async (url, options) => {
    const request = new URL(url);
    assert.equal(request.origin + request.pathname, endpoint);
    assert.equal(request.searchParams.get('api_key'), 'fake+key&value');
    assert.equal(request.searchParams.size, 1);
    assert.equal(options.cache, 'no-store');
    return { ok: true, status: 200, json: async () => fixture };
  });
  assert.deepEqual(result, fixture.data);
});
test('reports missing key, authentication and network failures', async () => {
  await assert.rejects(fetchChecks(''), /API key/);
  await assert.rejects(fetchChecks('fake', async () => ({ ok: false, status: 407 })), /API key/);
  await assert.rejects(fetchChecks('fake', async () => { throw new TypeError('Failed to fetch'); }), /CORS/);
});
