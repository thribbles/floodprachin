# น้ำท่วมปราจีน69 — แจ้งเหตุและช่วยเหลือ

น้ำท่วมปราจีน69 เป็นเว็บแอปภาษาไทยสำหรับปักหมุดรายงานเหตุ ขอความช่วยเหลือ และติดตามสถานะในจังหวัดปราจีนบุรี

เว็บ: https://phuengpha-flood.vercel.app

Vercel: `thribbles-projects/phuengpha-flood` · Supabase: `phuengpha-flood-db` (`gvisknrxegtdwxvnwqou`) · Region Singapore · Free plan

## เปิดใช้งาน

ใช้ Node.js กับ Vite (แทน Python static server เดิม) ดึงค่าที่เชื่อมผ่าน Vercel หรือคัดลอก `.env.example` เป็น `.env.local` แล้วกำหนด URL และ publishable key

```powershell
npm ci
npm run dev
```

จากนั้นเปิด http://localhost:8000 ในเบราว์เซอร์ อนุญาตตำแหน่ง GPS เมื่อเว็บขอใช้งาน; GPS บนโทรศัพท์ต้องเปิดเว็บผ่าน HTTPS (ยกเว้น localhost)

## ความสามารถ

- แสดงแผนที่ OpenStreetMap และขอบเขตจังหวัดปราจีนบุรี
- ปักตำแหน่งด้วย GPS หรือแตะจุดบนแผนที่ โดยรับเฉพาะพิกัดภายในขอบเขตจังหวัด
- บันทึกรายงานน้ำท่วม/ขอความช่วยเหลือ รายละเอียด เบอร์ติดต่อ และจำนวนผู้ประสบภัย
- แสดงหมุดและรายการรายงาน พร้อมทำเครื่องหมายช่วยเหลือแล้ว
- เมื่อกำหนด Supabase จะอ่านและเขียนฐานข้อมูลกลาง โดยรีเฟรชทุก 30 วินาทีขณะเปิดหน้าเว็บ; ปุ่มรีเฟรชใช้ดึงข้อมูลทันที
- หากยังไม่กำหนด Supabase จะทำงานในโหมด localStorage และแสดงสถานะอย่างชัดเจน; รายงานเก่าในเครื่องไม่ถูกอัปโหลดอัตโนมัติ
- รองรับการตั้งค่า Google Weather API key เพื่ออ่านสภาพอากาศปัจจุบัน
- แสดงสถานะ GISTDA Dragonfly จาก `https://api-gateway.gistda.or.th/api/2.0/resources/dragonfly/flood-checks` โดยใช้ API key ที่ลงทะเบียนไว้

## การเชื่อมต่อ GISTDA

ปุ่ม “สถานะข้อมูล GISTDA” อ่าน `status`, `data[].servicename`, `source` และ `datetime` จาก Flood Check แล้วแสดงเวลาอัปเดตตามผู้ให้บริการ โดยคงวันที่ พ.ศ. ตามต้นฉบับ Endpoint นี้ไม่ได้ส่ง geometry หรือสถานการณ์น้ำท่วมเฉพาะพิกัด จึงไม่ใช้วาดขอบเขตน้ำท่วมหรือสรุปว่าปราจีนบุรีน้ำท่วม/ไม่ท่วม

การเรียกจริงโดยไม่ใส่คีย์ตอบกลับ HTTP 407 Authentication Required การส่งคีย์ใช้ query parameter `api_key` ตามรูปแบบ GISTDA API Gateway ที่เผยแพร่ใน https://data.go.th/dataset/disasters-03 แต่ยังต้องยืนยันการตอบกลับสำเร็จด้วยคีย์ที่มีสิทธิ์ Dragonfly รวมถึงตรวจสอบ CORS บนเว็บไซต์ที่จะใช้งานจริง

เลิกใช้ URL WMS เดิมที่ยังไม่ได้ยืนยันแล้ว การแสดงพื้นที่น้ำท่วมบนแผนที่ยังต้องมี endpoint ของ WMS/WMTS/GeoJSON พร้อมชื่อ layer ที่ถูกต้อง

ทดสอบตัวอ่าน response และการจัดการ error ด้วย `node --test gistda-client.test.cjs` (ข้อมูลตัวอย่างจากภาพ ไม่ใช่สถานการณ์สด)

## ฐานข้อมูลและสิทธิ์

- `flood_reports`: รายละเอียดและพิกัดที่เปิดให้อ่านร่วมกัน; เจ้าของรายงานหรือเจ้าหน้าที่แก้ไขเฉพาะสถานะได้
- `report_contacts`: เบอร์โทร อ่านได้เฉพาะเจ้าของรายงานและเจ้าหน้าที่
- `province_boundaries`: ขอบเขตจังหวัดรหัส 25 ใช้ PostGIS ตรวจพิกัดซ้ำบนฐานข้อมูล
- ทุกตารางเปิด RLS และกำหนด GRANT เฉพาะที่ต้องใช้
- `submit_flood_report` บันทึกรายงานและเบอร์โทรใน transaction เดียว ใช้ SECURITY INVOKER เพื่อให้ RLS มีผล
- ผู้แจ้งเหตุใช้ Supabase Anonymous Sign-ins: ต้องเปิดที่ Authentication → Sign In / Providers → Anonymous Sign-ins
- บัญชีเจ้าหน้าที่ต้องสร้างใน Supabase Auth และกำหนด `app_metadata.role` เป็น `rescuer` หรือ `admin` ผ่านเครื่องมือผู้ดูแลเท่านั้น; `user_metadata` ไม่ให้สิทธิ์
- หน้าเว็บใช้เฉพาะ `VITE_SUPABASE_URL` และ `VITE_SUPABASE_PUBLISHABLE_KEY` ไม่มี secret/service_role key ใน client bundle

## ทดสอบและ deploy

```powershell
npm test
npm run build
node --env-file=.env.local scripts/db-verify.cjs
npx vercel deploy --prod
```

การทดสอบฐานข้อมูลใช้ transaction แล้ว rollback ข้อมูลทดสอบทั้งหมด ตรวจการปฏิเสธพิกัดนอกจังหวัด ความเป็นเจ้าของ การซ่อนเบอร์โทร และสิทธิ์เจ้าหน้าที่ ส่วน `scripts/db-apply.cjs` ใช้สร้าง schema บนโปรเจกต์ใหม่เพียงครั้งเดียวและหยุดหากพบตารางเดิมแล้ว

ไฟล์ `.env.local` ที่ดึงจาก Vercel มีข้อมูลลับ ต้องเก็บในเครื่องเท่านั้น มี `.gitignore` และ `.vercelignore` ป้องกันการอัปโหลด คีย์ GISTDA/Google ยังตั้งค่าแยกในเบราว์เซอร์

ขอบเขต `province-prachinburi.geojson` มาจาก OpenGISData-Thailand (ชั้นข้อมูลขอบเขตจังหวัด); ตรวจเขตซ้ำทั้งตอนปักหมุดและก่อนแสดงรายงาน
