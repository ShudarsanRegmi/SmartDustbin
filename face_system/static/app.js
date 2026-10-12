/* ============================================================
   FaceID – Frontend logic
   ============================================================ */

// -----------------------------------------------------------------
// ESP32 config & Device IP Management
// -----------------------------------------------------------------
let esp32BaseUrl  = null;
let plateCamUrl   = null;

// Store last identified person so Plate Cam page can autofill it
let _lastIdentifiedPerson = null;

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    esp32BaseUrl = data.esp32_base;
    plateCamUrl  = data.plate_base;
    updateDeviceUiState(data);
    return data;
  } catch (e) {
    console.error('Failed to load device config:', e);
  }
}

function updateDeviceUiState(data) {
  if (!data) return;
  const esp32 = data.esp32_base || esp32BaseUrl || '';
  const plate = data.plate_base || plateCamUrl || '';

  const displayIp = esp32.replace(/^https?:\/\//, '').replace(/\/.*$/, '') || 'Not configured';
  const navLabel = document.getElementById('navDeviceLabel');
  if (navLabel) {
    navLabel.textContent = `ESP32: ${displayIp}`;
  }

  // Fill Dashboard input if empty or pristine
  const dashInput = document.getElementById('dashEsp32Input');
  if (dashInput && (!dashInput.value || dashInput.dataset.pristine !== 'false')) {
    dashInput.value = displayIp;
    dashInput.dataset.pristine = 'true';
  }

  // Fill Modal inputs
  const modalEsp32Input = document.getElementById('modalEsp32Input');
  if (modalEsp32Input) modalEsp32Input.value = esp32;

  const modalPlateInput = document.getElementById('modalPlateInput');
  if (modalPlateInput) modalPlateInput.value = plate;
}

function openDeviceSettingsModal() {
  ensureDeviceModalExists();
  const modal = document.getElementById('deviceSettingsModal');
  if (!modal) return;

  const modalEsp32 = document.getElementById('modalEsp32Input');
  const modalPlate = document.getElementById('modalPlateInput');
  if (modalEsp32 && esp32BaseUrl) modalEsp32.value = esp32BaseUrl;
  if (modalPlate && plateCamUrl) modalPlate.value = plateCamUrl;

  const feedback = document.getElementById('modalFeedback');
  if (feedback) feedback.style.display = 'none';

  modal.style.display = 'flex';
  if (modalEsp32) modalEsp32.focus();
}

function closeDeviceSettingsModal() {
  const modal = document.getElementById('deviceSettingsModal');
  if (modal) modal.style.display = 'none';
}

function handleModalBackdropClick(e) {
  if (e.target && e.target.id === 'deviceSettingsModal') {
    closeDeviceSettingsModal();
  }
}

async function pingEsp32(source = 'modal', showLoading = true) {
  let targetUrl = '';
  if (source === 'dash') {
    const input = document.getElementById('dashEsp32Input');
    if (input) targetUrl = input.value.trim();
  } else {
    const input = document.getElementById('modalEsp32Input');
    if (input) targetUrl = input.value.trim();
  }

  const statusBadge = document.getElementById('dashDeviceStatusBadge');
  const statusText = document.getElementById('modalEsp32PingStatus');
  const navDot = document.getElementById('navDeviceDot');

  if (source === 'dash' && statusBadge && showLoading) {
    statusBadge.className = 'status-badge checking';
    statusBadge.textContent = 'Testing connection...';
  } else if (statusText && showLoading) {
    statusText.textContent = 'Testing connection...';
    statusText.style.color = 'var(--warning)';
  }

  try {
    let url = '/api/ping-device?target=esp32';
    if (targetUrl) url += '&custom_url=' + encodeURIComponent(targetUrl);
    const res = await fetch(url);
    const result = await res.json();

    if (result.online) {
      if (source === 'dash' && statusBadge) {
        statusBadge.className = 'status-badge ok';
        statusBadge.textContent = `Online (${result.latency_ms}ms)`;
      }
      if (statusText) {
        statusText.textContent = `Online (${result.latency_ms}ms, HTTP ${result.status_code})`;
        statusText.style.color = 'var(--success)';
      }
      if (navDot) navDot.className = 'status-indicator-dot online';
    } else {
      if (source === 'dash' && statusBadge) {
        statusBadge.className = 'status-badge error';
        statusBadge.textContent = 'Offline / Unreachable';
      }
      if (statusText) {
        statusText.textContent = `Unreachable: ${result.message || 'Timeout'}`;
        statusText.style.color = 'var(--danger)';
      }
      if (navDot) navDot.className = 'status-indicator-dot offline';
    }
  } catch (err) {
    if (source === 'dash' && statusBadge) {
      statusBadge.className = 'status-badge error';
      statusBadge.textContent = 'Ping failed';
    }
    if (statusText) {
      statusText.textContent = 'Ping request failed';
      statusText.style.color = 'var(--danger)';
    }
  }
}

async function pingPlate(source = 'modal') {
  const input = document.getElementById('modalPlateInput');
  const statusText = document.getElementById('modalPlatePingStatus');
  let targetUrl = input ? input.value.trim() : '';

  if (statusText) {
    statusText.textContent = 'Testing connection...';
    statusText.style.color = 'var(--warning)';
  }

  try {
    let url = '/api/ping-device?target=plate';
    if (targetUrl) url += '&custom_url=' + encodeURIComponent(targetUrl);
    const res = await fetch(url);
    const result = await res.json();

    if (result.online) {
      if (statusText) {
        statusText.textContent = `Online (${result.latency_ms}ms)`;
        statusText.style.color = 'var(--success)';
      }
    } else {
      if (statusText) {
        statusText.textContent = 'Unreachable';
        statusText.style.color = 'var(--danger)';
      }
    }
  } catch (err) {
    if (statusText) {
      statusText.textContent = 'Ping request failed';
      statusText.style.color = 'var(--danger)';
    }
  }
}

async function saveEsp32Ip(source = 'modal') {
  let esp32Val = '';
  let plateVal = '';

  if (source === 'dash') {
    const input = document.getElementById('dashEsp32Input');
    if (input) esp32Val = input.value.trim();
  } else {
    const input = document.getElementById('modalEsp32Input');
    if (input) esp32Val = input.value.trim();
    const plateInput = document.getElementById('modalPlateInput');
    if (plateInput) plateVal = plateInput.value.trim();
  }

  if (!esp32Val && !plateVal) {
    showDeviceFeedback(source, 'Please enter a valid IP address or URL.', 'error');
    return;
  }

  showDeviceFeedback(source, 'Saving configuration...', 'loading');

  try {
    const payload = {};
    if (esp32Val) payload.esp32_url = esp32Val;
    if (plateVal) payload.plate_cam_url = plateVal;

    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await res.json();
    if (!res.ok) {
      throw new Error(result.detail || result.message || 'Failed to save configuration');
    }

    esp32BaseUrl = result.esp32_base;
    plateCamUrl = result.plate_base;
    updateDeviceUiState(result);

    showDeviceFeedback(source, 'Saved! Live immediately (no server restart needed)', 'success');

    if (streamActive) {
      const streamImg = document.getElementById('streamImg');
      if (streamImg) streamImg.src = esp32BaseUrl + '/stream?' + Date.now();
    }

    pingEsp32(source, false);

    if (source === 'modal') {
      setTimeout(() => {
        closeDeviceSettingsModal();
      }, 1300);
    }
  } catch (err) {
    showDeviceFeedback(source, 'Error: ' + err.message, 'error');
  }
}

function showDeviceFeedback(source, message, type) {
  const box = source === 'dash'
    ? document.getElementById('dashDeviceFeedback')
    : document.getElementById('modalFeedback');
  if (!box) return;

  box.style.display = 'block';
  box.className = `status-box ${type} mt-xs`;
  box.textContent = message;
}

function ensureDeviceModalExists() {
  if (document.getElementById('deviceSettingsModal')) return;

  const modalHtml = `
  <div id="deviceSettingsModal" class="modal-backdrop" style="display:none;" onclick="handleModalBackdropClick(event)">
    <div class="modal-box" onclick="event.stopPropagation()">
      <div class="modal-header">
        <h3 class="modal-title">&#x2699;&#xFE0F; Device Network Settings</h3>
        <button class="modal-close" type="button" onclick="closeDeviceSettingsModal()">&times;</button>
      </div>
      <div class="modal-body">
        <p class="muted small mb-sm">Update the ESP32 IP anytime directly from UI. Changes apply immediately without server restart.</p>
        
        <div class="form-group mb-sm">
          <label class="field-label" for="modalEsp32Input">ESP32 Camera / Servo IP or URL</label>
          <div class="input-with-ping">
            <input type="text" id="modalEsp32Input" class="text-input" placeholder="e.g. 10.177.247.45 or http://10.177.247.45" />
            <button type="button" class="btn btn-secondary sm" id="modalPingEsp32Btn" onclick="pingEsp32('modal')">&#x1F504; Test</button>
          </div>
          <div id="modalEsp32PingStatus" class="small muted mt-xs"></div>
        </div>

        <div class="form-group mb-sm">
          <label class="field-label" for="modalPlateInput">Plate Camera IP or URL (Optional)</label>
          <div class="input-with-ping">
            <input type="text" id="modalPlateInput" class="text-input" placeholder="e.g. 11.12.23.199 or http://11.12.23.199" />
            <button type="button" class="btn btn-secondary sm" id="modalPingPlateBtn" onclick="pingPlate('modal')">&#x1F504; Test</button>
          </div>
          <div id="modalPlatePingStatus" class="small muted mt-xs"></div>
        </div>

        <div id="modalFeedback" class="status-box mt-xs" style="display:none;"></div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-ghost" onclick="closeDeviceSettingsModal()">Cancel</button>
        <button type="button" class="btn btn-primary" id="modalSaveBtn" onclick="saveEsp32Ip('modal')">&#x1F4BE; Save & Apply</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', modalHtml);
}

function initGlobalDeviceUI() {
  ensureDeviceModalExists();

  const navbar = document.querySelector('.navbar');
  if (navbar && !document.getElementById('navDeviceBtn')) {
    const navRight = document.createElement('div');
    navRight.className = 'nav-right';
    navRight.innerHTML = `
      <button id="navDeviceBtn" class="nav-device-btn" type="button" onclick="openDeviceSettingsModal()" title="Click to view or change ESP32 IP">
        <span class="status-indicator-dot" id="navDeviceDot"></span>
        <span id="navDeviceLabel">ESP32 IP</span>
        <span class="nav-device-gear">&#x2699;&#xFE0F;</span>
      </button>
    `;
    navbar.appendChild(navRight);
  }

  loadConfig().then(() => {
    pingEsp32('dash', false);
  });
}

// Expose functions on window for inline handlers
window.loadConfig = loadConfig;
window.openDeviceSettingsModal = openDeviceSettingsModal;
window.closeDeviceSettingsModal = closeDeviceSettingsModal;
window.handleModalBackdropClick = handleModalBackdropClick;
window.pingEsp32 = pingEsp32;
window.pingPlate = pingPlate;
window.saveEsp32Ip = saveEsp32Ip;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initGlobalDeviceUI);
} else {
  initGlobalDeviceUI();
}
// Live stream toggle
// -----------------------------------------------------------------
let streamActive = false;

function toggleStream() {
  if (!esp32BaseUrl) { alert('Camera config not loaded yet.'); return; }

  const streamImg   = document.getElementById('streamImg');
  const previewImg  = document.getElementById('previewImg');
  const placeholder = document.getElementById('previewPlaceholder');
  const faceBadge   = document.getElementById('faceBadge');
  const btn         = document.getElementById('streamBtn');

  streamActive = !streamActive;

  if (streamActive) {
    if (previewImg)  previewImg.style.display  = 'none';
    if (placeholder) placeholder.style.display = 'none';
    if (faceBadge)   faceBadge.style.display   = 'none';
    streamImg.src          = esp32BaseUrl + '/stream';
    streamImg.style.display = 'block';
    btn.innerHTML = '&#x23F9; Stop Stream';
    btn.classList.replace('btn-secondary', 'btn-primary');
  } else {
    streamImg.src           = '';
    streamImg.style.display = 'none';
    const hasSnap = previewImg && previewImg.src && !previewImg.src.endsWith(window.location.href);
    if (hasSnap) {
      previewImg.style.display = 'block';
    } else if (placeholder) {
      placeholder.style.display = '';
    }
    btn.innerHTML = '&#x1F4E1; Live Stream';
    btn.classList.replace('btn-primary', 'btn-secondary');
  }
}

// -----------------------------------------------------------------
// Flash LED toggle (proxied through Python server to avoid CORS)
// -----------------------------------------------------------------
let flashOn = false;

async function toggleFlash() {
  const btn = document.getElementById('flashBtn');
  setLoading(btn, true);
  try {
    const res  = await fetch('/api/flash', { method: 'POST' });
    const data = await res.json();
    flashOn = data.flash === 'on';
    btn.innerHTML  = flashOn ? '&#x1F4A1; Flash ON' : '&#x1F526; Flash';
    btn._origHTML  = btn.innerHTML;
    if (flashOn) {
      btn.classList.replace('btn-ghost', 'btn-secondary');
    } else {
      btn.classList.replace('btn-secondary', 'btn-ghost');
    }
  } catch (e) {
    alert('Flash control failed: ' + e.message);
  } finally {
    setLoading(btn, false);
  }
}

// -----------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------
function setLoading(btn, loading) {
  if (!btn) return;
  if (loading) {
    btn._origHTML = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span>';
    btn.disabled = true;
  } else {
    btn.innerHTML = btn._origHTML || btn.innerHTML;
    btn.disabled = false;
  }
}

function showEl(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = '';
}

function hideEl(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setStatus(box, cls, msg) {
  if (!box) return;
  box.className = 'status-box ' + cls;
  box.textContent = msg;
  box.style.display = '';
}

// -----------------------------------------------------------------
// Profile list (used on dashboard + enroll pages)
// -----------------------------------------------------------------
async function loadProfiles() {
  const list = document.getElementById('profileList');
  if (!list) return;

  list.innerHTML = '<p class="muted">Loading…</p>';

  try {
    const res = await fetch('/api/profiles');
    const data = await res.json();
    const profiles = data.profiles || [];

    // Update stats (dashboard)
    const totalPhotos = profiles.reduce((s, p) => s + (p.photos || 0), 0);
    setText('statCount', profiles.length);
    setText('statPhotos', totalPhotos);

    if (profiles.length === 0) {
      list.innerHTML = '<p class="muted">No people enrolled yet.</p>';
      return;
    }

    list.innerHTML = '';
    for (const p of profiles) {
      const initials = p.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
      const item = document.createElement('div');
      item.className = 'profile-item profile-item-clickable';
      item.title = 'Click to view samples';
      item.onclick = (e) => {
        // Don't trigger gallery when clicking the Delete button
        if (e.target.closest('.btn-danger')) return;
        openGallery(p.name);
      };
      item.innerHTML = `
        <div class="profile-avatar">${initials}</div>
        <div class="profile-info">
          <div class="profile-name">${escHtml(p.name)}</div>
          <div class="profile-meta">
            &#x1F4F7; ${p.photos} sample${p.photos !== 1 ? 's' : ''}
            ${p.enrolled_at ? ' &middot; ' + p.enrolled_at : ''}
          </div>
        </div>
        <button class="btn btn-danger" onclick="deleteProfile('${escHtml(p.name)}', this)">Delete</button>
      `;
      list.appendChild(item);
    }
  } catch (err) {
    list.innerHTML = '<p class="muted" style="color:var(--danger)">Failed to load profiles.</p>';
  }
}

async function deleteProfile(name, btn) {
  if (!confirm(`Delete profile for "${name}"?`)) return;
  setLoading(btn, true);
  try {
    const res = await fetch(`/api/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (res.ok) {
      await loadProfiles();
    } else {
      const data = await res.json().catch(() => ({}));
      alert(data.detail || 'Failed to delete profile.');
      setLoading(btn, false);
    }
  } catch {
    alert('Network error.');
    setLoading(btn, false);
  }
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// -----------------------------------------------------------------
// Photo gallery
// -----------------------------------------------------------------
let _galleryOpen = null;

async function openGallery(name) {
  if (_galleryOpen === name) { closeGallery(); return; }
  _galleryOpen = name;

  const card  = document.getElementById('galleryCard');
  const title = document.getElementById('galleryTitle');
  const grid  = document.getElementById('galleryGrid');
  if (!card) return;

  title.textContent = `Samples — ${name}`;
  grid.innerHTML = '<p class="muted">Loading…</p>';
  card.style.display = '';
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    const res  = await fetch(`/api/profiles/${encodeURIComponent(name)}/photos`);
    const data = await res.json();
    if (!data.photos.length) {
      grid.innerHTML = '<p class="muted">No photos stored yet for this person.<br>Enroll more samples to see them here.</p>';
      return;
    }
    grid.innerHTML = data.photos.map((url, i) =>
      `<div class="photo-thumb" onclick="viewPhoto('${escHtml(url)}', ${i+1}, ${data.photos.length})">
         <img src="${escHtml(url)}" loading="lazy" alt="Sample ${i+1}" />
         <span class="photo-num">${i+1}</span>
       </div>`
    ).join('');
  } catch (e) {
    grid.innerHTML = '<p class="muted" style="color:var(--danger)">Failed to load photos.</p>';
  }
}

