import {
  database,
  initializeSession,
  getCurrentUser,
  isStaffUser,
  listReports,
  createReport,
  updateReport,
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

const PRACHINBURI_DISTRICTS = [
  { name: 'อ.เมืองปราจีนบุรี', lat: 14.05, lng: 101.37 },
  { name: 'อ.กบินทร์บุรี', lat: 13.98, lng: 101.72 },
  { name: 'อ.บ้านสร้าง', lat: 13.99, lng: 101.21 },
  { name: 'อ.ศรีมหาโพธิ', lat: 13.88, lng: 101.51 },
  { name: 'อ.ประจันตคาม', lat: 14.12, lng: 101.55 },
  { name: 'อ.นาดี', lat: 14.14, lng: 101.99 },
  { name: 'อ.ศรีมโหสถ', lat: 13.86, lng: 101.42 }
];

const typeNames = {
  help: 'ขอความช่วยเหลือ',
  flood: 'รายงานน้ำท่วม',
  assistance: 'จุดช่วยเหลือ'
};

const categoryNames = {
  shelter: 'ศูนย์พักพิง / ปลอดภัย',
  sandbag: 'จุดรับทราย / กระสอบทราย',
  food: 'อาหารและน้ำดื่ม',
  medical: 'การแพทย์ / ยา',
  transport: 'เรือ / ยานพาหนะ',
  other: 'อื่น ๆ'
};

function isSandbagPoint(item) {
  if (!item) return false;
  return item.category === 'sandbag' ||
    (item.name && (item.name.includes('ทราย') || item.name.includes('กระสอบ'))) ||
    (item.description && (item.description.includes('ทราย') || item.description.includes('กระสอบ')));
}

const supportStatusNames = {
  available: 'มีของ / พร้อมรับรอง',
  closed: 'ช่วยเหลือแล้ว / ปิดบริการ',
  unavailable: 'ปิดชั่วคราว',
  depleted: 'ของหมดแล้ว'
};

// --- State Variables ---
let reports = loadLocalReports();
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
let gistdaLoading = false;


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
    if (item.status === 'closed') {
      colorClass = 'closed'; // ช่วยเหลือแล้ว / ปิด = สีดำ
      iconEmoji = '⚫';
    } else if (isSandbagPoint(item)) {
      colorClass = 'sandbag'; // จุดรับกระสอบทราย = สีเหลือง
      iconEmoji = '🟡';
    } else {
      colorClass = 'support'; // จุดช่วยเหลือ = สีเขียว
      iconEmoji = '⌂';
    }
  }

  const thumbHtml = item.attachmentPath
    ? `<img src="${cacheBustImage(item.attachmentPath, item.createdAt)}" alt="รูป" class="marker-avatar-thumb">`
    : `<span class="marker-inner-icon">${iconEmoji}</span>`;

  const pulseHtml = (kind === 'report' && item.status !== 'done')
    ? `<span class="marker-ring-pulse ${colorClass}"></span>`
    : (kind === 'assistance' && item.status !== 'closed')
      ? `<span class="marker-ring-pulse ${colorClass}"></span>`
      : '';

  return L.divIcon({
    className: 'custom-radar-marker',
    html: `${pulseHtml}<div class="marker-ring ${colorClass}">${thumbHtml}</div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
    popupAnchor: [0, -18]
  });
}

// --- Map Click Handler (Popup ปุ่มสี และ เมนูเชื่อมโยง เมื่อกดที่ว่างบนแผนที่) ---
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

  // หากเป็นการกดบนที่ว่างของแผนที่ ให้แสดง Popup ปุ่มสี และจุดเชื่อมโยง
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
        <span>🆘</span> ขอความช่วยเหลือ
      </button>
      <button type="button" class="popup-btn popup-btn-report" data-type="flood">
        <span>🌊</span> รายงานน้ำท่วม
      </button>
      <button type="button" class="popup-btn popup-btn-sandbag" data-type="sandbag">
        <span>🟡</span> จุดรับกระสอบทราย
      </button>
      <button type="button" class="popup-btn popup-btn-support" data-type="assistance">
        <span>⌂</span> จุดช่วยเหลือ / พักพิง
      </button>
      <button type="button" class="popup-btn popup-btn-hub" data-type="hub">
        <span>🔗</span> เมนูเชื่อมโยง & ศูนย์รายงาน
      </button>
    </div>
  `;

  popupContainer.querySelectorAll('.popup-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type;
      map.closePopup();
      if (type === 'hub') {
        document.getElementById('quick-links-modal')?.showModal();
      } else {
        openReportModalWithType(type, { lat, lng });
      }
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
  const sandbagCount = assistancePoints.filter(p => isSandbagPoint(p) && p.status !== 'closed').length;
  const closedSupportCount = assistancePoints.filter(p => p.status === 'closed').length;
  const activeSupportCount = assistancePoints.filter(p => p.status !== 'closed').length;
  const doneCount = reports.filter(r => r.status === 'done').length + closedSupportCount;
  const supportCount = activeSupportCount;
  const totalCount = reports.length + assistancePoints.length;

  // Update Counters in Header & Stats Overlay
  document.getElementById('stat-urgent').textContent = pendingHelp;
  document.getElementById('stat-flood').textContent = floodCount;
  document.getElementById('stat-done').textContent = doneCount;
  document.getElementById('stat-support').textContent = supportCount;

  document.getElementById('filter-all-num').textContent = totalCount;
  document.getElementById('filter-help-num').textContent = pendingHelp;
  document.getElementById('filter-flood-num').textContent = floodCount;
  const filterSandbagNum = document.getElementById('filter-sandbag-num');
  if (filterSandbagNum) filterSandbagNum.textContent = sandbagCount;
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
  if (currentFilter === 'all' || currentFilter === 'assistance' || currentFilter === 'sandbag' || currentFilter === 'done') {
    assistancePoints.forEach(point => {
      const isClosedPoint = point.status === 'closed';
      const isSandbag = isSandbagPoint(point);

      if (currentFilter === 'done' && !isClosedPoint) return;
      if (currentFilter === 'sandbag' && (!isSandbag || isClosedPoint)) return;

      visibleCount++;

      // Marker
      if (isInsideProvince(point.lat, point.lng)) {
        const marker = L.marker([point.lat, point.lng], {
          icon: createMarkerIcon(point, 'assistance'),
          zIndexOffset: 1200
        });

        const accentColor = isClosedPoint ? '#475569' : isSandbag ? '#f59e0b' : '#42b883';
        const iconChar = isClosedPoint ? '⚫' : isSandbag ? '🟡' : '⌂';
        const statusText = isClosedPoint
          ? '⚫ ปิดบริการแล้ว'
          : isSandbag
            ? '🟡 จุดรับทราย/กระสอบทราย'
            : (supportStatusNames[point.status] || '');

        marker.bindPopup(`
          <div style="font-family:'IBM Plex Sans Thai',sans-serif; min-width:200px; padding:2px;">
            <strong style="color:${accentColor}; font-size:13px;">${iconChar} ${escapeHtml(point.name)}</strong>
            <div style="font-size:11px; color:${accentColor}; margin:2px 0;">
              ${categoryNames[point.category] || 'จุดช่วยเหลือ'} · ${statusText}
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

      const iconChar = isClosedPoint ? '⚫' : isSandbag ? '🟡' : '⌂';
      let thumbHtml = '';
      if (point.attachmentPath) {
        thumbHtml = `<img src="${cacheBustImage(point.attachmentPath, point.createdAt)}" alt="รูป" class="feed-card-thumb" loading="lazy">`;
      } else {
        thumbHtml = `<div class="feed-card-icon-placeholder">${iconChar}</div>`;
      }

      const badgeClass = isClosedPoint ? 'badge-closed' : isSandbag ? 'badge-sandbag' : 'badge-support';
      const badgeText = isClosedPoint
        ? '⚫ ปิดบริการแล้ว'
        : isSandbag
          ? '🟡 รับกระสอบทราย'
          : (supportStatusNames[point.status] || 'มีของ');

      card.innerHTML = `
        ${thumbHtml}
        <div class="feed-card-content">
          <div class="feed-card-top">
            <span class="feed-kind-tag">${categoryNames[point.category] || 'จุดช่วยเหลือ'}</span>
            <span class="badge ${badgeClass}">${badgeText}</span>
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
  if (!marker) return;
  const onMoveEnd = () => {
    marker.openPopup();
    map.off('moveend', onMoveEnd);
  };
  map.on('moveend', onMoveEnd);
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
      const typeEl = document.getElementById('admin-report-type');
      if (typeEl) typeEl.value = item.type || 'help';
      document.getElementById('admin-status-select').value = item.status || 'pending';
      const peopleEl = document.getElementById('admin-report-people');
      if (peopleEl) peopleEl.value = item.people ?? '';
      document.getElementById('admin-helped-by').value = item.helpedBy || '';
      const descEl = document.getElementById('admin-report-desc');
      if (descEl) descEl.value = item.description || '';
    }
  } else {
    // Assistance Point
    document.getElementById('event-eyebrow').textContent = 'ศูนย์พักพิงและจุดช่วยเหลือ';
    document.getElementById('event-title').textContent = item.name;
    document.getElementById('event-description-text').textContent = item.description;

    const isClosed = item.status === 'closed';
    const isSandbag = isSandbagPoint(item);
    statusBadge.className = `badge ${isClosed ? 'badge-closed' : isSandbag ? 'badge-sandbag' : 'badge-support'}`;
    statusBadge.textContent = isClosed ? '⚫ ปิดบริการแล้ว' : isSandbag ? '🟡 จุดรับกระสอบทราย' : (supportStatusNames[item.status] || 'มีของ');

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
      document.getElementById('admin-support-name').value = item.name || '';
      const catEl = document.getElementById('admin-support-category');
      if (catEl) catEl.value = item.category || 'shelter';
      document.getElementById('admin-support-status').value = item.status || 'available';
      const descEl = document.getElementById('admin-support-desc');
      if (descEl) descEl.value = item.description || '';
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
  const type = document.getElementById('admin-report-type')?.value || activeEventItem.type;
  const status = document.getElementById('admin-status-select').value;
  const peopleVal = document.getElementById('admin-report-people')?.value;
  const people = peopleVal !== '' && !isNaN(Number(peopleVal)) ? Number(peopleVal) : null;
  const helpedBy = document.getElementById('admin-helped-by').value.trim();
  const description = document.getElementById('admin-report-desc')?.value.trim() || activeEventItem.description;
  const btn = document.getElementById('admin-save-status-btn');

  btn.disabled = true;
  try {
    if (database) {
      await updateReport(activeEventItem, { type, status, people, helpedBy, description });
      await syncReports();
    } else {
      activeEventItem.type = type;
      activeEventItem.status = status;
      activeEventItem.people = people;
      activeEventItem.helpedBy = helpedBy;
      activeEventItem.description = description;
      saveLocalReports();
      render();
    }
    toast('บันทึกการแก้ไขข้อมูลเรียบร้อย');
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
  const category = document.getElementById('admin-support-category')?.value || activeEventItem.category;
  const status = document.getElementById('admin-support-status').value;
  const description = document.getElementById('admin-support-desc')?.value.trim() || activeEventItem.description;
  const btn = document.getElementById('admin-save-support-btn');

  if (!name) return toast('กรุณาระบุชื่อจุดช่วยเหลือ');

  btn.disabled = true;
  try {
    if (database) {
      await updateAssistancePoint(activeEventItem, { name, category, status, description });
      await syncAssistancePoints();
    } else {
      activeEventItem.name = name;
      activeEventItem.category = category;
      activeEventItem.status = status;
      activeEventItem.description = description;
      render();
    }
    toast('บันทึกการแก้ไขจุดช่วยเหลือเรียบร้อย');
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
    } else {
      assistancePoints = assistancePoints.filter(p => p.id !== activeEventItem.id);
      render();
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

// Event Dialog Related Links Hub Buttons
document.getElementById('ev-link-map')?.addEventListener('click', () => {
  if (activeEventItem) {
    document.getElementById('event-dialog').close();
    focusItemOnMap(activeEventItem.lat, activeEventItem.lng, `${activeEventType}-${activeEventItem.id}`);
    if (window.innerWidth <= 768) setMobileView('map');
  }
});

document.getElementById('ev-link-district-report')?.addEventListener('click', () => {
  if (activeEventItem) {
    document.getElementById('event-dialog').close();
    renderReportsDashboard();
    document.querySelector('.reports-tab-btn[data-report-tab="districts"]')?.click();
    document.getElementById('reports-dashboard-modal')?.showModal();
  }
});

document.getElementById('ev-link-sandbag')?.addEventListener('click', () => {
  document.getElementById('event-dialog').close();
  const chip = document.querySelector('.filter-chip[data-filter="sandbag"]');
  if (chip) chip.click();
  toast('แสดงเฉพาะจุดรับกระสอบทราย');
});

document.getElementById('ev-link-shelter')?.addEventListener('click', () => {
  document.getElementById('event-dialog').close();
  const chip = document.querySelector('.filter-chip[data-filter="assistance"]');
  if (chip) chip.click();
  toast('แสดงจุดช่วยเหลือและศูนย์พักพิง');
});

document.getElementById('ev-link-add-here')?.addEventListener('click', () => {
  if (activeEventItem) {
    const coords = { lat: activeEventItem.lat, lng: activeEventItem.lng };
    document.getElementById('event-dialog').close();
    openReportModalWithType('help', coords);
  }
});

document.getElementById('ev-link-copy-share')?.addEventListener('click', async () => {
  if (activeEventItem) {
    const title = activeEventType === 'report' ? typeNames[activeEventItem.type] : activeEventItem.name;
    const shareText = `[น้ำท่วมปราจีน69.] ${title} - พิกัด: ${Number(activeEventItem.lat).toFixed(5)}, ${Number(activeEventItem.lng).toFixed(5)} https://maps.google.com/?q=${activeEventItem.lat},${activeEventItem.lng}`;
    try {
      await navigator.clipboard.writeText(shareText);
      toast('คัดลอกลิงก์และพิกัดเหตุการณ์เรียบร้อย');
    } catch {
      toast(`พิกัด: ${Number(activeEventItem.lat).toFixed(5)}, ${Number(activeEventItem.lng).toFixed(5)}`);
    }
  }
});

// --- Easy Reporting Form Modal Logic & Navigation Connections ---
let selectedType = 'help';

function selectReportType(type) {
  if (type === 'sandbag') {
    selectedType = 'assistance';
    const catEl = document.getElementById('point-category');
    if (catEl) catEl.value = 'sandbag';
    const nameEl = document.getElementById('point-name');
    if (nameEl && !nameEl.value) nameEl.value = 'จุดรับทรายและกระสอบทราย';
  } else {
    selectedType = type || 'help';
  }
  document.querySelector('#report-modal h3').textContent = typeNames[selectedType] || 'แจ้งเหตุ';
  document.querySelectorAll('.type-card').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.type === selectedType);
  });

  const isAssistance = selectedType === 'assistance';
  document.getElementById('assistance-fields').hidden = !isAssistance;
  const extraGrid = document.getElementById('report-extra-grid');
  if (extraGrid) extraGrid.hidden = isAssistance;
}

function openReportModalWithType(type, coords = null) {
  document.getElementById('report-form-message').hidden = true;
  selectReportType(type || 'help');
  if (coords && coords.lat && coords.lng) {
    setReportLocation(coords.lat, coords.lng);
  }
  const modal = document.getElementById('report-modal');
  if (modal && !modal.open) {
    modal.showModal();
  }
}

// 4 Colored FAB Buttons + Hub Button:
// ขอความช่วยเหลือ (แดง), รายงานน้ำท่วม (น้ำเงิน), รับกระสอบทราย (เหลือง), จุดช่วยเหลือ (เขียว), เมนูเชื่อมโยง
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
['report-modal', 'event-dialog', 'staff-modal', 'reports-dashboard-modal', 'quick-links-modal'].forEach(id => {
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
function reportFormError(message, targetId) {
  const messageNode = document.getElementById('report-form-message');
  messageNode.textContent = message;
  messageNode.hidden = false;
  messageNode.scrollIntoView({ block: 'center' });
  messageNode.focus({ preventScroll: true });
  if (targetId) {
    const target = document.getElementById(targetId);
    target.setAttribute('aria-describedby', 'report-form-message');
    target.focus();
  }
}
document.getElementById('simple-report-form').addEventListener('submit', async event => {
  event.preventDefault();
  document.getElementById('report-form-message').hidden = true;

  if (!selectedReportPin) {
    return reportFormError('กรุณาเลือกตำแหน่งเหตุการณ์ โดยกด GPS หรือแตะเลือกบนแผนที่');
  }

  const desc = document.getElementById('report-desc').value.trim();
  if (!desc) {
    return reportFormError('กรุณากรอกรายละเอียดเหตุการณ์', 'report-desc');
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
    reportFormError(describeError(err));
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

async function setGistdaFloodLayer(enabled) {
  const dot = document.getElementById('gistda-status-dot');
  const activeKey = getGistdaApiKey();
  if (!activeKey) {
    toast('ยังไม่ได้ระบุ GISTDA API key');
    return;
  }

  if (gistdaLoading) return;
  gistdaFloodLayerEnabled = enabled;

  if (enabled) {
    dot.classList.add('active');

    if (!gistdaFloodLayer) {
      gistdaLoading = true;
      toast('🛰️ กำลังดึงข้อมูลพื้นที่น้ำท่วมจากดาวเทียม GISTDA...');
      try {
        let features = [];
        let periodName = '3 วันล่าสุด';

        // Try 3days first for Prachinburi (pv_idn=25)
        const res3 = await fetch(`https://api-gateway.gistda.or.th/api/2.0/resources/features/flood/3days?api_key=${encodeURIComponent(activeKey)}&pv_idn=25&limit=400`);
        if (res3.ok) {
          const data3 = await res3.json();
          if (Array.isArray(data3?.features) && data3.features.length > 0) {
            features = data3.features;
          }
        }

        // Fallback to 7days if 3days has 0 features
        if (features.length === 0) {
          periodName = '7 วันล่าสุด';
          const res7 = await fetch(`https://api-gateway.gistda.or.th/api/2.0/resources/features/flood/7days?api_key=${encodeURIComponent(activeKey)}&pv_idn=25&limit=400`);
          if (res7.ok) {
            const data7 = await res7.json();
            if (Array.isArray(data7?.features) && data7.features.length > 0) {
              features = data7.features;
            }
          }
        }

        if (features.length === 0) {
          toast('ไม่พบขอบเขตน้ำท่วมจากดาวเทียมในปราจีนบุรีช่วง 3-7 วันนี้');
        } else {
          gistdaFloodLayer = L.geoJSON({ type: 'FeatureCollection', features }, {
            style: {
              color: '#0284c7',
              weight: 1.5,
              opacity: 0.9,
              fillColor: '#38bdf8',
              fillOpacity: 0.45
            },
            onEachFeature: (feature, layer) => {
              const props = feature.properties || {};
              const amphoe = props.ap_tn || 'จ.ปราจีนบุรี';
              const tambon = props.tb_tn || '';
              const areaSqM = Math.round(props.f_area || props.flood_area || 0);
              const areaRai = (areaSqM / 1600).toFixed(1);
              const dateStr = props._createdAt ? new Date(props._createdAt).toLocaleDateString('th-TH') : '';
              layer.bindPopup(`
                <div class="gistda-popup" style="font-family: inherit; font-size: 13px; line-height: 1.5; min-width: 190px;">
                  <div style="font-weight: 700; color: #0284c7; margin-bottom: 4px; display: flex; align-items: center; gap: 4px;">
                    🛰️ ขอบเขตน้ำท่วมดาวเทียม
                  </div>
                  <div><strong>พื้นที่:</strong> ${amphoe} ${tambon}</div>
                  <div><strong>ขนาดน้ำท่วม:</strong> ${areaRai} ไร่ (${areaSqM.toLocaleString()} ตร.ม.)</div>
                  ${dateStr ? `<div><strong>วันที่ดาวเทียม:</strong> ${dateStr}</div>` : ''}
                  <div style="margin-top: 6px; font-size: 11px; opacity: 0.75; border-top: 1px solid rgba(255,255,255,0.15); padding-top: 4px;">
                    ข้อมูลดาวเทียม © GISTDA (${periodName})
                  </div>
                </div>
              `);
            }
          });
        }
      } catch (err) {
        console.error('GISTDA Layer Error:', err);
        toast('โหลดข้อมูลดาวเทียมไม่สำเร็จ: ' + (err.message || ''));
        dot.classList.remove('active');
        gistdaFloodLayerEnabled = false;
        gistdaLoading = false;
        return;
      } finally {
        gistdaLoading = false;
      }
    }

    if (gistdaFloodLayer) {
      gistdaFloodLayer.addTo(map);
      toast('🛰️ แสดงชั้นข้อมูลน้ำท่วม GISTDA เรียบร้อย');
    }

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
      .catch(() => { });
  } else {
    if (gistdaFloodLayer && map.hasLayer(gistdaFloodLayer)) {
      map.removeLayer(gistdaFloodLayer);
    }
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
    const roleName = user.app_metadata?.role || 'staff';
    document.getElementById('staff-role-text').textContent = `สิทธิ์ ${roleName} (${user.email || ''})`;
  } else {
    btnLabel.textContent = 'เจ้าหน้าที่';
  }
  render();
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

// --- Reports Dashboard & Intelligence ---
function getDistrictForItem(lat, lng, text = '') {
  for (const d of PRACHINBURI_DISTRICTS) {
    const raw = d.name.replace('อ.', '');
    if (text && text.includes(raw)) return d.name;
  }
  if (!lat || !lng) return PRACHINBURI_DISTRICTS[0].name;
  let best = PRACHINBURI_DISTRICTS[0].name;
  let minDist = Infinity;
  for (const d of PRACHINBURI_DISTRICTS) {
    const dist = (lat - d.lat) ** 2 + (lng - d.lng) ** 2;
    if (dist < minDist) {
      minDist = dist;
      best = d.name;
    }
  }
  return best;
}

function renderReportsDashboard() {
  const pendingHelp = reports.filter(r => r.type === 'help' && r.status !== 'done');
  const floodReports = reports.filter(r => r.type === 'flood' && r.status !== 'done');
  const activeSupport = assistancePoints.filter(p => p.status !== 'closed');
  const closedSupport = assistancePoints.filter(p => p.status === 'closed');
  const doneReports = reports.filter(r => r.status === 'done');
  const totalPeople = reports.reduce((sum, r) => sum + (Number(r.people) || 0), 0);

  // 1. KPI Cards
  const kpiUrgent = document.getElementById('rep-kpi-urgent');
  const kpiFlood = document.getElementById('rep-kpi-flood');
  const kpiSupport = document.getElementById('rep-kpi-support');
  const kpiClosed = document.getElementById('rep-kpi-closed');
  const kpiDone = document.getElementById('rep-kpi-done');
  const kpiPeople = document.getElementById('rep-kpi-people');

  if (kpiUrgent) kpiUrgent.textContent = pendingHelp.length;
  if (kpiFlood) kpiFlood.textContent = floodReports.length;
  if (kpiSupport) kpiSupport.textContent = activeSupport.length;
  if (kpiClosed) kpiClosed.textContent = closedSupport.length;
  if (kpiDone) kpiDone.textContent = doneReports.length;
  if (kpiPeople) kpiPeople.textContent = totalPeople.toLocaleString('th-TH');

  // 2. District Breakdown Table
  const districtTbody = document.getElementById('district-breakdown-tbody');
  if (districtTbody) {
    districtTbody.innerHTML = '';
    let totalU = 0, totalF = 0, totalS = 0, totalC = 0, totalD = 0, grandTotal = 0;

    PRACHINBURI_DISTRICTS.forEach(d => {
      const urgentInD = pendingHelp.filter(r => getDistrictForItem(r.lat, r.lng, r.description) === d.name).length;
      const floodInD = floodReports.filter(r => getDistrictForItem(r.lat, r.lng, r.description) === d.name).length;
      const supportInD = activeSupport.filter(p => getDistrictForItem(p.lat, p.lng, `${p.name} ${p.description}`) === d.name).length;
      const closedInD = closedSupport.filter(p => getDistrictForItem(p.lat, p.lng, `${p.name} ${p.description}`) === d.name).length;
      const doneInD = doneReports.filter(r => getDistrictForItem(r.lat, r.lng, r.description) === d.name).length;
      const dTotal = urgentInD + floodInD + supportInD + closedInD + doneInD;

      totalU += urgentInD;
      totalF += floodInD;
      totalS += supportInD;
      totalC += closedInD;
      totalD += doneInD;
      grandTotal += dTotal;

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${escapeHtml(d.name)}</strong></td>
        <td class="text-center">${urgentInD > 0 ? `<span class="badge badge-urgent">${urgentInD}</span>` : '0'}</td>
        <td class="text-center">${floodInD > 0 ? `<span class="badge badge-report">${floodInD}</span>` : '0'}</td>
        <td class="text-center">${supportInD > 0 ? `<span class="badge badge-support">${supportInD}</span>` : '0'}</td>
        <td class="text-center">${closedInD > 0 ? `<span class="badge badge-closed">${closedInD}</span>` : '0'}</td>
        <td class="text-center">${doneInD > 0 ? `<span class="badge badge-done">${doneInD}</span>` : '0'}</td>
        <td class="text-center"><strong>${dTotal}</strong></td>
      `;
      districtTbody.appendChild(tr);
    });

    // Summary row
    const footerTr = document.createElement('tr');
    footerTr.style.background = 'rgba(255, 255, 255, 0.05)';
    footerTr.style.fontWeight = 'bold';
    footerTr.innerHTML = `
      <td><strong>รวมทั้ง 7 อำเภอ</strong></td>
      <td class="text-center"><span class="badge badge-urgent">${totalU}</span></td>
      <td class="text-center"><span class="badge badge-report">${totalF}</span></td>
      <td class="text-center"><span class="badge badge-support">${totalS}</span></td>
      <td class="text-center"><span class="badge badge-closed">${totalC}</span></td>
      <td class="text-center"><span class="badge badge-done">${totalD}</span></td>
      <td class="text-center" style="font-size:15px; color:var(--vue-green);"><strong>${grandTotal}</strong></td>
    `;
    districtTbody.appendChild(footerTr);
  }

  // 3. Full Log Table
  renderFullLogTable();
}

function renderFullLogTable() {
  const fullLogTbody = document.getElementById('full-log-tbody');
  if (!fullLogTbody) return;

  const searchQuery = (document.getElementById('report-search-input')?.value || '').trim().toLowerCase();
  const filterType = document.getElementById('report-type-filter')?.value || 'all';

  const allItems = [];

  // Add reports
  reports.forEach(r => {
    allItems.push({
      id: r.id,
      kind: 'report',
      raw: r,
      createdAt: r.createdAt,
      type: r.type,
      status: r.status,
      description: r.description || '',
      people: r.people,
      helpedBy: r.helpedBy,
      contact: r.contact,
      lat: r.lat,
      lng: r.lng,
      district: getDistrictForItem(r.lat, r.lng, r.description)
    });
  });

  // Add assistance points
  assistancePoints.forEach(p => {
    allItems.push({
      id: p.id,
      kind: 'assistance',
      raw: p,
      createdAt: p.createdAt,
      type: 'assistance',
      status: p.status,
      description: `${p.name} - ${p.description || ''}`,
      people: null,
      helpedBy: null,
      contact: null,
      lat: p.lat,
      lng: p.lng,
      district: getDistrictForItem(p.lat, p.lng, `${p.name} ${p.description}`)
    });
  });

  // Sort by date descending
  allItems.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  // Filter
  const filtered = allItems.filter(item => {
    // Type filter
    if (filterType === 'help' && !(item.kind === 'report' && item.type === 'help' && item.status !== 'done')) return false;
    if (filterType === 'flood' && !(item.kind === 'report' && item.type === 'flood' && item.status !== 'done')) return false;
    if (filterType === 'sandbag' && !(item.kind === 'assistance' && isSandbagPoint(item.raw) && item.status !== 'closed')) return false;
    if (filterType === 'assistance' && !(item.kind === 'assistance' && !isSandbagPoint(item.raw) && item.status !== 'closed')) return false;
    if (filterType === 'closed' && !(item.kind === 'assistance' && item.status === 'closed')) return false;
    if (filterType === 'done' && !(item.kind === 'report' && item.status === 'done')) return false;

    // Search query
    if (searchQuery) {
      const matchText = `${item.description} ${item.district} ${item.helpedBy || ''} ${item.contact || ''}`.toLowerCase();
      if (!matchText.includes(searchQuery)) return false;
    }
    return true;
  });

  fullLogTbody.innerHTML = '';
  if (filtered.length === 0) {
    fullLogTbody.innerHTML = '<tr><td colspan="7" class="text-center" style="padding:2rem; color:var(--text-muted);">ไม่พบรายการที่ตรงกับเงื่อนไขการค้นหา</td></tr>';
    return;
  }

  filtered.forEach(item => {
    const tr = document.createElement('tr');

    let typeBadgeHtml = '';
    let statusBadgeHtml = '';

    if (item.kind === 'report') {
      if (item.status === 'done') {
        typeBadgeHtml = '<span class="badge badge-done">✓ ช่วยแล้ว</span>';
        statusBadgeHtml = '<span class="badge badge-done">เสร็จสิ้น</span>';
      } else if (item.type === 'flood') {
        typeBadgeHtml = '<span class="badge badge-report">🌊 น้ำท่วม</span>';
        statusBadgeHtml = '<span class="badge badge-warning">เฝ้าระวัง</span>';
      } else {
        typeBadgeHtml = '<span class="badge badge-urgent">🆘 ขอความช่วยเหลือ</span>';
        statusBadgeHtml = '<span class="badge badge-urgent">รอดำเนินการ</span>';
      }
    } else {
      if (item.status === 'closed') {
        typeBadgeHtml = '<span class="badge badge-closed">⚫ จุดช่วยเหลือปิด</span>';
        statusBadgeHtml = '<span class="badge badge-closed">ปิดบริการแล้ว</span>';
      } else if (isSandbagPoint(item.raw)) {
        typeBadgeHtml = '<span class="badge badge-sandbag">🟡 รับกระสอบทราย</span>';
        statusBadgeHtml = `<span class="badge badge-sandbag">${supportStatusNames[item.status] || 'เปิดบริการ'}</span>`;
      } else {
        typeBadgeHtml = '<span class="badge badge-support">⌂ จุดช่วยเหลือ</span>';
        statusBadgeHtml = `<span class="badge badge-support">${supportStatusNames[item.status] || 'เปิดบริการ'}</span>`;
      }
    }

    const peopleText = item.people ? `<strong>${item.people}</strong> คน` : '-';
    const helperText = item.helpedBy ? escapeHtml(item.helpedBy) : (item.contact ? `📞 ${escapeHtml(item.contact)}` : '-');

    tr.innerHTML = `
      <td style="white-space:nowrap; font-size:12px;">${formatDateTime(item.createdAt)}</td>
      <td>${typeBadgeHtml}</td>
      <td>
        <div style="font-weight:500; font-size:13px;">${escapeHtml(item.description)}</div>
        <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">📍 ${escapeHtml(item.district)} (${Number(item.lat).toFixed(4)}, ${Number(item.lng).toFixed(4)})</div>
      </td>
      <td class="text-center">${peopleText}</td>
      <td>${statusBadgeHtml}</td>
      <td style="font-size:12px;">${helperText}</td>
      <td>
        <button type="button" class="btn-mini-action" data-edit-item="${item.kind}-${item.id}">🔍 ดู/แก้ไข</button>
      </td>
    `;

    tr.querySelector('[data-edit-item]')?.addEventListener('click', () => {
      document.getElementById('reports-dashboard-modal').close();
      focusItemOnMap(item.lat, item.lng, `${item.kind}-${item.id}`);
      openEventDialog(item.raw, item.kind);
    });

    fullLogTbody.appendChild(tr);
  });
}

function exportReportsToCSV() {
  const allItems = [];
  reports.forEach(r => {
    allItems.push({
      time: r.createdAt,
      type: r.status === 'done' ? 'ช่วยเหลือแล้ว' : r.type === 'help' ? 'ขอความช่วยเหลือ' : 'รายงานน้ำท่วม',
      status: r.status === 'done' ? 'ช่วยเหลือสำเร็จ' : r.status,
      desc: r.description || '',
      people: r.people || '',
      helpedBy: r.helpedBy || '',
      contact: r.contact || '',
      lat: r.lat,
      lng: r.lng,
      district: getDistrictForItem(r.lat, r.lng, r.description)
    });
  });

  assistancePoints.forEach(p => {
    const isSand = isSandbagPoint(p);
    allItems.push({
      time: p.createdAt,
      type: p.status === 'closed' ? 'จุดช่วยเหลือปิดแล้ว' : isSand ? 'จุดรับกระสอบทราย' : 'จุดช่วยเหลือ/ศูนย์พักพิง',
      status: p.status === 'closed' ? 'ปิดบริการแล้ว' : (supportStatusNames[p.status] || p.status),
      desc: `${p.name} - ${p.description || ''}`,
      people: '',
      helpedBy: '',
      contact: '',
      lat: p.lat,
      lng: p.lng,
      district: getDistrictForItem(p.lat, p.lng, `${p.name} ${p.description}`)
    });
  });

  allItems.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

  const headers = ['ลำดับ', 'วันเวลา', 'ประเภท', 'สถานะ', 'รายละเอียด', 'จำนวนผู้ประสบภัย(คน)', 'ผู้เข้าช่วยเหลือ/หน่วยงาน', 'เบอร์ติดต่อ', 'อำเภอ', 'ละติจูด', 'ลองจิจูด'];
  const rows = allItems.map((item, index) => [
    index + 1,
    `"${item.time ? formatDateTime(item.time) : ''}"`,
    `"${item.type}"`,
    `"${item.status}"`,
    `"${(item.desc || '').replace(/"/g, '""')}"`,
    item.people || '',
    `"${(item.helpedBy || '').replace(/"/g, '""')}"`,
    `"${(item.contact || '').replace(/"/g, '""')}"`,
    `"${item.district}"`,
    item.lat,
    item.lng
  ]);

  const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `prachinburi-flood-report-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('ส่งออกไฟล์ CSV สำเร็จ');
}

// --- Reports Dashboard Event Listeners ---
const reportsModal = document.getElementById('reports-dashboard-modal');
document.getElementById('reports-dashboard-btn')?.addEventListener('click', () => {
  renderReportsDashboard();
  reportsModal.showModal();
});
document.getElementById('tab-reports-btn')?.addEventListener('click', () => {
  renderReportsDashboard();
  reportsModal.showModal();
});
document.getElementById('reports-modal-close')?.addEventListener('click', () => {
  reportsModal.close();
});

document.querySelectorAll('.reports-tab-btn[data-report-tab]').forEach(tabBtn => {
  tabBtn.addEventListener('click', () => {
    document.querySelectorAll('.reports-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.reports-tab-pane').forEach(p => p.hidden = true);
    tabBtn.classList.add('active');
    const targetPane = document.getElementById(`tab-content-${tabBtn.dataset.reportTab}`);
    if (targetPane) targetPane.hidden = false;
  });
});

document.getElementById('report-search-input')?.addEventListener('input', () => {
  renderFullLogTable();
});
document.getElementById('report-type-filter')?.addEventListener('change', () => {
  renderFullLogTable();
});

document.getElementById('export-csv-btn')?.addEventListener('click', () => {
  exportReportsToCSV();
});
document.getElementById('print-reports-btn')?.addEventListener('click', () => {
  window.print();
});

// --- Quick Links & Related Menus Hub Modal ---
const quickLinksModal = document.getElementById('quick-links-modal');

function openQuickLinksModal() {
  if (quickLinksModal) {
    quickLinksModal.showModal();
  }
}

document.getElementById('quick-links-hub-btn')?.addEventListener('click', openQuickLinksModal);
document.getElementById('tab-links-btn')?.addEventListener('click', openQuickLinksModal);
document.getElementById('fab-quick-links-btn')?.addEventListener('click', openQuickLinksModal);
document.getElementById('quick-links-close')?.addEventListener('click', () => {
  quickLinksModal.close();
});

document.querySelectorAll('[data-hub-action]').forEach(tile => {
  tile.addEventListener('click', () => {
    const action = tile.dataset.hubAction;
    quickLinksModal?.close();

    switch (action) {
      case 'live-map':
        setMobileView('map');
        map.setView(PRACHINBURI_CENTER, 10);
        break;

      case 'gistda-layer':
        setMobileView('map');
        setGistdaFloodLayer(true);
        break;

      case 'google-flood':
        window.open('https://sites.research.google/floods/', '_blank', 'noopener,noreferrer');
        toast('กำลังเปิด Google Flood Hub ในแท็บใหม่');
        break;


      case 'reports-dashboard':
        renderReportsDashboard();
        reportsModal?.showModal();
        break;

      case 'report-help':
        openReportModalWithType('help');
        break;

      case 'report-flood':
        openReportModalWithType('flood');
        break;

      case 'filter-sandbag': {
        const chip = document.querySelector('.filter-chip[data-filter="sandbag"]');
        if (chip) chip.click();
        setMobileView('map');
        break;
      }

      case 'filter-support': {
        const chip = document.querySelector('.filter-chip[data-filter="assistance"]');
        if (chip) chip.click();
        setMobileView('map');
        break;
      }

      case 'filter-closed': {
        const chip = document.querySelector('.filter-chip[data-filter="closed"]');
        if (chip) chip.click();
        setMobileView('map');
        break;
      }

      case 'filter-done': {
        const chip = document.querySelector('.filter-chip[data-filter="done"]');
        if (chip) chip.click();
        setMobileView('map');
        break;
      }

      default:
        break;
    }
  });

  // Enable keyboard enter/space activation for accessibility
  tile.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      tile.click();
    }
  });
});

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
  // A modal dialog is above every ordinary z-index. Keep feedback in its top layer.
  const modal = document.querySelector('dialog[open]');
  (modal || document.body).append(node);
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
