import {
  database,
  initializeSession,
  getCurrentUser,
  isStaffUser,
  listReports,
  createReport,
  updateReportStatus,
  deleteReport,
  listAssistancePoints,
  createAssistancePoint,
  updateAssistancePoint,
  deleteAssistancePoint,
  canUpdateReport,
  canUpdateAssistancePoint,
  uploadAttachment,
  staffSignIn,
  staffSignOut,
  describeError
} from './report-store.js';

// --- Constants & Config ---
const PRACHINBURI_CENTER = [14.05, 101.38];
const STORAGE_KEY = 'phuengpha-flood-reports-v1';

const typeNames = {
  help: 'ขอความช่วยเหลือ',
  flood: 'รายงานน้ำท่วม',
  assistance: 'จุดช่วยเหลือ'
};

const categoryNames = {
  shelter: 'ศูนย์พักพิง / ปลอดภัย',
  food: 'อาหารและน้ำดื่ม',
  medical: 'การแพทย์ / ยา',
  transport: 'เรือ / ยานพาหนะ',
  other: 'อื่น ๆ'
};

const supportStatusNames = {
  available: 'มีของ / พร้อมรับรอง',
  unavailable: 'ปิดชั่วคราว',
  depleted: 'ของหมดแล้ว'
};

// --- State Variables ---
let reports = database ? [] : loadLocalReports();
let assistancePoints = [];
let currentFilter = 'all'; // 'all' | 'help' | 'flood' | 'done' | 'assistance'
let provinceGeometry = null;
let syncing = false;
let selectedReportPin = null;
let activeEventItem = null; // Currently open report or assistance point
let activeEventType = 'report'; // 'report' | 'assistance'
let photoFileToUpload = null;
let isPickingOnMap = false;

const deployedWeatherKey = import.meta.env.VITE_GOOGLE_WEATHER_API_KEY || '';
function getGistdaApiKey() {
  return (import.meta.env.VITE_GISTDA_API_KEY || localStorage.getItem('gistda_api_key') || '').trim();
}

// --- Map Initialization ---
const map = L.map('map', {
  zoomControl: true,
  minZoom: 7,
  maxZoom: 18
}).setView(PRACHINBURI_CENTER, 10);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap',
  maxZoom: 19
}).addTo(map);

const boundaryLayer = L.geoJSON(null, {
  style: {
    color: '#42b883',
    weight: 2.5,
    opacity: 0.95,
    fillColor: '#42b883',
    fillOpacity: 0.08
  }
}).addTo(map);

const pinLayer = L.layerGroup().addTo(map);
const reportsLayer = L.layerGroup().addTo(map);
const assistanceLayer = L.layerGroup().addTo(map);
const markersMap = new Map();

let gistdaFloodLayer = null;
let gistdaFloodLayerEnabled = false;

// --- Load Prachinburi GeoJSON Boundary ---
fetch(new URL('./province-prachinburi.geojson', import.meta.url))
  .then(res => {
    if (!res.ok) throw new Error('Cannot load province GeoJSON');
    return res.json();
  })
  .then(geo => {
    provinceGeometry = geo.type === 'Feature' ? geo.geometry : geo.features[0].geometry;
    boundaryLayer.addData(geo);
    map.fitBounds(boundaryLayer.getBounds(), { padding: [16, 16] });
    render();
  })
  .catch(() => {
    toast('โหลดขอบเขตจังหวัดไม่สำเร็จ โปรดเปิดผ่านเว็บเซิร์ฟเวอร์');
  });

