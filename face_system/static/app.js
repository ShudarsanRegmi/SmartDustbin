/* ============================================================
   FaceID – Frontend logic
   ============================================================ */

// -----------------------------------------------------------------
// ESP32 config (loaded once on pages that need the device)
// -----------------------------------------------------------------
let esp32BaseUrl = null;

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    esp32BaseUrl = data.esp32_base;
  } catch (e) {
    console.error('Failed to load device config:', e);
  }
}

// -----------------------------------------------------------------
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
      item.className = 'profile-item';
      item.innerHTML = `
        <div class="profile-avatar">${initials}</div>
        <div class="profile-info">
          <div class="profile-name">${escHtml(p.name)}</div>
          <div class="profile-meta">${p.photos} sample${p.photos !== 1 ? 's' : ''}${p.enrolled_at ? ' · ' + p.enrolled_at : ''}</div>
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
