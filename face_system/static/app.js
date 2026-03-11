/* ============================================================
   FaceID – Frontend logic
   ============================================================ */

// -----------------------------------------------------------------
// ESP32 config (loaded once on pages that need the device)
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