function closeGallery() {
  _galleryOpen = null;
  const card = document.getElementById('galleryCard');
  if (card) card.style.display = 'none';
}

function viewPhoto(url, idx, total) {
  const existing = document.getElementById('photoLightbox');
  if (existing) existing.remove();

  const lb = document.createElement('div');
  lb.id = 'photoLightbox';
  lb.className = 'lightbox';
  lb.innerHTML = `
    <div class="lightbox-backdrop" onclick="this.parentElement.remove()"></div>
    <div class="lightbox-content">
      <img src="${escHtml(url)}" alt="Sample ${idx}" />
      <div class="lightbox-label">Sample ${idx} / ${total}</div>
      <button class="lightbox-close" onclick="document.getElementById('photoLightbox').remove()">&#x2715;</button>
    </div>`;
  document.body.appendChild(lb);
}

// -----------------------------------------------------------------
// Enroll page
// -----------------------------------------------------------------
async function capturePreview() {
  const btn = document.getElementById('previewBtn');
  const img = document.getElementById('previewImg');
  const placeholder = document.getElementById('previewPlaceholder');
  const badge = document.getElementById('faceBadge');

  setLoading(btn, true);
  try {
    const res = await fetch('/api/preview');
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || 'Capture failed');
    const data = await res.json();

    img.src = data.image;
    img.style.display = 'block';
    if (placeholder) placeholder.style.display = 'none';

    if (badge) {
      badge.style.display = '';
      if (data.faces_detected > 0) {
        badge.textContent = `✓ ${data.faces_detected} face${data.faces_detected > 1 ? 's' : ''} detected`;
        badge.className = 'face-badge ok';
      } else {
        badge.textContent = '⚠ No face detected';
        badge.className = 'face-badge warn';
      }
    }
  } catch (err) {
    alert('Preview failed: ' + err.message);
  } finally {
    setLoading(btn, false);
  }
}

