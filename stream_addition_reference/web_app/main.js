import { CONFIG } from './config.js';
import { login, clearSession, getSession, getStreams, getCapturedImages, getDailyStats, getAnalyticsData, getImageUrl, updateEvent, deleteEvent, updatePassword, checkMongoHealth, checkImageHealth, setupRealtimeUpdates, teardownRealtimeUpdates, getAnalyticsConfig, saveAnalyticsConfig } from './data.js';

let currentPage = 'login';

function navigateTo(page) {
  currentPage = page;
  const header = document.getElementById('header');
  
  document.querySelectorAll('.page-view').forEach(el => el.style.display = 'none');
  const activePage = document.getElementById('page-' + page);
  if (!activePage) return;
  activePage.style.display = 'block';

  if (page === 'login') {
    header.style.display = 'none';
    if (!activePage.innerHTML) {
      activePage.innerHTML = renderLogin();
      bindLogin();
    }
  } else {
    header.style.display = 'flex';
    document.getElementById('user-label').textContent = '👤 ' + getSession().username;
    document.querySelectorAll('.nav-link').forEach(b => b.classList.toggle('active', b.dataset.page === page));
    
    if (page === 'stream') {
      if (!activePage.innerHTML) {
        activePage.innerHTML = '<div style="display:flex;justify-content:center;align-items:center;height:60vh;color:#94a3b8;font-size:16px">Loading Console…</div>';
        loadPage(page, activePage);
      }
    } else {
      activePage.innerHTML = '<div style="display:flex;justify-content:center;align-items:center;height:60vh;color:#94a3b8;font-size:16px">Loading…</div>';
      loadPage(page, activePage);
    }
  }
}

async function loadPage(page, content) {
  try {
    switch (page) {
      case 'stream': { const [streams, recent, stats] = await Promise.all([getStreams(), getCapturedImages(CONFIG.RECENT_LIMIT), getDailyStats()]); content.innerHTML = renderStream(streams, recent, stats); bindStream(streams); break; }
      case 'gallery': { const data = await getCapturedImages(0, getGalleryFilters()); content.innerHTML = renderGallery(data); bindGallery(); break; }
      case 'analytics': { const a = await getAnalyticsData('all'); content.innerHTML = renderAnalytics(a); bindAnalytics(a); break; }
      case 'settings': { const streams = await getStreams(); content.innerHTML = renderSettings(streams); bindSettings(); break; }
      case 'home': content.innerHTML = renderGuide(); break;
    }
  } catch (err) { content.innerHTML = `<div style="padding:40px;color:#ef4444">Error: ${err.message}</div>`; }
}

function initApp() {
  document.getElementById('app').innerHTML = `
    <div class="header" id="header" style="display:none">
      <div class="logo-box"><span class="logo-text">StreamUX</span><span style="color:#94a3b8;font-weight:700;font-size:16px;margin-left:8px">AI Building</span></div>
      <div class="nav-links">
        <button class="nav-link" data-page="stream">🎥 Console</button>
        <button class="nav-link" data-page="gallery">📋 Logs</button>
        <button class="nav-link" data-page="analytics">📊 Analytics</button>
        <button class="nav-link" data-page="settings">⚙ Settings</button>
        <button class="nav-link" data-page="home">📖 Guide</button>
      </div>
      <div class="header-right">
        <span class="user-label" id="user-label"></span>
        <button class="logout-btn" id="btn-logout">Sign Out</button>
      </div>
    </div>
    <div class="content" id="content">
      <div id="page-login" class="page-view" style="display:none; height:100%"></div>
      <div id="page-stream" class="page-view" style="display:none; height:100%"></div>
      <div id="page-gallery" class="page-view" style="display:none; height:100%"></div>
      <div id="page-analytics" class="page-view" style="display:none; height:100%"></div>
      <div id="page-settings" class="page-view" style="display:none; height:100%"></div>
      <div id="page-home" class="page-view" style="display:none; height:100%"></div>
    </div>`;
  document.querySelectorAll('.nav-link').forEach(b => b.addEventListener('click', () => navigateTo(b.dataset.page)));
  document.getElementById('btn-logout').addEventListener('click', () => { clearSession(); navigateTo('login'); });
  navigateTo('login');
}

