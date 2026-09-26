import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
export const database = url && key ? createClient(url, key) : null;
let currentUser = null;
let signingIn = null;

export async function initializeSession() {
  if (!database) return;
  const { data, error } = await database.auth.getSession();
  if (error) throw error;
  let session = data.session;
  if (session?.user?.email) {
    const refreshed = await database.auth.refreshSession();
    if (!refreshed.error && refreshed.data.session) session = refreshed.data.session;
  }
  currentUser = session?.user || null;
  database.auth.onAuthStateChange((_event, session) => { currentUser = session?.user || null; });
}

export function getCurrentUser() { return currentUser; }
export function isStaffUser() {
  if (!currentUser) return false;
  const role = currentUser.app_metadata?.role || currentUser.user_metadata?.role;
  return Boolean(
    ['rescuer', 'admin', 'staff'].includes(role) ||
    (currentUser.email && !currentUser.is_anonymous)
  );
}

async function ensureUser() {
  if (currentUser) return currentUser;
  if (!signingIn) {
    signingIn = database.auth.signInAnonymously().catch(err => {
      console.warn('Anonymous sign-in not enabled in Supabase, proceeding as guest:', err?.message);
      return { data: { user: null }, error: null };
    }).finally(() => {
      signingIn = null;
    });
  }
  try {
    const { data } = await signingIn;
    currentUser = data?.user || null;
  } catch {
    currentUser = null;
  }
  return currentUser;
}

export function canUpdateReport(report) {
  if (!database) return true;
  if (!currentUser) return false;
  const role = currentUser.app_metadata?.role || currentUser.user_metadata?.role;
  return Boolean(
    currentUser.id === report.ownerId ||
    ['rescuer', 'admin', 'staff'].includes(role) ||
    (currentUser.email && !currentUser.is_anonymous)
  );
}

export async function listReports() {
  const rows = [];
  // Range pagination prevents the API's default row limit from hiding reports.
  for (let from = 0; ; from += 500) {
    const { data, error } = await database.from('flood_reports')
      .select('id,type,description,people,latitude,longitude,status,helped_by,created_at,owner_id,attachment_path,report_contacts(phone)')
      .order('created_at', { ascending: false }).order('id').range(from, from + 499);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 500) break;
  }
  return rows.map(row => {
    const contactPhone = Array.isArray(row.report_contacts) ? row.report_contacts[0]?.phone : row.report_contacts?.phone;
    return {
      id: row.id, type: row.type, description: row.description, people: row.people,
      lat: row.latitude, lng: row.longitude, status: row.status, helpedBy: row.helped_by || '',
      createdAt: row.created_at, ownerId: row.owner_id,
      contact: contactPhone || '', attachmentPath: row.attachment_path || ''
    };
  });
}

export async function createReport(report) {
  if (database) await ensureUser();
  const { data, error } = await database.rpc('submit_flood_report', {
    p_type: report.type, p_description: report.description, p_latitude: report.lat, p_longitude: report.lng,
    p_people: report.people, p_phone: report.contact || null, p_attachment_path: report.attachmentPath || null
  });
  if (error) throw error;
  return data;
}

export async function completeReport(report) {
  return updateReportStatus(report, 'done', report.helpedBy || '');
}

export async function updateReportStatus(report, status, helpedBy = '') {
  if (!database) {
    report.status = status;
    report.helpedBy = status === 'done' ? (helpedBy.trim() || null) : null;
    return;
  }
  const payload = { status, helped_by: status === 'done' ? (helpedBy.trim() || null) : null };
  const { data, error } = await database.from('flood_reports').update(payload)
    .eq('id', report.id).select('id');
  if (error) throw error;
  if (!data.length) throw new Error('สถานะเปลี่ยนไปแล้ว หรือบัญชีนี้ไม่มีสิทธิ์แก้ไขรายงาน');
}

export async function updateReport(report, changes) {
  if (!database) {
    Object.assign(report, changes);
    return;
  }
  const allowed = new Set(['type','description','people','status','helpedBy','attachmentPath']);
  const invalidKeys = Object.keys(changes).filter(k => !allowed.has(k));
  if (invalidKeys.length > 0) {
    throw new Error(`ไม่สามารถอัปเดตฟิลด์ต่อไปนี้: ${invalidKeys.join(', ')}`);
  }
  const filteredChanges = Object.fromEntries(Object.entries(changes).filter(([k]) => allowed.has(k)));
  const { data, error } = await database.from('flood_reports').update(filteredChanges).eq('id', report.id).select('id');
  if (error) throw error;
  if (!data.length) throw new Error('แก้ไขไม่สำเร็จ หรือบัญชีนี้ไม่มีสิทธิ์แก้ไขรายงาน');
}