async function enrollFace() {
  const nameInput = document.getElementById('nameInput');
  const enrollBtn = document.getElementById('enrollBtn');
  const statusBox = document.getElementById('enrollStatus');
  const name = nameInput ? nameInput.value.trim() : '';

  if (!name) { alert('Please enter a name.'); return; }

  setLoading(enrollBtn, true);
  setStatus(statusBox, 'loading', '⏳ Capturing and enrolling…');

  try {
    const fd = new FormData();
    fd.append('name', name);
    const res = await fetch('/api/enroll', { method: 'POST', body: fd });
    const data = await res.json();

    if (!res.ok) {
      setStatus(statusBox, 'error', '✗ ' + (data.detail || 'Enrollment failed'));
    } else if (data.status === 'error') {
      setStatus(statusBox, 'error', '✗ ' + data.detail);
    } else {
      setStatus(statusBox, 'success', `✓ Enrolled "${data.name}" — total samples: ${data.total_photos}`);
      // update preview with freshly captured image
      const img = document.getElementById('previewImg');
      const placeholder = document.getElementById('previewPlaceholder');
      if (img && data.image) {
        img.src = data.image;
        img.style.display = 'block';
        if (placeholder) placeholder.style.display = 'none';
      }
      await loadProfiles();
    }
  } catch (err) {
    setStatus(statusBox, 'error', '✗ Network error: ' + err.message);
  } finally {
    setLoading(enrollBtn, false);
    enrollBtn.disabled = !nameInput || nameInput.value.trim() === '';
  }
}