// ── LOGIN ──
function renderLogin() {
  return `<div class="login-page"><div class="login-bg-overlay"></div><div class="auth-glass-card">
    <div class="glass-title">Welcome Back</div><div class="glass-subtitle">Sign in to access your dashboard</div>
    <form id="login-form" style="margin-top:20px">
      <div class="login-form-group"><div class="glass-field-label">ACCOUNT</div><input class="glass-input" id="login-user" placeholder="Enter username" autocomplete="username" /></div>
      <div class="login-form-group"><div class="glass-field-label">PASSWORD</div><input class="glass-input" id="login-pass" type="password" placeholder="Enter password" autocomplete="current-password" /></div>
      <div class="glass-error" id="login-error"></div>
      <button type="submit" class="glass-btn" id="login-btn">Sign In →</button>
    </form><div class="glass-footer">StreamUX Enterprise · v2.0</div></div></div>`;
}
function bindLogin() {
  document.getElementById('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const u = document.getElementById('login-user').value, p = document.getElementById('login-pass').value;
    if (!u || !p) { document.getElementById('login-error').textContent = 'Please enter both username and password.'; return; }
    const btn = document.getElementById('login-btn');
    btn.textContent = 'Authenticating…'; btn.disabled = true;
    try { await login(u, p); navigateTo('stream'); }
    catch (err) { document.getElementById('login-error').textContent = err.message || 'Invalid credentials. Access denied.'; }
    btn.textContent = 'Sign In →'; btn.disabled = false;
  });
}

