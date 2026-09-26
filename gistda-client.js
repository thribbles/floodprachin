(function (root) {
  const endpoint = 'https://api-gateway.gistda.or.th/api/2.0/resources/dragonfly/flood-checks';

  function parseChecks(payload) {
    if ([401, 403, 407].includes(Number(payload?.status))) {
      throw new Error('กรุณาตรวจสอบ API key และสิทธิ์ใช้งาน Dragonfly');
    }
    if (Number(payload?.status) !== 200 || !Array.isArray(payload.data)) {
      throw new Error('รูปแบบข้อมูล Flood Check ไม่ถูกต้อง');
    }
    return payload.data.map(row => {
      if (!row || !['servicename', 'source', 'datetime'].every(key => typeof row[key] === 'string' && row[key].trim())) {
        throw new Error('ข้อมูลบริการหรือเวลาอัปเดตไม่ครบถ้วน');
      }
      // Preserve provider timestamps: Thai Buddhist-era dates are not ISO dates.
      return { servicename: row.servicename, source: row.source, datetime: row.datetime };
    });
  }

  async function fetchChecks(apiKey, fetcher = fetch) {
    if (!apiKey?.trim()) throw new Error('เพิ่ม GISTDA API key ก่อนตรวจสอบข้อมูล');
    const url = new URL(endpoint);
    // GISTDA Gateway documents api_key as a query parameter.
    url.searchParams.set('api_key', apiKey.trim());
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetcher(url.toString(), { signal: controller.signal, cache: 'no-store', referrerPolicy: 'no-referrer' });
      if ([401, 403, 407].includes(response.status)) throw new Error('กรุณาตรวจสอบ API key และสิทธิ์ใช้งาน Dragonfly');
      if (!response.ok) throw new Error(`บริการ GISTDA ตอบกลับ HTTP ${response.status}`);
      return parseChecks(await response.json());
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('บริการ GISTDA ใช้เวลาตอบกลับนานเกินไป ลองใหม่อีกครั้ง');
      if (error instanceof TypeError) throw new Error('เชื่อมต่อ GISTDA ไม่สำเร็จ โปรดตรวจสอบเครือข่ายหรือข้อจำกัด CORS');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  const client = { endpoint, parseChecks, fetchChecks };
  // Expose the client in both CommonJS (tests/build tooling) and browser globals
  // (the Vite bundle wraps this file as CommonJS during production builds).
  if (typeof module !== 'undefined' && module.exports) module.exports = client;
  root.GistdaClient = client;
})(globalThis);