// -----------------------------------------------------------------
// Identify page
// -----------------------------------------------------------------
const identifyHistory = [];

async function runIdentify() {
  const verifyBtn = document.getElementById('verifyBtn');
  const previewImg = document.getElementById('previewImg');
  const placeholder = document.getElementById('previewPlaceholder');
  const clearBtn = document.getElementById('clearBtn');

  // hide all result panels
  ['resultIdle','resultRecognized','resultUnknown','resultNoFace','resultError'].forEach(hideEl);

  setLoading(verifyBtn, true);

  try {
    const res = await fetch('/api/identify');
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showEl('resultError');
      setText('errorMsg', data.detail || `Server error ${res.status}`);
      return;
    }
    const data = await res.json();

    // Show captured image
    if (data.image && previewImg) {
      previewImg.src = data.image;
      previewImg.style.display = 'block';
      if (placeholder) placeholder.style.display = 'none';
    }

    if (clearBtn) clearBtn.style.display = '';

    if (data.status === 'no_face') {
      showEl('resultNoFace');
      pushHistory({ name: null, status: 'no_face' });
    } else if (data.status === 'recognized') {
      setText('resultName', data.person);
      const conf = data.confidence !== null ? data.confidence : 0;
      const bar = document.getElementById('confidenceBar');
      const val = document.getElementById('confidenceValue');
      if (bar) setTimeout(() => { bar.style.width = conf + '%'; }, 50);
      if (val) val.textContent = conf + '%';
      setText('scoreRaw', `L2 distance: ${data.score}`);
      showEl('resultRecognized');
      pushHistory({ name: data.person, status: 'recognized', confidence: conf });
    } else {
      setText('scoreRawUnknown', `L2 distance: ${data.score}`);
      showEl('resultUnknown');
      pushHistory({ name: null, status: 'unknown' });
    }
  } catch (err) {
    showEl('resultError');
    setText('errorMsg', 'Network error: ' + err.message);
  } finally {
    setLoading(verifyBtn, false);
  }
}

