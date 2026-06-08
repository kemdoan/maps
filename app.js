// ── SERVICE WORKER ──────────────────────────────────────────────
let swReg = null;

async function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    swReg = await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
  } catch (e) {
    console.warn('SW:', e);
  }
}

// ── STATE ───────────────────────────────────────────────────────
let map, routePolyline = null, destMarker = null, userMarker = null;
let currentPosition = null;
let watchId = null, acTimeout = null;
let routeSteps = [], currentStepIndex = 0;
let isNavigating = false;
let totalDistance = 0, totalDuration = 0;
let lastNotifStep = -1, notifGranted = false;
let selectedDest = null;

const NOM_HEADERS = {
  'Accept': 'application/json',
  'Accept-Language': 'vi,en'
};

// ── MAP INIT ────────────────────────────────────────────────────
function initMap() {
  initServiceWorker();

  map = L.map('map', { center: [10.8231, 106.6297], zoom: 15, zoomControl: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19
  }).addTo(map);

  // Notification permission check
  if (!('Notification' in window)) {
    document.getElementById('notif-bar').classList.add('hidden');
  } else if (Notification.permission === 'granted') {
    notifGranted = true;
    document.getElementById('notif-bar').classList.add('hidden');
    document.getElementById('btn-test-watch').style.display = 'flex';
  } else if (Notification.permission === 'denied') {
    document.getElementById('notif-bar').querySelector('span').textContent =
      '🔕 Thông báo bị chặn — vào Settings để bật';
    document.getElementById('btn-allow-notif').classList.add('hidden');
  }

  goToMyLocation();
}

// ── AUTOCOMPLETE ────────────────────────────────────────────────
const destInput = document.getElementById('destination-input');
const acList    = document.getElementById('autocomplete-list');

destInput.addEventListener('input', () => {
  clearTimeout(acTimeout);
  selectedDest = null;
  const q = destInput.value.trim();
  if (q.length < 3) { acList.style.display = 'none'; return; }
  acTimeout = setTimeout(() => fetchSuggestions(q), 500);
});

destInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { acList.style.display = 'none'; searchRoute(); }
});

// Đóng list khi click ra ngoài — dùng touchend để không conflict với item touch
document.addEventListener('touchstart', e => {
  if (!e.target.closest('#topbar')) acList.style.display = 'none';
}, { passive: true });
document.addEventListener('mousedown', e => {
  if (!e.target.closest('#topbar')) acList.style.display = 'none';
});

// Event delegation trên acList — dùng touchend + mousedown để bắt cả mobile lẫn desktop
acList.addEventListener('mousedown', e => {
  const item = e.target.closest('.ac-item');
  if (item) { e.preventDefault(); item._selectHandler && item._selectHandler(); }
});
acList.addEventListener('touchend', e => {
  const item = e.target.closest('.ac-item');
  if (item) { e.preventDefault(); item._selectHandler && item._selectHandler(); }
});