// ── STREAM / CONSOLE ──
function renderStream(streams, recent, stats) {
  const gridClass = streams.length <= 1 ? 'g1' : streams.length <= 2 ? 'g2' : 'g4';
  return `<div class="stream-layout">
    <div class="stream-main">
      <div class="stat-row">
        <div class="stat-card">
          <div class="stat-card-title">TOTAL TODAY</div>
          <div class="kpi-value-sm" id="stat-total">${stats.total || 0}</div>
        </div>
        <div class="stat-card">
          <div style="display:flex;justify-content:space-between">
            <div class="stat-card-title">VERIFIED</div>
            <div class="badge-done">✓ DONE</div>
          </div>
          <div class="kpi-value-sm" id="stat-verified">${stats.verified || 0}</div>
        </div>
        <div class="stat-card">
          <div style="display:flex;justify-content:space-between">
            <div class="stat-card-title">PENDING</div>
            <div class="badge-wait">⏳ WAIT</div>
          </div>
          <div class="kpi-value-sm" id="stat-pending">${stats.pending || 0}</div>
        </div>
      </div>
      <div class="video-grid ${gridClass}" id="video-grid">
        ${streams.map(s => `<div class="video-cell" id="cell-${s.stream_id}">
          <span class="stream-label">CAM ${s.stream_id + 1}</span>
          <iframe src="${s.webrtc_url || CONFIG.WEBRTC_BASE + '/stream' + (s.stream_id + 1) + '/'}" allow="autoplay" allowfullscreen style="width:100%;height:100%;border:none;object-fit:cover;display:block"></iframe>
          <canvas class="stream-overlay" id="overlay-${s.stream_id}" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:5;"></canvas>
        </div>`).join('')}
      </div>
    </div>
    <div class="stream-sidebar">
      <div class="sidebar-title">Recent Activity<br><span style="font-size:12px;font-weight:400;color:var(--text-dim)">Latest event recordings</span></div>
      <div class="recent-list" id="recent-list">
        ${recent.length === 0 ? '<div class="empty-state">No captured images found.</div>' :
          recent.map(e => `<div class="recent-entry-row" data-id="${e.id}">
            <img class="thumb-img" src="${getImageUrl(e.image_path)}" onerror="this.style.background='#cbd5e1'" alt="" />
            <div style="flex:1;min-width:0">
              <div style="display:flex;gap:6px;align-items:center">
                <span class="bold" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${e.event_type}</span>
                <span class="${e.is_verified ? 'badge-in' : 'badge-out'}">${e.area_name}</span>
              </div>
              <div class="text-dim" style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Stream ${e.stream_id} · ${e.date} ${e.time}</div>
            </div>
          </div>`).join('')}
      </div>
    </div>
  </div>`;
}
function bindStream(streams) {
  // Draw Overlays
  streams.forEach(async s => {
    const canvas = document.getElementById('overlay-' + s.stream_id);
    if (!canvas) return;
    const config = await getAnalyticsConfig(s.stream_id);
    
    // Bind drawOverlay to the stream object so the realtime loop can call it
    s.drawOverlay = async () => {
      const liveConfig = await getAnalyticsConfig(s.stream_id);
      
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      const videoW = liveConfig.config_width || 1280;
      const videoH = liveConfig.config_height || 720;
      const cellW = canvas.width;
      const cellH = canvas.height;
      
      const scaleX = cellW / videoW;
      const scaleY = cellH / videoH;
      
      const tx = (x) => x * scaleX;
      const ty = (y) => y * scaleY;
      
      // Draw ROIs (Polygons)
      if (liveConfig.rois) {
        liveConfig.rois.forEach(roi => {
          if (!roi.coords || roi.coords.length < 6) return;
          ctx.beginPath();
          ctx.moveTo(tx(roi.coords[0]), ty(roi.coords[1]));
          for (let i = 2; i < roi.coords.length; i += 2) {
            ctx.lineTo(tx(roi.coords[i]), ty(roi.coords[i+1]));
          }
          ctx.closePath();
          
          ctx.fillStyle = 'rgba(79, 70, 229, 0.25)'; // Indigo/Blue translucent
          ctx.fill();
          ctx.strokeStyle = '#4f46e5';
          ctx.lineWidth = 2;
          ctx.stroke();
          
          ctx.fillStyle = '#4f46e5';
          ctx.font = 'bold 12px Inter';
          const display_text = `${roi.name} (${roi.count || 0})`;
          ctx.fillText(display_text, tx(roi.coords[0]), ty(roi.coords[1]) - 4);
        });
      }
      
      // Draw Lines
      if (liveConfig.lines) {
        liveConfig.lines.forEach(line => {
          if (!line.coords || line.coords.length < 4) return;
          
          ctx.beginPath();
          ctx.moveTo(tx(line.coords[0]), ty(line.coords[1]));
          ctx.lineTo(tx(line.coords[2]), ty(line.coords[3]));
          ctx.strokeStyle = '#f43f5e'; // Rose/Red
          ctx.lineWidth = 2;
          ctx.stroke();
          
          if (line.coords.length >= 8) {
            ctx.beginPath();
            ctx.strokeStyle = 'rgba(244, 63, 94, 0.6)'; // Translucent red for arrow
            const x1 = tx(line.coords[4]);
            const y1 = ty(line.coords[5]);
            const x2 = tx(line.coords[6]);
            const y2 = ty(line.coords[7]);
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            
            const angle = Math.atan2(y2 - y1, x2 - x1);
            const headLen = 6;
            ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI/6), y2 - headLen * Math.sin(angle - Math.PI/6));
            ctx.moveTo(x2, y2);
            ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI/6), y2 - headLen * Math.sin(angle + Math.PI/6));
            ctx.stroke();
          }
          
          ctx.fillStyle = '#f43f5e';
          ctx.font = 'bold 12px Inter';
          const display_text = `${line.name} (${line.count || 0})`;
          ctx.fillText(display_text, tx(line.coords[0]), ty(line.coords[1]) - 4);
        });
      }
    };
    
    s.drawOverlay();
    window.addEventListener('resize', () => {
      if (currentPage === 'stream') s.drawOverlay();
    });
  });

  setupRealtimeUpdates(async () => {
    try {
      const [recent, stats] = await Promise.all([getCapturedImages(CONFIG.RECENT_LIMIT), getDailyStats()]);
      const elTot = document.getElementById('stat-total');
      const elVer = document.getElementById('stat-verified');
      const elPen = document.getElementById('stat-pending');
      if (elTot) elTot.textContent = stats.total || 0;
      if (elVer) elVer.textContent = stats.verified || 0;
      if (elPen) elPen.textContent = stats.pending || 0;
      
      const list = document.getElementById('recent-list');
      if (!list) return;
      
      // Update canvas overlays
      streams.forEach(s => {
        if (s.drawOverlay) s.drawOverlay();
      });
      
      list.innerHTML = recent.length === 0 ? '<div class="empty-state">No captured images found.</div>' :
          recent.map(e => `<div class="recent-entry-row" data-id="${e.id}">
            <img class="thumb-img" src="${getImageUrl(e.image_path)}" onerror="this.style.background='#cbd5e1'" alt="" />
            <div style="flex:1;min-width:0">
              <div style="display:flex;gap:6px;align-items:center">
                <span class="bold" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${e.event_type}</span>
                <span class="${e.is_verified ? 'badge-in' : 'badge-out'}">${e.area_name}</span>
              </div>
              <div class="text-dim" style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Stream ${e.stream_id} · ${e.date} ${e.time}</div>
            </div>
          </div>`).join('');
          
      list.querySelectorAll('.recent-entry-row').forEach(row => {
        row.addEventListener('click', () => showEditEntryDialog(row.dataset.id));
      });
    } catch(e) {}
  });
  
  // Attach for initial render
  document.querySelectorAll('#recent-list .recent-entry-row').forEach(row => {
    row.addEventListener('click', () => showEditEntryDialog(row.dataset.id));
  });
}