function clearResult() {
  const previewImg = document.getElementById('previewImg');
  const placeholder = document.getElementById('previewPlaceholder');
  const clearBtn = document.getElementById('clearBtn');

  if (previewImg) { previewImg.src = ''; previewImg.style.display = 'none'; }
  if (placeholder) placeholder.style.display = '';
  if (clearBtn) clearBtn.style.display = 'none';

  ['resultRecognized','resultUnknown','resultNoFace','resultError'].forEach(hideEl);
  showEl('resultIdle');
}

function pushHistory(entry) {
  identifyHistory.unshift({ ...entry, time: new Date().toLocaleTimeString() });
  if (identifyHistory.length > 8) identifyHistory.length = 8;
  if (entry.status === 'recognized' && entry.name) {
    _lastIdentifiedPerson = entry.name;
    try { sessionStorage.setItem('lastIdentified', entry.name); } catch(_) {}
  }
  renderHistory();
}

function renderHistory() {
  const wrap = document.getElementById('resultHistory');
  const list = document.getElementById('historyList');
  if (!wrap || !list) return;
  wrap.style.display = '';
  list.innerHTML = identifyHistory.map(h => {
    const cls = h.status === 'recognized' ? 'history-known' : 'history-unknown';
    const label = h.status === 'recognized'
      ? escHtml(h.name) + (h.confidence != null ? ` <span class="muted">${h.confidence}%</span>` : '')
      : h.status === 'no_face' ? '<span class="muted">No face</span>' : '<span class="muted">Unknown</span>';
    return `<li class="history-item ${cls}"><span class="hi-name">${label}</span><span class="hi-time">${h.time}</span></li>`;
  }).join('');
}

// -----------------------------------------------------------------
// Plate cam
// -----------------------------------------------------------------
let plateStreamActive = false;
let plateFlashOn = false;

function togglePlateStream() {
  if (!plateCamUrl) { alert('Plate cam config not loaded yet.'); return; }

  const streamImg   = document.getElementById('plateStreamImg');
  const previewImg  = document.getElementById('platePrevImg');
  const placeholder = document.getElementById('platePrevPlaceholder');
  const btn         = document.getElementById('plateStreamBtn');

  plateStreamActive = !plateStreamActive;

  if (plateStreamActive) {
    if (previewImg)  previewImg.style.display  = 'none';
    if (placeholder) placeholder.style.display = 'none';
    streamImg.src           = plateCamUrl + '/stream';
    streamImg.style.display = 'block';
    btn.innerHTML = '&#x23F9; Stop Stream';
    btn.classList.replace('btn-secondary', 'btn-primary');
  } else {
    streamImg.src           = '';
    streamImg.style.display = 'none';
    const hasSnap = previewImg && previewImg.src && !previewImg.src.endsWith(window.location.href);
    if (hasSnap) {
      previewImg.style.display = 'block';
    } else if (placeholder) {
      placeholder.style.display = '';
    }
    btn.innerHTML = '&#x1F4E1; Live Stream';
    btn.classList.replace('btn-primary', 'btn-secondary');
  }
}

async function togglePlateFlash() {
  const btn = document.getElementById('plateFlashBtn');
  setLoading(btn, true);
  try {
    const res  = await fetch('/api/plate/flash', { method: 'POST' });
    const data = await res.json();
    plateFlashOn = data.flash === 'on';
    btn.innerHTML = plateFlashOn ? '&#x1F4A1; Flash ON' : '&#x1F526; Flash';
    btn._origHTML = btn.innerHTML;
    if (plateFlashOn) {
      btn.classList.replace('btn-ghost', 'btn-secondary');
    } else {
      btn.classList.replace('btn-secondary', 'btn-ghost');
    }
  } catch (e) {
    alert('Flash control failed: ' + e.message);
  } finally {
    setLoading(btn, false);
  }
}