export async function deleteReport(report) {
  if (!database) {
    // Offline: only allow deletion of local reports (no ownerId)
    if (report.ownerId) {
      throw new Error('ไม่สามารถลบรายงานที่ซิงค์แล้วได้เมื่อออฟไลน์');
    }
    // Remove from local storage
    const reports = loadLocalReports();
    const filtered = reports.filter(r => r.id !== report.id);
    saveLocalReports(filtered);
    return;
  }
  const { error } = await database.from('flood_reports').delete().eq('id', report.id);
  if (error) throw error;
}

export async function listAssistancePoints() {
  if (!database) return [];
  const { data, error } = await database.from('assistance_points')
    .select('id,name,category,description,latitude,longitude,status,created_at,owner_id,attachment_path')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data.map(row => ({ id: row.id, name: row.name, category: row.category, description: row.description,
    lat: row.latitude, lng: row.longitude, status: row.status, createdAt: row.created_at, ownerId: row.owner_id, attachmentPath: row.attachment_path || '' }));
}

export async function createAssistancePoint(point) {
  if (database) await ensureUser();
  const { data, error } = await database.from('assistance_points').insert({
    name: point.name, category: point.category, description: point.description, status: point.status || 'available',
    latitude: point.lat, longitude: point.lng, attachment_path: point.attachmentPath || null,
    owner_id: currentUser?.id || null
  }).select('id').single();
  if (error) throw error;
  return data.id;
}

export async function updateAssistancePoint(point, changes) {
  if (!database) {
    Object.assign(point, changes);
    return;
  }
  const { data, error } = await database.from('assistance_points').update(changes).eq('id', point.id).select('id');
  if (error) throw error;
  if (!data.length) throw new Error('แก้ไขไม่สำเร็จ หรือบัญชีนี้ไม่มีสิทธิ์แก้ไขจุดช่วยเหลือ');
}

export async function deleteAssistancePoint(point) {
  if (!database) {
    // Offline: only allow deletion of local assistance points (none exist)
    if (point.ownerId) {
      throw new Error('ไม่สามารถลบจุดช่วยเหลือที่ซิงค์แล้วได้เมื่อออฟไลน์');
    }
    // No local storage for assistance points; nothing to delete
    return;
  }
  const { error } = await database.from('assistance_points').delete().eq('id', point.id);
  if (error) throw error;
}

export async function uploadAttachment(file, folder) {
  if (!file) return '';
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('แนบได้เฉพาะไฟล์ JPG, PNG หรือ WebP');
  if (file.size > 5 * 1024 * 1024) throw new Error('รูปภาพต้องมีขนาดไม่เกิน 5 MB');
  if (database) await ensureUser();
  const extension = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
  const path = `${folder}/${crypto.randomUUID()}.${extension}`;
  const { error } = await database.storage.from('flood-attachments').upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw error;
  const { data } = database.storage.from('flood-attachments').getPublicUrl(path);
  return data.publicUrl;
}

export function canUpdateAssistancePoint(point) {
  if (!database) return true;
  if (!currentUser) return false;
  const role = currentUser.app_metadata?.role || currentUser.user_metadata?.role;
  return Boolean(
    currentUser.id === point.ownerId ||
    ['rescuer', 'admin', 'staff'].includes(role) ||
    (currentUser.email && !currentUser.is_anonymous)
  );
}

export async function staffSignIn(email, password) {
  if (!database) {
    currentUser = {
      id: 'local-staff-admin',
      email,
      app_metadata: { role: 'admin' },
      user_metadata: { role: 'admin', name: 'เจ้าหน้าที่ท้องถิ่น' }
    };
    return;
  }
  const { data, error } = await database.auth.signInWithPassword({ email, password });
  if (error) throw error;
  const refreshed = await database.auth.refreshSession();
  currentUser = refreshed.data.session?.user || data.user;
  const role = currentUser?.app_metadata?.role || currentUser?.user_metadata?.role;
  if (role && !['rescuer', 'admin', 'staff'].includes(role) && !currentUser.email) {
    await database.auth.signOut({ scope: 'local' });
    currentUser = null;
    throw new Error('บัญชีนี้ยังไม่มีสิทธิ์เจ้าหน้าที่ กรุณาติดต่อผู้ดูแลระบบ');
  }
}

export async function staffSignOut() {
  try {
    const { error } = await database.auth.signOut({ scope: 'local' });
    if (error) throw error;
  } finally {
    currentUser = null;
  }
}

export function describeError(error) {
  if (error?.message?.includes('outside_prachinburi')) return 'ฐานข้อมูลปฏิเสธพิกัดนอกจังหวัดปราจีนบุรี';
  if (error?.message?.includes('Anonymous sign-ins are disabled')) return 'ยังไม่ได้เปิด Anonymous Sign-ins ใน Supabase';
  if (error?.code === '42501') return 'บัญชีนี้ไม่มีสิทธิ์ทำรายการ';
  if (error?.message?.includes('Failed to fetch')) return 'เชื่อมต่อฐานข้อมูลไม่ได้ กรุณาลองใหม่';
  return error?.message || 'บันทึกไม่สำเร็จ กรุณาลองใหม่';
}