// ── EDIT MODAL ──
async function showEditEntryDialog(id) {
  const evt = await getCapturedImages(0).then(d => d.find(e => e.id === id));
  if (!evt) return;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(15,23,42,0.6);display:flex;align-items:center;justify-content:center;z-index:999;backdrop-filter:blur(4px);';
  overlay.innerHTML = `
    <div style="background:var(--bg-card);border-radius:12px;padding:24px;width:500px;box-shadow:0 24px 48px rgba(0,0,0,0.2);border:1px solid var(--border)">
      <h3 style="margin-bottom:16px;font-weight:800;font-size:18px;color:var(--bg-dark)">Event Details</h3>
      <img src="${getImageUrl(evt.image_path)}" style="width:100%;border-radius:8px;background:#000;margin-bottom:16px;max-height:300px;object-fit:contain" />
      <div style="display:flex;justify-content:space-between;margin-bottom:8px">
        <span style="font-weight:700">Area:</span> <span style="color:var(--text-dim)">${evt.area_name}</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:8px">
        <span style="font-weight:700">Status:</span> <span class="${evt.is_verified ? 'badge-in' : 'badge-out'}">${evt.is_verified ? 'Verified' : 'Pending'}</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:24px">
        <span style="font-weight:700">Time:</span> <span style="color:var(--text-dim)">${evt.date} ${evt.time}</span>
      </div>
      <div style="display:flex;gap:12px;justify-content:flex-end">
        <button id="modal-reject" style="padding:10px 20px;border-radius:8px;background:#fef2f2;color:#ef4444;border:1px solid #fecaca;font-weight:700;cursor:pointer;flex:1">Reject</button>
        <button id="modal-verify" style="padding:10px 20px;border-radius:8px;background:#ecfdf5;color:#10b981;border:1px solid #a7f3d0;font-weight:700;cursor:pointer;flex:1">Verify</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  
  const close = () => document.body.removeChild(overlay);
  overlay.addEventListener('click', (e) => { if(e.target === overlay) close(); });
  
  document.getElementById('modal-verify').addEventListener('click', async () => {
    await updateEvent(id, { is_verified: true });
    close();
    // Trigger UI reload of current page
    navigateTo(currentPage);
  });
  document.getElementById('modal-reject').addEventListener('click', async () => {
    await updateEvent(id, { is_verified: false });
    close();
    navigateTo(currentPage);
  });
}

// ── GALLERY / LOGS ──
let galleryPage = 1, gallerySort = { col: -1, asc: false };
function renderGallery(data) {
  if (gallerySort.col >= 0) {
    const cols = ['image_path','event_type','area_name','class_id','stream_id','date','time','is_verified'];
    const k = cols[gallerySort.col];
    data.sort((a, b) => { let c = typeof a[k] === 'number' ? a[k] - b[k] : String(a[k]).localeCompare(String(b[k])); return gallerySort.asc ? c : -c; });
  }
  const perPage = 50, totalPages = Math.max(1, Math.ceil(data.length / perPage));
  if (galleryPage > totalPages) galleryPage = totalPages;
  const start = (galleryPage - 1) * perPage, page = data.slice(start, start + perPage);
  const hcols = ['IMAGE','EVENT','AREA','CLASS','STREAM','DATE','TIME','VERIFIED',''];
  return `<div class="gallery-page">
    <div><span class="page-title">Event Logs</span><br><span class="page-subtitle">Browse, filter, and export detection records</span></div>
    <div class="gallery-toolbar">
      <input id="f-event" placeholder="Event type..." value="${_fv('f-event')}" />
      <input id="f-area" placeholder="Area..." value="${_fv('f-area')}" />
      <select id="f-verified"><option value="">All</option><option value="yes">Verified</option><option value="no">Pending</option></select>
      <input id="f-startdate" type="date" value="${_fv('f-startdate')}" />
      <input id="f-enddate" type="date" value="${_fv('f-enddate')}" />
      <button class="btn-secondary" id="btn-reset-sort">↻ Reset Sort</button>
      <button class="btn-secondary" id="btn-export">📥 Export CSV</button>
      <span class="count-label">Showing ${start+1}–${Math.min(start+perPage, data.length)} of ${data.length}</span>
    </div>
    <div style="overflow:auto;flex:1"><table class="gallery-table">
      <thead><tr>${hcols.map((c, i) => { let a = i < 8 ? ' ⇕' : ''; if (gallerySort.col === i) a = gallerySort.asc ? ' ▲' : ' ▼'; return `<th data-col="${i}">${c}${a}</th>`; }).join('')}</tr></thead>
      <tbody>${page.map(e => `<tr>
        <td><img class="thumb" src="${getImageUrl(e.image_path)}" onerror="this.style.background='#cbd5e1'" alt="" /></td>
        <td><strong>${e.event_type}</strong></td><td class="text-dim">${e.area_name}</td>
        <td class="text-dim">${e.class_id}</td><td class="text-dim">${e.stream_id}</td>
        <td class="text-dim">📅 ${e.date}</td><td class="text-dim">🕐 ${e.time}</td>
        <td><span class="${e.is_verified ? 'badge-in' : 'badge-out'}">${e.is_verified ? '● Verified' : '● Pending'}</span></td>
        <td><button class="btn-action-edit" data-id="${e.id}">Edit</button> <button class="btn-action-delete" data-id="${e.id}">Delete</button></td>
      </tr>`).join('')}</tbody></table></div>
    <div class="pagination" id="pagination">${renderPagination(totalPages)}</div>
  </div>`;
}
let _savedFilters = {};
function _fv(id) { return _savedFilters[id] || ''; }
function getGalleryFilters() {
  const el = id => { const e = document.getElementById(id); const v = e ? e.value : (_savedFilters[id] || ''); _savedFilters[id] = v; return v; };
  return { event_type: el('f-event'), area_name: el('f-area'), verified: el('f-verified'), start_date: el('f-startdate'), end_date: el('f-enddate') };
}
function renderPagination(total) {
  let html = `<button data-p="${galleryPage-1}" ${galleryPage<=1?'disabled':''}>&#60;</button>`;
  const s = Math.max(1, galleryPage - 2), e = Math.min(total, galleryPage + 2);
  if (s > 1) { html += `<button data-p="1">1</button>`; if (s > 2) html += `<button disabled>...</button>`; }
  for (let p = s; p <= e; p++) html += `<button data-p="${p}" class="${p===galleryPage?'active':''}">${p}</button>`;
  if (e < total) { if (e < total - 1) html += `<button disabled>...</button>`; html += `<button data-p="${total}">${total}</button>`; }
  html += `<button data-p="${galleryPage+1}" ${galleryPage>=total?'disabled':''}>&#62;</button>`;
  return html;
}
function bindGallery() {
  document.querySelectorAll('.gallery-table th').forEach(th => th.addEventListener('click', () => {
    const c = parseInt(th.dataset.col); if (c >= 8) return;
    if (gallerySort.col === c) { gallerySort.asc ? (gallerySort.asc = false) : (gallerySort.col = -1); } else { gallerySort.col = c; gallerySort.asc = true; }
    navigateTo('gallery');
  }));
  ['f-event','f-area','f-verified','f-startdate','f-enddate'].forEach(id => {
    const el = document.getElementById(id); if (el) el.addEventListener('input', () => { galleryPage = 1; navigateTo('gallery'); });
  });
  document.getElementById('btn-reset-sort')?.addEventListener('click', () => { gallerySort = { col: -1, asc: false }; _savedFilters = {}; navigateTo('gallery'); });
  document.getElementById('pagination')?.addEventListener('click', e => { const p = parseInt(e.target.dataset?.p); if (p && !isNaN(p)) { galleryPage = p; navigateTo('gallery'); } });
  document.getElementById('btn-export')?.addEventListener('click', async () => {
    const data = await getCapturedImages(0, getGalleryFilters());
    const csv = ['id,event_type,area_name,class_id,stream_id,date,time,verified', ...data.map(e => `${e.id},${e.event_type},${e.area_name},${e.class_id},${e.stream_id},${e.date},${e.time},${e.is_verified}`)].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'export.csv'; a.click();
  });
  // Edit / Delete handlers
  document.querySelectorAll('.btn-action-edit').forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.dataset.id;
    const evt = await getCapturedImages(0).then(d => d.find(e => e.id === id));
    if (!evt) return;
    const newStatus = !evt.is_verified;
    await updateEvent(id, { is_verified: newStatus });
    navigateTo('gallery');
  }));
  document.querySelectorAll('.btn-action-delete').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Delete this event?')) return;
    await deleteEvent(btn.dataset.id);
    navigateTo('gallery');
  }));
}