async function plateSnapshot() {
  const btn         = document.getElementById('plateSnapBtn');
  const previewImg  = document.getElementById('platePrevImg');
  const placeholder = document.getElementById('platePrevPlaceholder');

  setLoading(btn, true);
  try {
    const res = await fetch('/api/plate/preview');
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || 'Capture failed');
    const data = await res.json();
    previewImg.src = data.image;
    previewImg.style.display = 'block';
    if (placeholder) placeholder.style.display = 'none';
    if (plateStreamActive) togglePlateStream();
  } catch (err) {
    alert('Snapshot failed: ' + err.message);
  } finally {
    setLoading(btn, false);
  }
}

async function plateCapture() {
  const btn       = document.getElementById('plateCaptureBtn');
  const statusBox = document.getElementById('plateCaptureStatus');
  const personIn  = document.getElementById('platePersonInput');
  const person    = personIn ? personIn.value.trim() : '';

  setLoading(btn, true);
  setStatus(statusBox, 'loading', '⏳ Capturing plate…');

  try {
    const fd = new FormData();
    if (person) fd.append('person', person);
    const res  = await fetch('/api/plate/capture', { method: 'POST', body: fd });
    const data = await res.json();

    if (!res.ok) {
      setStatus(statusBox, 'error', '✗ ' + (data.detail || 'Capture failed'));
    } else {
      const who = data.person ? `"${escHtml(data.person)}"` : 'anonymous';
      setStatus(statusBox, 'success', `✓ Event logged for ${who}`);
      await loadPlateEvents();
    }
  } catch (err) {
    setStatus(statusBox, 'error', '✗ Network error: ' + err.message);
  } finally {
    setLoading(btn, false);
  }
}

function autofillLastIdentified() {
  const inp = document.getElementById('platePersonInput');
  if (!inp) return;
  let name = null;
  try { name = sessionStorage.getItem('lastIdentified'); } catch(_) {}
  name = name || _lastIdentifiedPerson;
  if (name) {
    inp.value = name;
    inp.dispatchEvent(new Event('input'));
  } else {
    alert('No identification result yet. Run identification first.');
  }
}

async function loadPlateEvents() {
  const list = document.getElementById('plateEventList');
  if (!list) return;

  list.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const res  = await fetch('/api/plate/events?limit=50');
    const data = await res.json();
    const events = data.events || [];

    if (events.length === 0) {
      list.innerHTML = '<p class="muted">No events logged yet.</p>';
      return;
    }

    list.innerHTML = events.map(ev => {
      const personLabel = ev.person
        ? `<span class="event-person">${escHtml(ev.person)}</span>`
        : `<span class="event-person unknown">Anonymous</span>`;
      const thumb = ev.photo
        ? `<img class="event-thumb" src="${escHtml(ev.photo)}" loading="lazy" alt="plate" onclick="viewPhoto('${escHtml(ev.photo)}',1,1)" />`
        : `<div class="event-thumb event-thumb-empty">&#x1F37D;</div>`;
      const ts = ev.timestamp ? new Date(ev.timestamp).toLocaleString() : '';
      return `
        <div class="event-item" id="ev-${escHtml(ev.id)}">
          ${thumb}
          <div class="event-info">
            ${personLabel}
            <div class="event-time">${escHtml(ts)}</div>
          </div>
          <button class="btn btn-danger btn-sm" onclick="deletePlateEvent('${escHtml(ev.id)}',this)">&#x2715;</button>
        </div>`;
    }).join('');
  } catch (err) {
    list.innerHTML = '<p class="muted" style="color:var(--danger)">Failed to load events.</p>';
  }
}