// --- Point in Polygon Geometric Check ---
function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = ((yi > point[1]) !== (yj > point[1])) &&
      (point[0] < (xj - xi) * (point[1] - yi) / ((yj - yi) || Number.EPSILON) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function isInsideProvince(lat, lng) {
  if (!provinceGeometry) return true; // If geojson is still loading, allow pin or defer check
  const point = [lng, lat];
  const polygons = provinceGeometry.type === 'Polygon'
    ? [provinceGeometry.coordinates]
    : provinceGeometry.coordinates;
  return polygons.some(polygon =>
    pointInRing(point, polygon[0]) && !polygon.slice(1).some(hole => pointInRing(point, hole))
  );
}

// --- Marker Helper ---
function createMarkerIcon(item, kind) {
  let colorClass = 'urgent';
  let iconEmoji = '🆘';

  if (kind === 'report') {
    if (item.status === 'done') {
      colorClass = 'done';
      iconEmoji = '✓';
    } else if (item.type === 'flood') {
      colorClass = 'report'; // รายงานน้ำท่วม = สีน้ำเงิน
      iconEmoji = '🌊';
    } else {
      colorClass = 'urgent'; // ขอความช่วยเหลือ = สีแดง
      iconEmoji = '🆘';
    }
  } else {
    colorClass = 'support'; // จุดช่วยเหลือ = สีเขียว
    iconEmoji = '⌂';
  }

  const thumbHtml = item.attachmentPath
    ? `<img src="${cacheBustImage(item.attachmentPath, item.createdAt)}" alt="รูป" class="marker-avatar-thumb">`
    : `<span class="marker-inner-icon">${iconEmoji}</span>`;

  const pulseHtml = (kind === 'report' && item.status !== 'done')
    ? `<span class="marker-ring-pulse ${colorClass}"></span>`
    : (kind === 'assistance')
    ? `<span class="marker-ring-pulse support"></span>`
    : '';

  return L.divIcon({
    className: 'custom-radar-marker',
    html: `${pulseHtml}<div class="marker-ring ${colorClass}">${thumbHtml}</div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
    popupAnchor: [0, -18]
  });
}

// --- Map Click Handler (Popup 3 สี เมื่อกดที่ว่างบนแผนที่) ---
map.on('click', event => {
  const { lat, lng } = event.latlng;
  if (!isInsideProvince(lat, lng)) {
    toast('โปรดเลือกพิกัดภายในจังหวัดปราจีนบุรี');
    return;
  }

  // หากอยู่ในโหมดแตะเลือกตำแหน่งจากใน Modal ให้ปักหมุดแล้วเปิด Modal กลับมาทันที
  if (isPickingOnMap) {
    setReportLocation(lat, lng);
    isPickingOnMap = false;
    document.getElementById('report-modal').showModal();
    toast('เลือกตำแหน่งบนแผนที่เรียบร้อย');
    return;
  }

  // หากเป็นการกดบนที่ว่างของแผนที่ ให้แสดง Popup ปุ่ม 3 สี เพื่อส่งต่อไปหน้า Event / ฟอร์มแจ้งเหตุ
  const popupContainer = document.createElement('div');
  popupContainer.className = 'map-empty-click-popup';
  popupContainer.innerHTML = `
    <div class="empty-popup-header">
      <strong>📍 ปักหมุดแจ้งเหตุที่นี่</strong>
      <span class="empty-popup-coords">${lat.toFixed(4)}, ${lng.toFixed(4)}</span>
    </div>
    <div class="empty-popup-prompt">เลือกรายการที่ต้องการแจ้ง ณ จุดนี้:</div>
    <div class="empty-popup-actions">
      <button type="button" class="popup-btn popup-btn-urgent" data-type="help">
        <span>🆘</span> ขอความช่วยเหลือ (แดง)
      </button>
      <button type="button" class="popup-btn popup-btn-report" data-type="flood">
        <span>🌊</span> รายงานน้ำท่วม (น้ำเงิน)
      </button>
      <button type="button" class="popup-btn popup-btn-support" data-type="assistance">
        <span>⌂</span> จุดช่วยเหลือ / พักพิง (เขียว)
      </button>
    </div>
  `;

  popupContainer.querySelectorAll('.popup-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type;
      map.closePopup();
      openReportModalWithType(type, { lat, lng });
    });
  });

  L.popup({
    offset: [0, -6],
    maxWidth: 260,
    className: 'leaflet-dark-popup'
  })
    .setLatLng([lat, lng])
    .setContent(popupContainer)
    .openOn(map);
});

function setReportLocation(lat, lng) {
  selectedReportPin = { lat, lng };
  pinLayer.clearLayers();

  const tempMarker = L.marker([lat, lng], {
    icon: L.divIcon({
      className: 'custom-radar-marker',
      html: `<div class="marker-ring urgent"><span class="marker-inner-icon">📍</span></div>`,
      iconSize: [36, 36],
      iconAnchor: [18, 18]
    })
  }).addTo(pinLayer);

  document.getElementById('loc-pin-icon').textContent = '📍';
  document.getElementById('loc-status-text').textContent = 'ปักตำแหน่งใน จ.ปราจีนบุรีแล้ว';
  document.getElementById('loc-status-text').style.color = 'var(--color-done)';
  document.getElementById('loc-coords-text').textContent = `พิกัด: ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

// --- Render Feed and Map Markers ---
function render() {
  const pendingHelp = reports.filter(r => r.type === 'help' && r.status !== 'done').length;
  const floodCount = reports.filter(r => r.type === 'flood' && r.status !== 'done').length;
  const doneCount = reports.filter(r => r.status === 'done').length;
  const supportCount = assistancePoints.length;
  const totalCount = reports.length + assistancePoints.length;

  // Update Counters in Header & Stats Overlay
  document.getElementById('stat-urgent').textContent = pendingHelp;
  document.getElementById('stat-flood').textContent = floodCount;
  document.getElementById('stat-done').textContent = doneCount;
  document.getElementById('stat-support').textContent = supportCount;

  document.getElementById('filter-all-num').textContent = totalCount;
  document.getElementById('filter-help-num').textContent = pendingHelp;
  document.getElementById('filter-flood-num').textContent = floodCount;
  document.getElementById('filter-done-num').textContent = doneCount;
  document.getElementById('filter-support-num').textContent = supportCount;

  document.getElementById('feed-count-total').textContent = `${totalCount} รายการ`;
  document.getElementById('mobile-badge').textContent = totalCount;

  const fabUrgent = document.getElementById('fab-urgent-count');
  if (pendingHelp > 0) {
    fabUrgent.hidden = false;
    fabUrgent.textContent = pendingHelp;
  } else {
    fabUrgent.hidden = true;
  }

  // Update Active State on Stats Overlay Cards
  document.querySelectorAll('.stat-metric[data-stat-filter]').forEach(m => {
    m.classList.toggle('active', m.dataset.statFilter === currentFilter);
  });

  // Filter Items
  const feedList = document.getElementById('activity-list');
  feedList.replaceChildren();

  reportsLayer.clearLayers();
  assistanceLayer.clearLayers();
  markersMap.clear();

  let visibleCount = 0;

  // 1. Render Flood & Help Reports
  reports.forEach(report => {
    const isHelp = report.type === 'help';
    const isDone = report.status === 'done';

    let shouldShow = false;
    if (currentFilter === 'all') shouldShow = true;
    else if (currentFilter === 'help' && isHelp && !isDone) shouldShow = true;
    else if (currentFilter === 'flood' && !isHelp && !isDone) shouldShow = true;
    else if (currentFilter === 'done' && isDone) shouldShow = true;

    // Add marker to map
    if (isInsideProvince(report.lat, report.lng)) {
      const marker = L.marker([report.lat, report.lng], {
        icon: createMarkerIcon(report, 'report'),
        zIndexOffset: isHelp && !isDone ? 2000 : 1000
      });

      marker.bindPopup(`
        <div style="font-family:'IBM Plex Sans Thai',sans-serif; min-width:200px; padding:2px;">
          <strong style="color:${isDone ? '#94a3b8' : isHelp ? '#ef4444' : '#3b82f6'}; font-size:13px;">
            ${isDone ? '✓ ช่วยเหลือแล้ว' : isHelp ? '🆘 ขอความช่วยเหลือ' : '🌊 รายงานน้ำท่วม'}
          </strong>
          <p style="margin:6px 0 4px; font-size:12px; line-height:1.4;">${escapeHtml(report.description)}</p>
          <div style="font-size:11px; color:#64748b;">
            ${report.people ? `ผู้ประสบภัย ${report.people} คน · ` : ''}${relativeTime(report.createdAt)}
          </div>
        </div>
      `);

      marker.on('click', () => {
        openEventDialog(report, 'report');
      });

      marker.addTo(reportsLayer);
      markersMap.set(`report-${report.id}`, marker);
    }

    if (!shouldShow) return;
    visibleCount++;

    // Feed card
    const card = document.createElement('article');
    card.className = 'feed-card';
    card.setAttribute('role', 'button');
    card.tabIndex = 0;

    let badgeClass = 'badge-urgent';
    let badgeText = 'ขอความช่วยเหลือ';
    if (isDone) {
      badgeClass = 'badge-done';
      badgeText = 'ช่วยเหลือแล้ว';
    } else if (report.type === 'flood') {
      badgeClass = 'badge-report';
      badgeText = 'รายงานน้ำท่วม';
    }

    let thumbHtml = '';
    if (report.attachmentPath) {
      thumbHtml = `<img src="${cacheBustImage(report.attachmentPath, report.createdAt)}" alt="รูป" class="feed-card-thumb" loading="lazy">`;
    } else {
      const icon = isDone ? '✓' : isHelp ? '🆘' : '🌊';
      thumbHtml = `<div class="feed-card-icon-placeholder">${icon}</div>`;
    }

    card.innerHTML = `
      ${thumbHtml}
      <div class="feed-card-content">
        <div class="feed-card-top">
          <span class="feed-kind-tag">${isHelp ? 'เหตุฉุกเฉิน' : 'สถานการณ์น้ำ'}</span>
          <span class="badge ${badgeClass}">${badgeText}</span>
        </div>
        <p class="feed-card-desc">${escapeHtml(report.description)}</p>
        <div class="feed-card-meta">
          <span>${relativeTime(report.createdAt)}${report.people ? ` · ${report.people} คน` : ''}</span>
          <div class="card-actions-mini">
            <button type="button" class="btn-mini-action" data-focus="report-${report.id}">📍 แผนที่</button>
            ${report.contact ? `<a href="tel:${report.contact.replace(/[^+\d]/g, '')}" class="btn-mini-action">📞 โทร</a>` : ''}
          </div>
        </div>
      </div>
    `;

    card.addEventListener('click', event => {
      if (event.target.closest('button, a')) return;
      focusItemOnMap(report.lat, report.lng, `report-${report.id}`);
      openEventDialog(report, 'report');
    });

    const mapBtn = card.querySelector('[data-focus]');
    if (mapBtn) {
      mapBtn.addEventListener('click', e => {
        e.stopPropagation();
        focusItemOnMap(report.lat, report.lng, `report-${report.id}`);
        // Switch to map on mobile
        if (window.innerWidth <= 768) setMobileView('map');
      });
    }

    feedList.append(card);
  });

  // 2. Render Assistance Points
  if (currentFilter === 'all' || currentFilter === 'assistance') {
    assistancePoints.forEach(point => {
      visibleCount++;

      // Marker
      if (isInsideProvince(point.lat, point.lng)) {
        const marker = L.marker([point.lat, point.lng], {
          icon: createMarkerIcon(point, 'assistance'),
          zIndexOffset: 1200
        });

        marker.bindPopup(`
          <div style="font-family:'IBM Plex Sans Thai',sans-serif; min-width:200px; padding:2px;">
            <strong style="color:#42b883; font-size:13px;">⌂ ${escapeHtml(point.name)}</strong>
            <div style="font-size:11px; color:#42b883; margin:2px 0;">
              ${categoryNames[point.category] || 'จุดช่วยเหลือ'} · ${supportStatusNames[point.status] || ''}
            </div>
            <p style="margin:4px 0; font-size:12px; line-height:1.4;">${escapeHtml(point.description)}</p>
          </div>
        `);

        marker.on('click', () => {
          openEventDialog(point, 'assistance');
        });

        marker.addTo(assistanceLayer);
        markersMap.set(`point-${point.id}`, marker);
      }

      // Card
      const card = document.createElement('article');
      card.className = 'feed-card';
      card.setAttribute('role', 'button');
      card.tabIndex = 0;

      let thumbHtml = '';
      if (point.attachmentPath) {
        thumbHtml = `<img src="${cacheBustImage(point.attachmentPath, point.createdAt)}" alt="รูป" class="feed-card-thumb" loading="lazy">`;
      } else {
        thumbHtml = `<div class="feed-card-icon-placeholder">⌂</div>`;
      }

      card.innerHTML = `
        ${thumbHtml}
        <div class="feed-card-content">
          <div class="feed-card-top">
            <span class="feed-kind-tag">${categoryNames[point.category] || 'จุดช่วยเหลือ'}</span>
            <span class="badge badge-support">${supportStatusNames[point.status] || 'มีของ'}</span>
          </div>
          <strong style="font-size:13px; color:var(--text-main); margin-bottom:2px;">${escapeHtml(point.name)}</strong>
          <p class="feed-card-desc">${escapeHtml(point.description)}</p>
          <div class="feed-card-meta">
            <span>${relativeTime(point.createdAt)}</span>
            <div class="card-actions-mini">
              <button type="button" class="btn-mini-action" data-focus="point-${point.id}">📍 แผนที่</button>
            </div>
          </div>
        </div>
      `;

      card.addEventListener('click', event => {
        if (event.target.closest('button, a')) return;
        focusItemOnMap(point.lat, point.lng, `point-${point.id}`);
        openEventDialog(point, 'assistance');
      });

      const mapBtn = card.querySelector('[data-focus]');
      if (mapBtn) {
        mapBtn.addEventListener('click', e => {
          e.stopPropagation();
          focusItemOnMap(point.lat, point.lng, `point-${point.id}`);
          if (window.innerWidth <= 768) setMobileView('map');
        });
      }

      feedList.append(card);
    });
  }

  document.getElementById('empty-state').hidden = visibleCount > 0;
  document.getElementById('stats-time').textContent = `อัปเดตเมื่อ ${new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}`;
}

// --- Map Focus Helper ---
function focusItemOnMap(lat, lng, markerKey) {
  map.setView([lat, lng], 15, { animate: true });
  const marker = markersMap.get(markerKey);
  if (marker) {
    setTimeout(() => marker.openPopup(), 150);
  }
}

// --- Event Detail Dialog Logic ---
function openEventDialog(item, kind) {
  activeEventItem = item;
  activeEventType = kind;

  const dialog = document.getElementById('event-dialog');
  const imgContainer = document.getElementById('event-image-container');
  const img = document.getElementById('event-img');
  const statusBadge = document.getElementById('event-status-badge');
  const callRow = document.getElementById('event-call-row');
  const metaGrid = document.getElementById('event-meta-grid');
  const adminSection = document.getElementById('event-admin-section');
  const adminReportControls = document.getElementById('admin-report-controls');
  const adminSupportControls = document.getElementById('admin-support-controls');

  if (kind === 'report') {
    document.getElementById('event-eyebrow').textContent = item.type === 'help' ? 'เหตุฉุกเฉิน / ขอความช่วยเหลือ' : 'รายงานสถานการณ์น้ำท่วม';
    document.getElementById('event-title').textContent = typeNames[item.type];
    document.getElementById('event-description-text').textContent = item.description;

    const isDone = item.status === 'done';
    statusBadge.className = `badge ${isDone ? 'badge-done' : item.type === 'help' ? 'badge-urgent' : 'badge-warning'}`;
    statusBadge.textContent = isDone ? '✓ ช่วยเหลือแล้ว' : item.type === 'help' ? 'รอความช่วยเหลือ' : 'จุดน้ำท่วม';

    metaGrid.innerHTML = `
      <div>🕒 เวลาแจ้ง: ${formatDateTime(item.createdAt)} (${relativeTime(item.createdAt)})</div>
      <div>📍 พิกัด: ${Number(item.lat).toFixed(5)}, ${Number(item.lng).toFixed(5)}</div>
      ${item.people ? `<div>👥 จำนวนผู้ประสบภัย: <strong>${item.people} คน</strong></div>` : ''}
      ${item.helpedBy ? `<div>🤝 ผู้ให้ความช่วยเหลือ: <strong>${escapeHtml(item.helpedBy)}</strong></div>` : ''}
    `;

    if (item.contact) {
      callRow.hidden = false;
      document.getElementById('event-phone-link').href = `tel:${item.contact.replace(/[^+\d]/g, '')}`;
      document.getElementById('event-phone-display').textContent = item.contact;
    } else {
      callRow.hidden = true;
    }

    // Admin / Owner controls
    const canEdit = canUpdateReport(item);
    adminSection.hidden = !canEdit;
    adminReportControls.hidden = !canEdit;
    adminSupportControls.hidden = true;

    if (canEdit) {
      document.getElementById('admin-status-select').value = item.status;
      document.getElementById('admin-helped-by').value = item.helpedBy || '';
    }
  } else {
    // Assistance Point
    document.getElementById('event-eyebrow').textContent = 'ศูนย์พักพิงและจุดช่วยเหลือ';
    document.getElementById('event-title').textContent = item.name;
    document.getElementById('event-description-text').textContent = item.description;

    statusBadge.className = 'badge badge-support';
    statusBadge.textContent = supportStatusNames[item.status] || 'มีของ';

    metaGrid.innerHTML = `
      <div>🏷️ ประเภท: <strong>${categoryNames[item.category] || 'ทั่วไป'}</strong></div>
      <div>🕒 บันทึกเมื่อ: ${formatDateTime(item.createdAt)}</div>
      <div>📍 พิกัด: ${Number(item.lat).toFixed(5)}, ${Number(item.lng).toFixed(5)}</div>
    `;

    callRow.hidden = true;

    const canEdit = canUpdateAssistancePoint(item);
    adminSection.hidden = !canEdit;
    adminReportControls.hidden = true;
    adminSupportControls.hidden = !canEdit;

    if (canEdit) {
      document.getElementById('admin-support-name').value = item.name;
      document.getElementById('admin-support-status').value = item.status;
    }
  }

  // Image handling
  if (item.attachmentPath) {
    imgContainer.hidden = false;
    img.src = cacheBustImage(item.attachmentPath, item.createdAt);
  } else {
    imgContainer.hidden = true;
    img.src = '';
  }

  dialog.showModal();
}

// --- Admin Controls Handlers ---
document.getElementById('admin-save-status-btn').addEventListener('click', async () => {
  if (!activeEventItem || activeEventType !== 'report') return;
  const status = document.getElementById('admin-status-select').value;
  const helpedBy = document.getElementById('admin-helped-by').value.trim();
  const btn = document.getElementById('admin-save-status-btn');

  btn.disabled = true;
  try {
    if (database) {
      await updateReportStatus(activeEventItem, status, helpedBy);
      await syncReports();
    } else {
      activeEventItem.status = status;
      activeEventItem.helpedBy = helpedBy;
      saveLocalReports();
      render();
    }
    toast('อัปเดตสถานะสำเร็จ');
    document.getElementById('event-dialog').close();
  } catch (err) {
    toast(describeError(err));
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('admin-delete-report-btn').addEventListener('click', async () => {
  if (!activeEventItem || !confirm('ต้องการลบรายงานนี้ใช่หรือไม่?')) return;
  const btn = document.getElementById('admin-delete-report-btn');
  btn.disabled = true;
  try {
    if (database) {
      await deleteReport(activeEventItem);
      await syncReports();
    } else {
      reports = reports.filter(r => r.id !== activeEventItem.id);
      saveLocalReports();
      render();
    }
    toast('ลบรายงานเรียบร้อย');
    document.getElementById('event-dialog').close();
  } catch (err) {
    toast(describeError(err));
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('admin-save-support-btn').addEventListener('click', async () => {
  if (!activeEventItem || activeEventType !== 'assistance') return;
  const name = document.getElementById('admin-support-name').value.trim();
  const status = document.getElementById('admin-support-status').value;
  const btn = document.getElementById('admin-save-support-btn');

  if (!name) return toast('กรุณาระบุชื่อจุดช่วยเหลือ');

  btn.disabled = true;
  try {
    if (database) {
      await updateAssistancePoint(activeEventItem, { name, status });
      await syncAssistancePoints();
    }
    toast('อัปเดตจุดช่วยเหลือเรียบร้อย');
    document.getElementById('event-dialog').close();
  } catch (err) {
    toast(describeError(err));
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('admin-delete-support-btn').addEventListener('click', async () => {
  if (!activeEventItem || !confirm('ต้องการลบจุดช่วยเหลือนี้ใช่หรือไม่?')) return;
  const btn = document.getElementById('admin-delete-support-btn');
  btn.disabled = true;
  try {
    if (database) {
      await deleteAssistancePoint(activeEventItem);
      await syncAssistancePoints();
    }
    toast('ลบจุดช่วยเหลือเรียบร้อย');
    document.getElementById('event-dialog').close();
  } catch (err) {
    toast(describeError(err));
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('event-close-btn').addEventListener('click', () => {
  document.getElementById('event-dialog').close();
});

document.getElementById('event-view-map-btn').addEventListener('click', () => {
  if (activeEventItem) {
    document.getElementById('event-dialog').close();
    focusItemOnMap(activeEventItem.lat, activeEventItem.lng, `${activeEventType}-${activeEventItem.id}`);
    if (window.innerWidth <= 768) setMobileView('map');
  }
});

// --- Easy Reporting Form Modal Logic & Navigation Connections ---
let selectedType = 'help';

function selectReportType(type) {
  selectedType = type || 'help';
  document.querySelectorAll('.type-card').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.type === selectedType);
  });

  const isAssistance = selectedType === 'assistance';
  document.getElementById('assistance-fields').hidden = !isAssistance;
  const extraGrid = document.getElementById('report-extra-grid');
  if (extraGrid) extraGrid.hidden = isAssistance;
}

function openReportModalWithType(type, coords = null) {
  selectReportType(type || 'help');
  if (coords && coords.lat && coords.lng) {
    setReportLocation(coords.lat, coords.lng);
  }
  const modal = document.getElementById('report-modal');
  if (modal && !modal.open) {
    modal.showModal();
  }
}

// 3 Colored FAB Buttons:
// ขอความช่วยเหลือ (แดง), รายงานน้ำท่วม (น้ำเงิน), จุดช่วยเหลือ (เขียว)
document.querySelectorAll('.fab-btn[data-open-type]').forEach(btn => {
  btn.addEventListener('click', () => {
    const type = btn.dataset.openType;
    openReportModalWithType(type);
  });
});

// Stat Metric Cards in header banner: Click to filter corresponding events
document.querySelectorAll('.stat-metric[data-stat-filter]').forEach(card => {
  card.addEventListener('click', () => {
    const filter = card.dataset.statFilter;
    const chip = document.querySelector(`.filter-chip[data-filter="${filter}"]`);
    if (chip) chip.click();
  });
});

document.getElementById('report-modal-close').addEventListener('click', () => {
  document.getElementById('report-modal').close();
});

// Close dialog on clicking backdrop outside card
['report-modal', 'event-dialog', 'staff-modal'].forEach(id => {
  const dialog = document.getElementById(id);
  if (dialog) {
    dialog.addEventListener('click', event => {
      if (event.target === dialog) dialog.close();
    });
  }
});

// Type card selection
document.querySelectorAll('.type-card').forEach(btn => {
  btn.addEventListener('click', () => {
    selectReportType(btn.dataset.type);
  });
});

// Photo selection & preview
const photoInput = document.getElementById('report-photo-input');
const photoPreviewWrap = document.getElementById('photo-preview-wrap');
const photoPreviewImg = document.getElementById('photo-preview-img');
const removePhotoBtn = document.getElementById('remove-photo-btn');

photoInput.addEventListener('change', () => {
  const file = photoInput.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    toast('ไฟล์ภาพต้องมีขนาดไม่เกิน 5 MB');
    photoInput.value = '';
    return;
  }
  photoFileToUpload = file;
  photoPreviewImg.src = URL.createObjectURL(file);
  photoPreviewWrap.hidden = false;
});

removePhotoBtn.addEventListener('click', () => {
  photoFileToUpload = null;
  photoInput.value = '';
  photoPreviewWrap.hidden = true;
  photoPreviewImg.src = '';
});

// GPS button inside modal
document.getElementById('modal-gps-btn').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('อุปกรณ์นี้ไม่รองรับการระบุตำแหน่ง');
  const btn = document.getElementById('modal-gps-btn');
  btn.disabled = true;
  btn.textContent = '⏳ กำลังค้นหา GPS…';

  navigator.geolocation.getCurrentPosition(
    pos => {
      btn.disabled = false;
      btn.innerHTML = '<span>📍 ใช้ตำแหน่ง GPS ปัจจุบัน</span>';
      const { latitude, longitude } = pos.coords;
      if (!isInsideProvince(latitude, longitude)) {
        toast('ตำแหน่ง GPS อยู่นอกจังหวัดปราจีนบุรี');
        return;
      }
      setReportLocation(latitude, longitude);
      map.setView([latitude, longitude], 15);
      toast('ระบุตำแหน่ง GPS สำเร็จ');
    },
    err => {
      btn.disabled = false;
      btn.innerHTML = '<span>📍 ใช้ตำแหน่ง GPS ปัจจุบัน</span>';
      toast(err.code === 1 ? 'กรุณาอนุญาตให้เข้าถึงตำแหน่ง' : 'ระบุตำแหน่งไม่สำเร็จ ลองเลือกบนแผนที่');
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
  );
});

// Pick on map button inside modal
document.getElementById('modal-pick-map-btn').addEventListener('click', () => {
  isPickingOnMap = true;
  document.getElementById('report-modal').close();
  toast('แตะเลือกตำแหน่งเหตุการณ์บนแผนที่ได้เลย');
  if (window.innerWidth <= 768) setMobileView('map');
});

// Submit Report Form
document.getElementById('simple-report-form').addEventListener('submit', async event => {
  event.preventDefault();

  if (!selectedReportPin) {
    return toast('กรุณาเลือกตำแหน่งเหตุการณ์ (กดปุ่ม GPS หรือแตะบนแผนที่)');
  }

  const desc = document.getElementById('report-desc').value.trim();
  if (!desc) {
    return toast('กรุณากรอกรายละเอียดเหตุการณ์');
  }

  const submitBtn = document.getElementById('submit-report-btn');
  const submitText = document.getElementById('submit-btn-text');
  const spinner = document.getElementById('submit-spinner');

  submitBtn.disabled = true;
  submitText.textContent = 'กำลังส่งข้อมูล…';
  spinner.hidden = false;

  try {
    let attachmentPath = '';
    if (photoFileToUpload && database) {
      attachmentPath = await uploadAttachment(
        photoFileToUpload,
        selectedType === 'assistance' ? 'assistance' : 'reports'
      );
    }

    if (selectedType === 'assistance') {
      const name = document.getElementById('point-name').value.trim();
      if (!name) throw new Error('กรุณาระบุชื่อจุดช่วยเหลือ / ศูนย์พักพิง');

      const pointData = {
        name,
        category: document.getElementById('point-category').value,
        status: document.getElementById('point-status').value,
        description: desc,
        lat: selectedReportPin.lat,
        lng: selectedReportPin.lng,
        attachmentPath
      };

      if (!database) throw new Error('จุดช่วยเหลือต้องใช้ฐานข้อมูลกลาง กรุณาตั้งค่า Supabase');
      await createAssistancePoint(pointData);
      await syncAssistancePoints();
      toast('บันทึกจุดช่วยเหลือสำเร็จ');
    } else {
      const peopleVal = Number(document.getElementById('report-people').value);
      const contactVal = document.getElementById('report-contact').value.trim();

      if (contactVal && !/^[+0-9 ()-]{6,20}$/.test(contactVal)) {
        throw new Error('กรุณาตรวจสอบรูปแบบเบอร์ติดต่อ');
      }

      const reportData = {
        id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
        type: selectedType,
        description: desc,
        contact: contactVal,
        people: peopleVal > 0 ? peopleVal : null,
        lat: selectedReportPin.lat,
        lng: selectedReportPin.lng,
        status: 'pending',
        createdAt: new Date().toISOString(),
        attachmentPath
      };

      if (database) {
        await createReport(reportData);
        await syncReports();
      } else {
        reports.unshift(reportData);
        saveLocalReports();
        render();
      }
      toast('ส่งรายงานเหตุการณ์เรียบร้อย');
    }

    // Reset Form & Pin
    document.getElementById('simple-report-form').reset();
    photoFileToUpload = null;
    photoPreviewWrap.hidden = true;
    selectedReportPin = null;
    pinLayer.clearLayers();
    document.getElementById('loc-status-text').textContent = 'ยังไม่ได้เลือกตำแหน่ง';
    document.getElementById('loc-status-text').style.color = 'var(--text-main)';
    document.getElementById('loc-coords-text').textContent = 'กรุณากดปุ่ม GPS หรือแตะบนแผนที่';

    document.getElementById('report-modal').close();

    // Pan to reported location
    if (selectedReportPin) {
      map.setView([selectedReportPin.lat, selectedReportPin.lng], 15);
    }
  } catch (err) {
    toast(describeError(err));
  } finally {
    submitBtn.disabled = false;
    submitText.textContent = '🚀 ส่งข้อมูลทันที';
    spinner.hidden = true;
  }
});

// --- Filter Chips Click Handlers ---
document.querySelectorAll('.filter-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    currentFilter = chip.dataset.filter;
    render();
  });
});

// --- Mobile Tab Switcher ---
function setMobileView(view) {
  document.body.dataset.mobileView = view;
  document.getElementById('tab-map-btn').classList.toggle('active', view === 'map');
  document.getElementById('tab-list-btn').classList.toggle('active', view === 'list');
  if (view === 'map') {
    requestAnimationFrame(() => map.invalidateSize());
  }
}

document.getElementById('tab-map-btn').addEventListener('click', () => setMobileView('map'));
document.getElementById('tab-list-btn').addEventListener('click', () => setMobileView('list'));

// Set default mobile view
if (window.innerWidth <= 768) {
  setMobileView('map');
}

// --- Map Tool Buttons ---
document.getElementById('locate-me-btn').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('อุปกรณ์นี้ไม่รองรับการระบุตำแหน่ง');
  navigator.geolocation.getCurrentPosition(
    pos => {
      const { latitude, longitude } = pos.coords;
      map.setView([latitude, longitude], 15);
      L.circleMarker([latitude, longitude], {
        radius: 8,
        color: '#ffffff',
        weight: 2,
        fillColor: '#3b82f6',
        fillOpacity: 0.9
      }).addTo(map).bindPopup('ตำแหน่งของคุณ').openPopup();
    },
    () => toast('ไม่สามารถค้นหาตำแหน่ง GPS ของคุณได้')
  );
});

// GISTDA Layer Toggle
document.getElementById('gistda-layer-btn').addEventListener('click', () => {
  setGistdaFloodLayer(!gistdaFloodLayerEnabled);
});

function setGistdaFloodLayer(enabled) {
  const dot = document.getElementById('gistda-status-dot');
  const activeKey = getGistdaApiKey();
  if (!activeKey) {
    toast('ยังไม่ได้ระบุ GISTDA API key');
    return;
  }
  if (!gistdaFloodLayer) {
    const tileUrl = `https://api-gateway.gistda.or.th/api/2.0/resources/maps/flood/1day/tms/{z}/{x}/{y}?api_key=${encodeURIComponent(activeKey)}`;
    gistdaFloodLayer = L.tileLayer(tileUrl, {
      opacity: 0.65,
      maxZoom: 18,
      attribution: 'ข้อมูลน้ำท่วม © GISTDA'
    });
    gistdaFloodLayer.on('tileerror', () => {
      dot.classList.remove('active');
      toast('ไม่สามารถโหลดชั้นข้อมูล GISTDA ได้');
    });
  }

  gistdaFloodLayerEnabled = enabled;
  if (enabled) {
    gistdaFloodLayer.addTo(map);
    dot.classList.add('active');
    toast('เปิดชั้นข้อมูลน้ำท่วม GISTDA แล้ว');

    // Fetch latest flood-check timestamp from GISTDA Dragonfly
    fetch(`https://api-gateway.gistda.or.th/api/2.0/resources/dragonfly/flood-checks?api_key=${encodeURIComponent(activeKey)}`)
      .then(r => r.json())
      .then(payload => {
        if (Array.isArray(payload?.data)) {
          const flood = payload.data.find(d => d.servicename === 'flooding') || payload.data[0];
          if (flood?.datetime) {
            toast(`🛰️ ดาวเทียม GISTDA อัปเดตล่าสุด: ${flood.datetime}`);
          }
        }
      })
      .catch(() => {});
  } else {
    map.removeLayer(gistdaFloodLayer);
    dot.classList.remove('active');
    toast('ปิดชั้นข้อมูลน้ำท่วม GISTDA');
  }
}

// --- Theme Toggle ---
document.getElementById('theme-toggle').addEventListener('click', () => {
  const current = document.documentElement.dataset.theme;
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('prachin-theme', next);
  document.querySelector('.theme-icon').textContent = next === 'dark' ? '☾' : '☀';
  document.querySelector('meta[name="theme-color"]').content = next === 'dark' ? '#10171e' : '#ffffff';
});

// --- Staff Login Modal & Handlers ---
document.getElementById('staff-login-btn').addEventListener('click', () => {
  if (isStaffUser()) {
    // Toggle ribbon
    const ribbon = document.getElementById('staff-ribbon');
    ribbon.hidden = !ribbon.hidden;
  } else {
    document.getElementById('staff-modal').showModal();
  }
});

document.getElementById('staff-modal-close').addEventListener('click', () => {
  document.getElementById('staff-modal').close();
});

document.getElementById('staff-login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const btn = document.getElementById('staff-submit-btn');
  btn.disabled = true;
  try {
    await staffSignIn(
      document.getElementById('staff-email').value.trim(),
      document.getElementById('staff-password').value
    );
    document.getElementById('staff-login-form').reset();
    document.getElementById('staff-modal').close();
    updateStaffUi();
    await syncReports();
    toast('เข้าสู่ระบบเจ้าหน้าที่สำเร็จ');
  } catch (err) {
    toast(describeError(err));
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('staff-logout-btn').addEventListener('click', async () => {
  try {
    await staffSignOut();
    updateStaffUi();
    toast('ออกจากระบบแล้ว');
  } catch (err) {
    toast(describeError(err));
  }
});

document.getElementById('staff-refresh-btn').addEventListener('click', async () => {
  await syncReports();
  await syncAssistancePoints();
  toast('รีเฟรชข้อมูลเรียบร้อย');
});

function updateStaffUi() {
  const staff = isStaffUser();
  const user = getCurrentUser();
  const ribbon = document.getElementById('staff-ribbon');
  const btnLabel = document.getElementById('staff-btn-label');

  ribbon.hidden = !staff;
  if (staff && user) {
    btnLabel.textContent = user.app_metadata?.role === 'admin' ? 'ผู้ดูแล' : 'เจ้าหน้าที่';
    document.getElementById('staff-role-text').textContent = `สิทธิ์ ${user.app_metadata?.role} (${user.email || ''})`;
  } else {
    btnLabel.textContent = 'เจ้าหน้าที่';
  }
}

// --- Sync Functions ---
async function syncReports() {
  if (!database || syncing) return;
  syncing = true;
  try {
    reports = await listReports();
    render();
  } catch (err) {
    console.error('Sync reports failed', err);
  } finally {
    syncing = false;
  }
}

async function syncAssistancePoints() {
  if (!database) return;
  try {
    assistancePoints = await listAssistancePoints();
    render();
  } catch (err) {
    console.error('Sync assistance points failed', err);
  }
}

// --- Weather Data ---
function loadWeather() {
  if (!deployedWeatherKey) {
    document.getElementById('weather-summary').textContent = 'ปราจีนบุรี (ฝนประปราย)';
    return;
  }
  const url = new URL('https://weather.googleapis.com/v1/currentConditions:lookup');
  url.searchParams.set('key', deployedWeatherKey);
  url.searchParams.set('location.latitude', PRACHINBURI_CENTER[0]);
  url.searchParams.set('location.longitude', PRACHINBURI_CENTER[1]);

  fetch(url)
    .then(r => r.json())
    .then(data => {
      const temp = data.temperature?.degrees != null ? `${Math.round(data.temperature.degrees)}°C` : '';
      const text = data.weatherCondition?.description?.text || 'มีเมฆมาก';
      document.getElementById('weather-summary').textContent = `${text} ${temp}`;
    })
    .catch(() => {
      document.getElementById('weather-summary').textContent = 'ปราจีนบุรี';
    });
}

// --- Local Storage Fallback ---
function loadLocalReports() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function saveLocalReports() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(reports));
}

// --- Utility Functions ---
function escapeHtml(val) {
  if (!val) return '';
  const span = document.createElement('span');
  span.textContent = val;
  return span.innerHTML;
}

function relativeTime(iso) {
  if (!iso) return '';
  const diffMin = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (diffMin < 1) return 'เมื่อสักครู่';
  if (diffMin < 60) return `${diffMin} นาทีที่แล้ว`;
  const hours = Math.floor(diffMin / 60);
  if (hours < 24) return `${hours} ชม.ที่แล้ว`;
  return `${Math.floor(hours / 24)} วันที่แล้ว`;
}

function formatDateTime(iso) {
  if (!iso) return 'ไม่ทราบเวลา';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'ไม่ทราบเวลา';
  return new Intl.DateTimeFormat('th-TH', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Bangkok'
  }).format(date);
}

function cacheBustImage(path, timestamp) {
  if (!path) return '';
  try {
    const url = new URL(path);
    url.searchParams.set('v', timestamp ? new Date(timestamp).getTime().toString() : Date.now().toString());
    return url.toString();
  } catch {
    return path;
  }
}

let toastTimer = null;
function toast(msg) {
  const node = document.getElementById('toast');
  node.textContent = msg;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 3200);
}

function updateClock() {
  document.getElementById('clock').textContent = new Intl.DateTimeFormat('th-TH', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Bangkok'
  }).format(new Date());
}

// --- Initialization ---
async function initApp() {
  updateClock();
  setInterval(updateClock, 60000);

  if (database) {
    try {
      await initializeSession();
      updateStaffUi();
      await syncReports();
      await syncAssistancePoints();
    } catch (err) {
      console.error('Init session error', err);
    }

    // 30s auto background refresh
    setInterval(() => {
      if (!document.hidden) {
        syncReports();
        syncAssistancePoints();
      }
    }, 30000);

    window.addEventListener('focus', () => {
      syncReports();
      syncAssistancePoints();
    });
  } else {
    render();
  }

  loadWeather();
}

initApp();