// ── ANALYTICS ──
function renderAnalytics(a) {
  return `<div class="analytics-page">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <div style="flex:1"><span class="page-title">Analytics Dashboard</span><br><span class="page-subtitle">ROI detection and event distribution analysis</span></div>
      <button class="btn-primary" id="btn-edit-shapes">✏️ Edit Shapes</button>
      <span class="bold">Date Range:</span>
      <select class="filter-dd" id="an-date"><option value="all">All Time</option><option value="today">Today</option><option value="7d">Last 7 Days</option><option value="30d">Last 30 Days</option></select>
      <button class="btn-secondary" id="an-refresh">↻ Refresh</button>
    </div>
    <div class="kpi-row">
      <div class="kpi-card"><div class="kpi-label">TOTAL EVENTS</div><div class="kpi-value-sm text-blue" id="an-total">${a.total}</div></div>
      <div class="kpi-card"><div class="kpi-label">VERIFICATION STATUS</div>
        <div style="display:flex;gap:20px"><div><div class="text-emerald" style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px">VERIFIED</div><div class="kpi-value-sm text-emerald" id="an-verif">${a.verified}</div></div>
        <div><div class="text-rose" style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px">PENDING</div><div class="kpi-value-sm text-rose" id="an-pend">${a.pending}</div></div></div></div>
      <div class="kpi-card"><div class="kpi-label">LAST 7 DAYS</div>
        <div style="display:flex;gap:20px"><div><div class="text-emerald" style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px">TOTAL</div><div class="kpi-value-sm text-emerald" id="an-wktot">${a.weekTotal}</div></div>
        <div><div class="text-rose" style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px">VERIFIED</div><div class="kpi-value-sm text-rose" id="an-wkver">${a.weekVerified}</div></div></div></div>
    </div>
    <div class="charts-row">
      <div class="chart-card"><div class="bold">Event Distribution</div><div class="text-dim">Breakdown by event type</div><canvas id="chart-events"></canvas></div>
      <div class="chart-card"><div class="bold">Verification Status</div><div class="text-dim">Verified vs Unverified</div><canvas id="chart-verif"></canvas></div>
    </div>
    <div class="charts-row">
      <div class="chart-card"><div class="bold">Area Hotspots</div><div class="text-dim">Events per area</div><canvas id="chart-areas"></canvas></div>
      <div class="chart-card"><div class="bold">Stream Distribution</div><div class="text-dim">Events per camera</div><canvas id="chart-streams"></canvas></div>
    </div>
  </div>`;
}
function drawPie(canvasId, data) {
  const canvas = document.getElementById(canvasId); if (!canvas) return;
  const ctx = canvas.getContext('2d'); canvas.width = canvas.offsetWidth * 2; canvas.height = 480; ctx.scale(2, 2);
  const w = canvas.offsetWidth, h = 240, entries = Object.entries(data);
  if (!entries.length) { ctx.fillStyle = '#94a3b8'; ctx.font = '13px Inter'; ctx.textAlign = 'center'; ctx.fillText('No data available', w/2, h/2); return; }
  const total = entries.reduce((s, [, v]) => s + v, 0), colors = ['#4f46e5', '#10b981', '#f56565', '#f59e0b', '#8b5cf6', '#0ea5e9'];
  let angle = -Math.PI / 2; const cx = w / 2 - 70, cy = h / 2, r = Math.min(cx, cy) - 20;
  entries.forEach(([k, v], i) => {
    const a = (2 * Math.PI * v) / total; ctx.fillStyle = colors[i % colors.length];
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, angle, angle + a); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, angle, angle + a); ctx.stroke();
    const ly = cy - entries.length * 11 + i * 22;
    ctx.fillStyle = colors[i % colors.length]; ctx.fillRect(cx + r + 30, ly, 10, 10);
    ctx.fillStyle = '#1e293b'; ctx.font = '12px Inter'; ctx.textAlign = 'left';
    ctx.fillText(`${k} (${Math.round(100 * v / total)}%)`, cx + r + 46, ly + 10); angle += a;
  });
}
function bindAnalytics(initialData) {
  const refresh = async () => {
    const dateVal = document.getElementById('an-date')?.value || 'all';
    const a = await getAnalyticsData(dateVal);
    document.getElementById('an-total').textContent = a.total;
    document.getElementById('an-verif').textContent = a.verified;
    document.getElementById('an-pend').textContent = a.pending;
    document.getElementById('an-wktot').textContent = a.weekTotal;
    document.getElementById('an-wkver').textContent = a.weekVerified;
    drawPie('chart-events', a.eventCounts); drawPie('chart-verif', a.verifCounts);
    drawPie('chart-areas', a.areaCounts); drawPie('chart-streams', a.streamCounts);
  };
  // Draw initial charts
  drawPie('chart-events', initialData.eventCounts); drawPie('chart-verif', initialData.verifCounts);
  drawPie('chart-areas', initialData.areaCounts); drawPie('chart-streams', initialData.streamCounts);
  document.getElementById('an-date')?.addEventListener('change', refresh);
  document.getElementById('an-refresh')?.addEventListener('click', refresh);
  document.getElementById('btn-edit-shapes')?.addEventListener('click', async () => {
    const content = document.getElementById('content');
    content.innerHTML = '<div style="display:flex;justify-content:center;align-items:center;height:60vh;">Loading Editor...</div>';
    const streams = await getStreams();
    content.innerHTML = renderAnalyticsEditor(streams);
    bindAnalyticsEditor(streams);
  });
}