async function fetchSuggestions(q) {
  try {
    let viewbox = '';
    if (currentPosition) {
      const { lat, lng } = currentPosition;
      viewbox = `&viewbox=${lng-0.5},${lat+0.5},${lng+0.5},${lat-0.5}&bounded=0`;
    }
    const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=5&countrycodes=vn&q=${encodeURIComponent(q)}${viewbox}`;
    const res  = await fetch(url, { headers: NOM_HEADERS });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    renderSuggestions(data);
  } catch (e) {
    console.error('Autocomplete lỗi:', e);
    showToast('⚠️ Không tải được gợi ý');
  }
}

function renderSuggestions(items) {
  if (!items || !items.length) { acList.style.display = 'none'; return; }
  acList.innerHTML = items.map(item => {
    const parts = item.display_name.split(', ');
    const main  = parts[0] || '';
    const sub   = parts.slice(1, 3).join(', ');
    return `<div class="ac-item" data-lat="${item.lat}" data-lon="${item.lon}" data-name="${escHtml(item.display_name)}">
      <span class="ac-icon">📍</span>
      <div>
        <div class="ac-main">${escHtml(main)}</div>
        <div class="ac-sub">${escHtml(sub)}</div>
      </div>
    </div>`;
  }).join('');
  // Gắn handler sau khi render xong
  acList.querySelectorAll('.ac-item').forEach(el => {
    const name = el.dataset.name
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    el._selectHandler = () => selectPlace(el.dataset.lat, el.dataset.lon, name);
  });
  acList.style.display = 'block';
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── BUG FIX: selectPlace now auto-triggers route calculation ────
function selectPlace(lat, lon, name) {
  selectedDest = { lat: parseFloat(lat), lng: parseFloat(lon), name };
  destInput.value = name.split(',')[0];
  acList.style.display = 'none';
  searchRoute(); // <-- FIX: tự động tìm đường khi chọn gợi ý
}

// ── SEARCH / GEOCODE ────────────────────────────────────────────
async function searchRoute() {
  acList.style.display = 'none';

  // Đã chọn từ autocomplete → tính đường luôn
  if (selectedDest) { calcRoute(selectedDest); return; }

  const q = destInput.value.trim();
  if (!q) { showToast('Nhập điểm đến trước'); return; }

  showLoading('Đang tìm địa chỉ...');
  try {
    let viewbox = '';
    if (currentPosition) {
      const { lat, lng } = currentPosition;
      viewbox = `&viewbox=${lng-0.5},${lat+0.5},${lng+0.5},${lat-0.5}&bounded=0`;
    }
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=vn&q=${encodeURIComponent(q)}${viewbox}`;
    const res  = await fetch(url, { headers: NOM_HEADERS });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    hideLoading();

    if (!data || !data.length) { showToast('❌ Không tìm thấy địa chỉ'); return; }
    selectedDest = {
      lat:  parseFloat(data[0].lat),
      lng:  parseFloat(data[0].lon),
      name: data[0].display_name
    };
    calcRoute(selectedDest);
  } catch (e) {
    hideLoading();
    console.error('Geocode lỗi:', e);
    showToast('❌ Lỗi tìm địa chỉ: ' + e.message);
  }
}

// ── ROUTING (OSRM) ──────────────────────────────────────────────
async function calcRoute(dest) {
  if (!currentPosition) { showToast('📍 Chưa có vị trí GPS — nhấn 📍 trước'); return; }

  showLoading('Đang tính đường...');
  if (routePolyline) { map.removeLayer(routePolyline); routePolyline = null; }
  if (destMarker)    { map.removeLayer(destMarker);    destMarker    = null; }

  try {
    const { lat: oLat, lng: oLng } = currentPosition;
    const url  = `https://router.project-osrm.org/route/v1/driving/${oLng},${oLat};${dest.lng},${dest.lat}?overview=full&geometries=geojson&steps=true`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error('OSRM HTTP ' + res.status);
    const data = await res.json();
    hideLoading();

    if (data.code !== 'Ok' || !data.routes?.length) {
      showToast('❌ Không tìm được đường');
      return;
    }

    const route   = data.routes[0];
    totalDistance = route.distance;
    totalDuration = route.duration;

    // Vẽ polyline
    const coords = route.geometry.coordinates.map(c => [c[1], c[0]]);
    routePolyline = L.polyline(coords, { color: '#666fff', weight: 5, opacity: 0.9 }).addTo(map);

    // Marker đích
    destMarker = L.marker([dest.lat, dest.lng]).addTo(map)
      .bindPopup(dest.name.split(',')[0]).openPopup();

    map.fitBounds(routePolyline.getBounds(), { padding: [60, 60] });

    // Parse steps
    routeSteps = [];
    route.legs[0].steps.forEach((step, i, arr) => {
      const nextStep = arr[i + 1];
      routeSteps.push({
        instruction: buildInstruction(step),
        distance:    step.distance,
        duration:    step.duration,
        maneuver:    (step.maneuver?.type || '') +
                     (step.maneuver?.modifier ? '-' + step.maneuver.modifier : ''),
        endLat: nextStep ? nextStep.maneuver.location[1] : dest.lat,
        endLng: nextStep ? nextStep.maneuver.location[0] : dest.lng
      });
    });

    document.getElementById('btn-navigate').style.display = 'flex';
    showToast(`🗺️ ${formatDist(totalDistance)} · ${formatTime(totalDuration)}`);
  } catch (e) {
    hideLoading();
    console.error('Routing lỗi:', e);
    showToast('❌ Lỗi tính đường: ' + e.message);
  }
}