async function deletePlateEvent(id, btn) {
  setLoading(btn, true);
  try {
    const res = await fetch(`/api/plate/events/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res.ok) {
      await loadPlateEvents();
    } else {
      const data = await res.json().catch(() => ({}));
      alert(data.detail || 'Failed to delete event.');
      setLoading(btn, false);
    }
  } catch {
    alert('Network error.');
    setLoading(btn, false);
  }
}

// -----------------------------------------------------------------
// Pipeline page
// -----------------------------------------------------------------
let pipelineRecognizedPerson = null;
let pipelineFaceScore = null;

function pipelineSwitchTab(tab) {
  const runTab = document.getElementById('pipelineRunTab');
  const analyticsTab = document.getElementById('pipelineAnalyticsTab');
  const runBtn = document.getElementById('pipelineTabRunBtn');
  const analyticsBtn = document.getElementById('pipelineTabAnalyticsBtn');

  if (!runTab || !analyticsTab || !runBtn || !analyticsBtn) return;

  const showRun = tab === 'run';
  runTab.style.display = showRun ? '' : 'none';
  analyticsTab.style.display = showRun ? 'none' : '';
  runBtn.classList.toggle('active', showRun);
  analyticsBtn.classList.toggle('active', !showRun);

  if (!showRun) {
    loadPipelineAnalytics();
  }
}

function pipelineHandlePlateSelection() {
  const fileInput = document.getElementById('pipelinePlateFile');
  const img = document.getElementById('pipelinePlateImg');
  const placeholder = document.getElementById('pipelinePlatePlaceholder');
  if (!fileInput || !img || !placeholder) return;

  const file = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
  if (!file) {
    img.src = '';
    img.style.display = 'none';
    placeholder.style.display = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = function (e) {
    img.src = e.target && e.target.result ? String(e.target.result) : '';
    img.style.display = 'block';
    placeholder.style.display = 'none';
  };
  reader.readAsDataURL(file);
}

function pipelineResetUi() {
  pipelineRecognizedPerson = null;
  pipelineFaceScore = null;

  const uploadBtn = document.getElementById('pipelineUploadBtn');
  const personWrap = document.getElementById('pipelinePersonWrap');
  const faceStatus = document.getElementById('pipelineFaceStatus');
  const plateStatus = document.getElementById('pipelinePlateStatus');
  const uploadHint = document.getElementById('pipelineUploadHint');
  const readyNote = document.getElementById('pipelineReadyNote');

  const faceImg = document.getElementById('pipelineFaceImg');
  const facePlaceholder = document.getElementById('pipelineFacePlaceholder');
  const plateImg = document.getElementById('pipelinePlateImg');
  const platePlaceholder = document.getElementById('pipelinePlatePlaceholder');
  const plateFile = document.getElementById('pipelinePlateFile');

  if (uploadBtn) uploadBtn.disabled = true;
  if (personWrap) personWrap.style.display = 'none';
  if (faceStatus) faceStatus.style.display = 'none';
  if (plateStatus) plateStatus.style.display = 'none';
  if (readyNote) readyNote.style.display = 'none';

  if (uploadHint) {
    uploadHint.textContent = 'Please recognize a member first. Upload will unlock automatically.';
  }

  if (faceImg) {
    faceImg.src = '';
    faceImg.style.display = 'none';
  }
  if (facePlaceholder) facePlaceholder.style.display = '';

  if (plateImg) {
    plateImg.src = '';
    plateImg.style.display = 'none';
  }
  if (platePlaceholder) platePlaceholder.style.display = '';

  if (plateFile) {
    plateFile.value = '';
  }
}

async function pipelineStart() {
  const btn = document.getElementById('pipelineStartBtn');
  const statusBox = document.getElementById('pipelineFaceStatus');
  const previewImg = document.getElementById('pipelineFaceImg');
  const placeholder = document.getElementById('pipelineFacePlaceholder');
  const personWrap = document.getElementById('pipelinePersonWrap');
  const personName = document.getElementById('pipelinePersonName');
  const uploadBtn = document.getElementById('pipelineUploadBtn');
  const uploadHint = document.getElementById('pipelineUploadHint');
  const readyNote = document.getElementById('pipelineReadyNote');

  setLoading(btn, true);
  setStatus(statusBox, 'loading', 'Capturing face and running identification...');
  if (readyNote) readyNote.style.display = 'none';

  try {
    const res = await fetch('/api/pipeline/start', { method: 'POST' });
    const data = await res.json();

    if (!res.ok) {
      setStatus(statusBox, 'error', 'Pipeline start failed: ' + (data.detail || 'Server error'));
      pipelineRecognizedPerson = null;
      pipelineFaceScore = null;
      if (uploadBtn) uploadBtn.disabled = true;
      if (personWrap) personWrap.style.display = 'none';
      return;
    }

    if (data.image && previewImg) {
      previewImg.src = data.image;
      previewImg.style.display = 'block';
      if (placeholder) placeholder.style.display = 'none';
    }

    if (data.status === 'recognized') {
      pipelineRecognizedPerson = data.person;
      pipelineFaceScore = data.score;
      setStatus(statusBox, 'success', data.message + ' Please upload plate image to continue.');
      if (personName) personName.textContent = 'Recognized: ' + data.person;
      if (personWrap) personWrap.style.display = '';
      if (uploadBtn) uploadBtn.disabled = false;
      if (uploadHint) {
        uploadHint.textContent = 'Member recognized. Upload the plate image now.';
      }
    } else if (data.status === 'unknown') {
      pipelineRecognizedPerson = null;
      pipelineFaceScore = data.score;
      setStatus(statusBox, 'error', 'Face not recognized. Please enroll first.');
      if (personWrap) personWrap.style.display = 'none';
      if (uploadBtn) uploadBtn.disabled = true;
      if (uploadHint) {
        uploadHint.textContent = 'Recognition failed. Enroll this member, then retry.';
      }
    } else {
      pipelineRecognizedPerson = null;
      pipelineFaceScore = null;
      setStatus(statusBox, 'error', data.message || 'No face detected. Please try again.');
      if (personWrap) personWrap.style.display = 'none';
      if (uploadBtn) uploadBtn.disabled = true;
      if (uploadHint) {
        uploadHint.textContent = 'No face detected. Start again and ensure face is visible.';
      }
    }
  } catch (err) {
    setStatus(statusBox, 'error', 'Network error: ' + err.message);
    pipelineRecognizedPerson = null;
    pipelineFaceScore = null;
    if (uploadBtn) uploadBtn.disabled = true;
    if (personWrap) personWrap.style.display = 'none';
    if (uploadHint) {
      uploadHint.textContent = 'Connection issue. Retry face capture.';
    }
  } finally {
    setLoading(btn, false);
  }
}

async function pipelineUploadPlate() {
  const btn = document.getElementById('pipelineUploadBtn');
  const statusBox = document.getElementById('pipelinePlateStatus');
  const fileInput = document.getElementById('pipelinePlateFile');
  const readyNote = document.getElementById('pipelineReadyNote');

  if (!pipelineRecognizedPerson) {
    setStatus(statusBox, 'error', 'Run face recognition first.');
    return;
  }
  if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
    setStatus(statusBox, 'error', 'Please upload a plate image.');
    return;
  }

  setLoading(btn, true);
  setStatus(statusBox, 'loading', 'Uploading plate image, classifying waste, and controlling servo...');

  try {
    const fd = new FormData();
    fd.append('plate_photo', fileInput.files[0]);
    fd.append('person', pipelineRecognizedPerson);
    if (pipelineFaceScore !== null && pipelineFaceScore !== undefined) {
      fd.append('face_score', String(pipelineFaceScore));
    }

    const res = await fetch('/api/pipeline/upload_plate', { method: 'POST', body: fd });
    const data = await res.json();

    if (!res.ok) {
      setStatus(statusBox, 'error', data.detail || 'Pipeline upload failed.');
      return;
    }

    const event = data.event || {};
    const cat = event.waste_category;
    const servoStatus = event.servo && event.servo.status ? event.servo.status : 'unknown';
    setStatus(statusBox, 'success', 'Saved event. Waste category: ' + cat + '. Servo: ' + servoStatus + '.');
    await loadPipelineAnalytics();
    if (readyNote) {
      readyNote.style.display = '';
    }
    setTimeout(() => {
      pipelineResetUi();
      pipelineSwitchTab('run');
    }, 2600);
  } catch (err) {
    setStatus(statusBox, 'error', 'Network error: ' + err.message);
  } finally {
    setLoading(btn, false);
  }
}

async function loadPipelineAnalytics() {
  const stats = document.getElementById('pipelineStats');
  const list = document.getElementById('pipelineEventsList');
  if (!stats || !list) return;

  stats.innerHTML = '<p class="muted">Loading...</p>';
  list.innerHTML = '<p class="muted">Loading...</p>';

  try {
    const [sumRes, eventsRes] = await Promise.all([
      fetch('/api/pipeline/summary'),
      fetch('/api/pipeline/events?limit=25'),
    ]);
    const summary = await sumRes.json();
    const eventsData = await eventsRes.json();
    const counts = summary.category_counts || {};

    stats.innerHTML = `
      <div class="stat-card"><div class="stat-value">${summary.total_events || 0}</div><div class="stat-label">Total events</div></div>
      <div class="stat-card"><div class="stat-value">${counts['1'] || 0}</div><div class="stat-label">Category 1 (max waste)</div></div>
      <div class="stat-card"><div class="stat-value">${counts['2'] || 0}</div><div class="stat-label">Category 2</div></div>
      <div class="stat-card"><div class="stat-value">${counts['3'] || 0}</div><div class="stat-label">Category 3</div></div>
      <div class="stat-card"><div class="stat-value">${counts['4'] || 0}</div><div class="stat-label">Category 4 (minimal)</div></div>
    `;

    const events = eventsData.events || [];
    if (events.length === 0) {
      list.innerHTML = '<p class="muted">No pipeline events yet.</p>';
      return;
    }

    list.innerHTML = events.map(ev => {
      const who = ev.person ? escHtml(ev.person) : 'Unknown';
      const when = ev.timestamp ? escHtml(ev.timestamp) : '';
      const cat = ev.waste_category || '-';
      const servo = ev.servo && ev.servo.status ? escHtml(ev.servo.status) : 'unknown';
      const thumb = ev.plate_photo
        ? `<img class="event-thumb" src="${escHtml(ev.plate_photo)}" loading="lazy" alt="plate" onclick="viewPhoto('${escHtml(ev.plate_photo)}',1,1)" />`
        : '<div class="event-thumb event-thumb-empty">?</div>';

      return `
        <div class="event-item">
          ${thumb}
          <div class="event-info">
            <div class="event-person">${who}</div>
            <div class="event-time">${when}</div>
            <div class="event-time">Category: ${cat} | Servo: ${servo}</div>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    stats.innerHTML = '<p class="muted" style="color:var(--danger)">Failed to load summary.</p>';
    list.innerHTML = '<p class="muted" style="color:var(--danger)">Failed to load events.</p>';
  }
}

// -----------------------------------------------------------------
// Debug page
// -----------------------------------------------------------------
async function debugServoAction(action) {
  const statusBox = document.getElementById('debugServoStatus');
  const openBtn = document.getElementById('debugLidOpenBtn');
  const closeBtn = document.getElementById('debugLidCloseBtn');
  const btn = action === 'open' ? openBtn : closeBtn;

  if (!btn) return;

  setLoading(btn, true);
  setStatus(statusBox, 'loading', (action === 'open' ? 'Opening' : 'Closing') + ' lid...');

  try {
    const endpoint = action === 'open' ? '/api/debug/servo/open' : '/api/debug/servo/close';
    const res = await fetch(endpoint, { method: 'POST' });
    const data = await res.json();

    if (!res.ok) {
      setStatus(statusBox, 'error', 'Servo command failed: ' + (data.detail || 'Unknown error'));
      return;
    }

    const sent = data.sent_state ? ' (sent state=' + data.sent_state + ')' : '';
    setStatus(statusBox, 'success', 'Lid ' + action + ' command sent successfully' + sent + '.');
  } catch (err) {
    setStatus(statusBox, 'error', 'Network error: ' + err.message);
  } finally {
    setLoading(btn, false);
  }
}

// Explicitly expose pipeline hooks for pages that bind handlers dynamically.
if (typeof window !== 'undefined') {
  window.pipelineStart = pipelineStart;
  window.pipelineUploadPlate = pipelineUploadPlate;
  window.loadPipelineAnalytics = loadPipelineAnalytics;
  window.pipelineSwitchTab = pipelineSwitchTab;
  window.pipelineHandlePlateSelection = pipelineHandlePlateSelection;
  window.debugServoAction = debugServoAction;
}