function renderAnalyticsEditor(streams) {
  return `<div class="analytics-page">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
      <button class="btn-secondary" id="btn-back-an">← Back to Analytics</button>
      <div style="flex:1"><span class="page-title">Analytics Editor</span></div>
      <select class="filter-dd" id="ed-stream-sel">${streams.map(s => `<option value="${s.stream_id}">Camera ${s.stream_id + 1}</option>`).join('')}</select>
      <button class="btn-secondary" id="btn-clear-shape">Clear</button>
      <button class="btn-save" id="btn-save-shape">Save Configuration</button>
    </div>
    <div style="position:relative; width:800px; height:450px; background:#1e293b; border-radius:8px; overflow:hidden; margin:0 auto; box-shadow:0 4px 6px rgba(0,0,0,0.3)">
      <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#64748b;font-weight:bold;z-index:1">Camera Feed Placeholder</div>
      <canvas id="ed-canvas" width="800" height="450" style="position:absolute;top:0;left:0;z-index:10;cursor:crosshair"></canvas>
    </div>
    <div style="text-align:center;margin-top:16px;color:#94a3b8;font-size:13px">Click on the canvas to draw a Region of Interest (Polygon). Close the shape to finish.</div>
  </div>`;
}

function bindAnalyticsEditor(streams) {
  document.getElementById('btn-back-an')?.addEventListener('click', () => navigateTo('analytics'));
  const canvas = document.getElementById('ed-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let points = [];
  let currentStreamId = streams.length > 0 ? streams[0].stream_id : 0;
  
  const draw = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (points.length === 0) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    if (points.length > 2) ctx.closePath();
    ctx.fillStyle = 'rgba(16, 185, 129, 0.2)';
    ctx.fill();
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 2;
    ctx.stroke();
    points.forEach(p => {
      ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI*2);
      ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke();
    });
  };

  const loadConfig = async (sid) => {
    points = []; draw();
    const conf = await getAnalyticsConfig(sid);
    if (conf.raw_text) {
      try { points = JSON.parse(conf.raw_text); } catch(e) {}
    }
    draw();
  };

  document.getElementById('ed-stream-sel')?.addEventListener('change', e => {
    currentStreamId = parseInt(e.target.value);
    loadConfig(currentStreamId);
  });

  canvas.addEventListener('mousedown', e => {
    const rect = canvas.getBoundingClientRect();
    points.push({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    draw();
  });

  document.getElementById('btn-clear-shape')?.addEventListener('click', () => { points = []; draw(); });
  document.getElementById('btn-save-shape')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-save-shape');
    btn.textContent = 'Saving...';
    await saveAnalyticsConfig(currentStreamId, { raw_text: JSON.stringify(points), config_width: 800, config_height: 450 });
    btn.textContent = '✓ Saved';
    setTimeout(() => btn.textContent = 'Save Configuration', 2000);
  });

  if (streams.length > 0) loadConfig(currentStreamId);
}