function buildInstruction(step) {
  const type = step.maneuver?.type     || '';
  const mod  = step.maneuver?.modifier || '';
  const name = step.name               || 'con đường này';
  const modVi = {
    'left':        'trái',
    'right':       'phải',
    'slight left': 'nhẹ trái',
    'slight right':'nhẹ phải',
    'sharp left':  'gấp trái',
    'sharp right': 'gấp phải',
    'uturn':       'quay đầu',
    'straight':    'thẳng'
  };
  const m = modVi[mod] || mod;
  if (type === 'depart')   return `Xuất phát, đi vào ${name}`;
  if (type === 'arrive')   return 'Đã đến điểm đến';
  if (type === 'turn')     return `Rẽ ${m} vào ${name}`;
  if (type === 'continue') return `Tiếp tục thẳng vào ${name}`;
  if (type === 'new name') return `Tiếp tục vào ${name}`;
  if (type === 'merge')    return `Nhập làn ${m} vào ${name}`;
  if (type === 'fork')     return `Ở ngã rẽ, đi ${m} vào ${name}`;
  if (type.includes('roundabout') || type.includes('rotary')) return `Vào vòng xuyến, ra ${m}`;
  return `${type} ${m} vào ${name}`.trim();
}

// ── NAVIGATION ──────────────────────────────────────────────────
function startNavigation() {
  if (!routeSteps.length) return;
  isNavigating = true;
  currentStepIndex = 0;
  lastNotifStep = -1;
  document.getElementById('btn-navigate').style.display = 'none';
  document.getElementById('status-card').style.display = 'block';
  document.getElementById('instruction-banner').style.display = 'flex';
  map.setZoom(17);
  notifyCurrentStep();
  watchId = navigator.geolocation.watchPosition(
    onPositionUpdate,
    e => console.warn('GPS watch:', e),
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 }
  );
  updateInstruction();
  showToast('🧭 Bắt đầu dẫn đường!');
}

function stopNavigation() {
  isNavigating = false;
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  document.getElementById('status-card').style.display = 'none';
  document.getElementById('instruction-banner').style.display = 'none';
  document.getElementById('btn-navigate').style.display = 'none';
  showToast('🏁 Đã dừng dẫn đường');
}

function onPositionUpdate(pos) {
  if (!isNavigating) return;
  currentPosition = { lat: pos.coords.latitude, lng: pos.coords.longitude };
  const speed = pos.coords.speed != null ? Math.round(pos.coords.speed * 3.6) : '--';
  updateUserMarker(currentPosition);
  map.panTo([currentPosition.lat, currentPosition.lng]);
  document.getElementById('stat-speed').textContent = speed;
  checkStepProximity();
}

function notifyCurrentStep() {
  if (currentStepIndex >= routeSteps.length) return;
  const step = routeSteps[currentStepIndex];
  const icon = getTurnIcon(step.maneuver);
  sendNotification(icon + '  ' + step.instruction, 'Đi ' + formatDist(step.distance));
  lastNotifStep = currentStepIndex * 10 + 9;
}

function checkStepProximity() {
  if (currentStepIndex >= routeSteps.length) { arriveDestination(); return; }
  const step = routeSteps[currentStepIndex];
  const dist = getDistance(currentPosition, { lat: step.endLat, lng: step.endLng });
  updateStats(dist);
  updateInstruction(dist);

  const isActionStep = !step.maneuver.startsWith('depart') &&
                       !step.maneuver.startsWith('arrive');
  if (isActionStep) {
    const icon = getTurnIcon(step.maneuver);
    if (dist < 300 && lastNotifStep !== currentStepIndex * 10 + 2) {
      lastNotifStep = currentStepIndex * 10 + 2;
      sendNotification(icon + '  ' + step.instruction, 'Còn ' + formatDist(dist));
    }
    if (dist < 80 && lastNotifStep !== currentStepIndex * 10 + 1) {
      lastNotifStep = currentStepIndex * 10 + 1;
      sendNotification(icon + '  ' + step.instruction, '⚡ Rẽ ngay! Còn ' + formatDist(dist));
    }
  }

  if (dist < 25) {
    currentStepIndex++;
    lastNotifStep = -1;
    if (currentStepIndex < routeSteps.length) notifyCurrentStep();
  }
}

function updateInstruction(distToStep) {
  if (currentStepIndex >= routeSteps.length) return;
  const step = routeSteps[currentStepIndex];
  document.getElementById('turn-icon').textContent = getTurnIcon(step.maneuver);
  document.getElementById('turn-text').textContent = step.instruction;
  document.getElementById('turn-dist').textContent = formatDist(distToStep ?? step.distance);
}

function updateStats(distToNextStep) {
  let remaining = distToNextStep;
  for (let i = currentStepIndex + 1; i < routeSteps.length; i++) {
    remaining += routeSteps[i].distance;
  }
  const pct = Math.min(((totalDistance - remaining) / totalDistance) * 100, 100);
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('stat-dist').textContent = formatDist(remaining);
  document.getElementById('stat-time').textContent =
    formatTime(Math.round((remaining / totalDistance) * totalDuration));
}