// ── SETTINGS ──
function renderSettings(streams) {
  return `<div class="settings-page"><div class="settings-content"><div class="settings-inner">
    <div><span class="page-title">Settings</span><br><span class="page-subtitle">Manage camera, storage, security, and display preferences</span></div>
    <div style="margin-top:20px">
      <div class="settings-section" id="sec-camera"><h3>Camera Source</h3><div class="subtitle">Configure camera streams and RTSP URLs</div><div class="sep"></div>
        ${streams.map((s, i) => `<div class="field-row"><span class="field-label">STREAM ${i + 1} URL</span><input id="stream-url-${i}" value="${s.webrtc_url || s.rtsp_url || ''}" /></div>`).join('')}
      </div>
      <div class="settings-section" id="sec-display"><h3>Display & Maintenance</h3><div class="subtitle">Retention and sidebar preferences</div><div class="sep"></div>
        <div class="field-row"><span class="field-label">RETENTION DAYS</span><input value="30" /></div>
        <div class="field-row"><span class="field-label">RECENT LIMIT</span><input type="number" value="${CONFIG.RECENT_LIMIT}" /></div>
      </div>
      <div class="settings-section" id="sec-image"><h3>Image Server Connection</h3><div class="subtitle">Remote image host health status</div><div class="sep"></div>
        <div class="field-row"><span class="field-label">IMAGE HOST</span><input value="${CONFIG.MONGO_IMAGE_HOST}" readonly /></div>
        <button class="btn-secondary" id="btn-check-image">Check Connection</button> <span id="img-health-status"></span>
      </div>
      <div class="settings-section" id="sec-mongo"><h3>MongoDB Connection</h3><div class="subtitle">Remote database health status</div><div class="sep"></div>
        <div class="field-row"><span class="field-label">MONGO STATUS</span><input value="Connected via API server" readonly style="background:#f8fafc;cursor:default" /></div>
        <button class="btn-secondary" id="btn-check-mongo">Check Connection</button> <span id="mongo-health-status"></span>
      </div>
      <div class="settings-section" id="sec-security"><h3>Security</h3><div class="subtitle">Change your login credentials</div><div class="sep"></div>
        <div class="field-row"><span class="field-label">CURRENT PASSWORD</span><input type="password" id="pw-current" /></div>
        <div class="field-row"><span class="field-label">NEW PASSWORD</span><input type="password" id="pw-new" /></div>
        <div class="field-row"><span class="field-label">CONFIRM</span><input type="password" id="pw-confirm" /></div>
        <div id="pw-msg" style="margin-top:4px"></div>
        <div style="text-align:right;margin-top:8px"><button class="btn-secondary" id="btn-pw">Update Password</button></div>
      </div>
    </div>
    <button class="btn-save" id="btn-apply" style="margin-top:16px">Apply Settings</button>
  </div></div>
  <div class="settings-nav" id="settings-nav">
    <button class="settings-nav-btn active" data-target="sec-camera">Camera Source</button>
    <button class="settings-nav-btn" data-target="sec-display">Display & Maintenance</button>
    <button class="settings-nav-btn" data-target="sec-image">Image Server</button>
    <button class="settings-nav-btn" data-target="sec-mongo">MongoDB</button>
    <button class="settings-nav-btn" data-target="sec-security">Security</button>
  </div></div>`;
}
function bindSettings() {
  document.querySelectorAll('.settings-nav-btn').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.settings-nav-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active');
    document.getElementById(btn.dataset.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  document.getElementById('btn-apply')?.addEventListener('click', () => { const b = document.getElementById('btn-apply'); b.textContent = '✓ Saved'; setTimeout(() => b.textContent = 'Apply Settings', 2000); });
  document.getElementById('btn-check-mongo')?.addEventListener('click', async () => { const ok = await checkMongoHealth(); document.getElementById('mongo-health-status').textContent = ok ? '✅ Connected' : '❌ Unreachable'; });
  document.getElementById('btn-check-image')?.addEventListener('click', async () => { const ok = await checkImageHealth(); document.getElementById('img-health-status').textContent = ok ? '✅ Reachable' : '❌ Unreachable'; });
  document.getElementById('btn-pw')?.addEventListener('click', async () => {
    const cur = document.getElementById('pw-current').value, nw = document.getElementById('pw-new').value, cf = document.getElementById('pw-confirm').value;
    const msg = document.getElementById('pw-msg');
    if (!cur || !nw) { msg.textContent = 'Fill all fields'; msg.style.color = '#ef4444'; return; }
    if (nw !== cf) { msg.textContent = 'Passwords do not match'; msg.style.color = '#ef4444'; return; }
    try { await updatePassword(cur, nw); msg.textContent = '✅ Password updated'; msg.style.color = '#10b981'; } catch (e) { msg.textContent = '❌ ' + e.message; msg.style.color = '#ef4444'; }
  });
}

// ── GUIDE ──
function renderGuide() {
  const steps = [
    { icon: '🎥', step: 'STEP 1', title: 'Live Stream', desc: 'Navigate to Console to view the live camera feed and monitor areas in real-time.' },
    { icon: '📊', step: 'STEP 2', title: 'View Analytics', desc: 'Check the Analytics tab for automatic visual distributions of traffic patterns and trends.' },
    { icon: '🔍', step: 'STEP 3', title: 'Search & Export', desc: 'Use the Logs tab to filter past entries, search records, or export data to CSV files.' },
    { icon: '⚙', step: 'STEP 4', title: 'Configure', desc: 'Head to Settings to manage camera URLs, storage paths, security credentials, and preferences.' },
  ];
  return `<div class="guide-page">
    <div class="page-title" style="text-align:center">Getting Started</div>
    <div class="page-subtitle" style="text-align:center">StreamUX Smart Dashboard — Intelligent AI Analytics Management</div>
    <div class="guide-intro">Your complete guide to using your AI-powered analytics system.</div>
    <div class="guide-grid">${steps.map(s => `<div class="guide-card">
      <div style="display:flex;gap:8px;align-items:center"><span class="guide-icon">${s.icon}</span><span class="kpi-label">${s.step}</span></div>
      <div class="guide-title">${s.title}</div><div class="guide-desc">${s.desc}</div>
    </div>`).join('')}</div>
    <div class="text-dim" style="margin-top:24px;font-size:12px">StreamUX v2.0 — Built for Jetson Edge Computing</div>
  </div>`;
}

document.addEventListener('DOMContentLoaded', initApp);