function arriveDestination() {
  isNavigating = false;
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  document.getElementById('status-card').style.display = 'none';
  document.getElementById('instruction-banner').style.display = 'none';
  document.getElementById('progress-fill').style.width = '100%';
  sendNotification('🏁 Đã đến nơi!', 'Bạn đã đến điểm đến');
}

// ── LOCATION ────────────────────────────────────────────────────
function goToMyLocation() {
  if (!navigator.geolocation) { showToast('⚠️ Trình duyệt không hỗ trợ GPS'); return; }
  showToast('⏳ Đang tìm kiếm vị trí...');
  navigator.geolocation.getCurrentPosition(
    pos => {
      currentPosition = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      map.setView([currentPosition.lat, currentPosition.lng], 16);
      updateUserMarker(currentPosition);
      showToast('📍 Đã lấy vị trí!');
    },
    err => {
      console.error('GPS:', err);
      showToast('⚠️ Không lấy được vị trí (code ' + err.code + ')');
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

function updateUserMarker(pos) {
  if (userMarker) map.removeLayer(userMarker);
  const icon = L.divIcon({
    html: `<div style="width:20px;height:20px;border-radius:50%;background:#666fff;border:3px solid #fff;box-shadow:0 0 0 3px rgba(102,111,255,0.35)"></div>`,
    iconSize: [20, 20], iconAnchor: [10, 10], className: ''
  });
  userMarker = L.marker([pos.lat, pos.lng], { icon, zIndexOffset: 999 }).addTo(map);
}

// ── NOTIFICATION ─────────────────────────────────────────────────
function requestNotifPermission() {
  Notification.requestPermission().then(perm => {
    if (perm === 'granted') {
      notifGranted = true;
      document.getElementById('notif-bar').classList.add('hidden');
      document.getElementById('btn-test-watch').style.display = 'flex';
      showToast('✅ Đã bật thông báo!');
    } else {
      document.getElementById('notif-bar').querySelector('span').textContent =
        '🔕 Cần bật thông báo trong Settings';
      document.getElementById('btn-allow-notif').classList.add('hidden');
    }
  });
}

async function sendNotification(title, body) {
  if (!notifGranted) return;
  const opts = {
    body,
    tag:              'kdmaps-nav',
    renotify:         true,
    icon:             'https://cdn-icons-png.flaticon.com/512/854/854878.png',
    vibrate:          [150, 80, 150],
    requireInteraction: false,
    silent:           false
  };
  try {
    const reg = swReg || await navigator.serviceWorker.ready;
    if (reg?.active) { await reg.showNotification(title, opts); return; }
  } catch (e) {}
  try {
    const n = new Notification(title, opts);
    setTimeout(() => n.close(), 6000);
  } catch (e) {}
}

async function testWatchNotif() {
  if (!notifGranted) { showToast('⚠️ Chưa bật thông báo'); return; }
  await sendNotification('📍 KD Maps', ' • Ôm cua rẽ trái khoảng 200m rồi gặp chú CSGT :))');
}

// ── HELPERS ──────────────────────────────────────────────────────
function getDistance(a, b) {
  const R  = 6371000;
  const φ1 = a.lat * Math.PI / 180;
  const φ2 = b.lat * Math.PI / 180;
  const dφ = (b.lat - a.lat) * Math.PI / 180;
  const dλ = (b.lng - a.lng) * Math.PI / 180;
  const x  = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function formatDist(m) {
  return m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m';
}

function formatTime(s) {
  if (s >= 3600) return Math.round(s / 3600) + ' giờ';
  if (s >= 60)   return Math.round(s / 60)   + ' phút';
  return s + ' giây';
}

function getTurnIcon(maneuver = '') {
  if (maneuver.includes('uturn'))                               return '↩';
  if (maneuver.includes('sharp-left')  || maneuver.includes('left'))  return '↰';
  if (maneuver.includes('sharp-right') || maneuver.includes('right')) return '↱';
  if (maneuver.includes('roundabout')  || maneuver.includes('rotary'))return '🔄';
  return '⬆';
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 3500);
}

function showLoading(text = 'Đang xử lý...') {
  document.getElementById('loading-text').textContent = text;
  document.getElementById('loading').style.display = 'flex';
}

function hideLoading() {
  document.getElementById('loading').style.display = 'none';
}

window.addEventListener('load', initMap);
