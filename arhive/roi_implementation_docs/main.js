import { login, clearSession, getSession, getStreams, getCapturedImages, getDailyStats, getAnalyticsData, getImageUrl, updateEvent, deleteEvent, updatePassword, checkMongoHealth, checkImageHealth, setupRealtimeUpdates, teardownRealtimeUpdates, getAnalyticsConfig, saveAnalyticsConfig, getLatestVLMAnalytics } from './data.js';

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
      if (!activePage.innerHTML) {
        activePage.innerHTML = '<div style="display:flex;justify-content:center;align-items:center;height:60vh;color:#94a3b8;font-size:16px">Loading…</div>';
      }
      loadPage(page, activePage);
    }
  }
}

async function loadPage(page, content) {
  try {
    switch (page) {
      case 'stream': { 
        try { alarmAudio.play().then(()=>alarmAudio.pause()).catch(()=>{}); }catch(e){}
        fetch(`/api/settings?db=${encodeURIComponent(getSession().db_name)}`).then(r=>r.json()).then(d=>{ if(d&&d.alarm&&d.alarm.enabled_events){ enabledAlarmEvents=d.alarm.enabled_events.split(';').filter(x=>x); } else { enabledAlarmEvents=[]; } }).catch(()=>{});
        const [streams, recent, stats, vlm] = await Promise.all([getStreams(), getCapturedImages(import.meta.env.VITE_RECENT_LIMIT || 15), getDailyStats(), getLatestVLMAnalytics()]); 
        if (recent.length > 0) lastAlarmEventId = recent[0].id;
        content.innerHTML = renderStream(streams, recent, stats, vlm); 
        bindStream(streams); 
        break; 
      }
      case 'gallery': { const data = await getCapturedImages(0, getGalleryFilters()); content.innerHTML = renderGallery(data); bindGallery(); break; }
      case 'analytics': { const [a, streams] = await Promise.all([getAnalyticsData('today'), getStreams()]); content.innerHTML = renderAnalytics(a, streams); bindAnalytics(a, streams); break; }
      case 'settings': { const [streams, settingsData, alarmEvents] = await Promise.all([getStreams(), fetch(`/api/settings?db=${encodeURIComponent(getSession().db_name)}`).then(r=>r.json()).catch(()=>({})), fetch(`/api/alarm/events?db=${encodeURIComponent(getSession().db_name)}`).then(r=>r.json()).catch(()=>[])]); content.innerHTML = renderSettings(streams, settingsData, alarmEvents); bindSettings(streams, settingsData, alarmEvents); break; }
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
let alarmAudio = new Audio('/alarm.wav');
let lastAlarmEventId = null;
let enabledAlarmEvents = [];

function renderVLM(v) {
  if (!v || !v.analysis) return `<div style="display:flex;align-items:center;gap:6px;color:#94a3b8;font-style:italic;font-size:12px"><svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>No VLM data available</div>`;
  
  const a = v.analysis;
  
  const getBadge = (label, active, icon) => {
    const bg = active ? 'rgba(239, 68, 68, 0.2)' : 'rgba(16, 185, 129, 0.15)';
    const color = active ? '#fca5a5' : '#6ee7b7';
    const border = active ? 'rgba(239, 68, 68, 0.3)' : 'rgba(16, 185, 129, 0.2)';
    return `<div style="display:flex;align-items:center;gap:4px;background:${bg};color:${color};border:1px solid ${border};padding:4px 8px;border-radius:12px;font-size:11px;font-weight:600;letter-spacing:0.3px;">
      <span>${icon}</span> ${label}
    </div>`;
  };

  return `
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
      <div style="width:8px;height:8px;border-radius:50%;background:#38bdf8;box-shadow:0 0 8px #38bdf8;animation: pulse 2s infinite"></div>
      <div style="font-weight:800;color:#f8fafc;font-size:12px;letter-spacing:0.5px;text-transform:uppercase;">AI Vision Analysis</div>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
      ${getBadge('Chaos', a.chaos, '🌪️')}
      ${getBadge('Crowd', a.crowd, '👥')}
      ${getBadge('Fire', a.fire, '🔥')}
      ${getBadge('Litter', a.littering, '🗑️')}
    </div>
    <div style="display:flex;align-items:flex-start;gap:6px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.1);color:${a.safety_issues?.has_issues ? '#fca5a5' : '#cbd5e1'};font-size:11px;line-height:1.4;">
      <span style="font-size:13px;margin-top:1px">${a.safety_issues?.has_issues ? '⚠️' : '✅'}</span>
      <span>${a.safety_issues?.description || 'No safety issues detected in the current frame.'}</span>
    </div>
  `;
}

function renderStream(streams, recent, stats, vlm) {
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
        <div class="stat-card" style="flex:1.5;">
          <div class="stat-card-title">CLASS COUNTS</div>
          <div id="stat-classes" style="margin-top:8px; display:grid; grid-template-columns:1fr 1fr; gap:4px; max-height: 54px; overflow-y: auto;">
            ${(() => {
              const cc = stats.classCounts || {};
              if (Object.keys(cc).length === 0) return '<div class="text-dim" style="font-size:12px">No detections today</div>';
              let classMap = {};
              try { classMap = JSON.parse(import.meta.env.VITE_CLASS_MAP || '{}'); } catch(e){}
              return Object.entries(cc).map(([cid, count]) => {
                const name = classMap[cid] || cid;
                return `<div style="font-size:13px; display:flex; justify-content:space-between; padding-right:12px;"><span style="color:var(--text-dim); text-transform:capitalize;">${name}</span> <span style="font-weight:700;">${count}</span></div>`;
              }).join('');
            })()}
          </div>
        </div>
      </div>
      <div class="video-grid ${gridClass}" id="video-grid">
        ${streams.map(s => {
          const streamVlm = (vlm || []).find(v => v.stream_id === 'stream_' + s.stream_id);
          return `<div class="video-cell" id="cell-${s.stream_id}">
          <span class="stream-label">CAM ${s.stream_id + 1}</span>
          <iframe src="${s.webrtc_url || (import.meta.env.VITE_WEBRTC_BASE || 'http://100.123.128.100:8889') + '/stream' + (s.stream_id + 1) + '/'}" allow="autoplay" allowfullscreen style="width:100%;height:100%;border:none;object-fit:cover;display:block"></iframe>
          <canvas class="stream-overlay" id="overlay-${s.stream_id}" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:5;"></canvas>
          <div class="vlm-panel" id="vlm-panel-${s.stream_id}" style="position:absolute;bottom:12px;left:12px;background:rgba(15,23,42,0.85);color:#f8fafc;padding:14px;border-radius:12px;z-index:10;pointer-events:none;display:flex;flex-direction:column;border:1px solid rgba(255,255,255,0.15);backdrop-filter:blur(8px);box-shadow:0 8px 32px rgba(0,0,0,0.3);max-width:320px;">
            ${renderVLM(streamVlm)}
          </div>
        </div>`;
        }).join('')}
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
      const [recent, stats, vlm] = await Promise.all([getCapturedImages(import.meta.env.VITE_RECENT_LIMIT || 15), getDailyStats(), getLatestVLMAnalytics()]);
      
      if (recent.length > 0 && lastAlarmEventId !== null) {
        if (recent[0].id !== lastAlarmEventId) {
          const isEnabled = enabledAlarmEvents.length === 0 || enabledAlarmEvents.includes(recent[0].event_type);
          if (isEnabled) {
            console.log('[ALARM] New entry detected:', recent[0].event_type, '(ID:', recent[0].id, '). Triggering alarm!');
            alarmAudio.currentTime = 0;
            alarmAudio.play().catch(e => console.warn('Browser prevented alarm autoplay:', e));
          }
        }
      }
      if (recent.length > 0) lastAlarmEventId = recent[0].id;
      const elTot = document.getElementById('stat-total');
      const elVer = document.getElementById('stat-verified');
      const elPen = document.getElementById('stat-pending');
      const elClass = document.getElementById('stat-classes');
      if (elTot) elTot.textContent = stats.total || 0;
      if (elVer) elVer.textContent = stats.verified || 0;
      if (elPen) elPen.textContent = stats.pending || 0;
      if (elClass) {
        const cc = stats.classCounts || {};
        if (Object.keys(cc).length === 0) {
          elClass.innerHTML = '<div class="text-dim" style="font-size:12px">No detections today</div>';
        } else {
          let classMap = {};
          try { classMap = JSON.parse(import.meta.env.VITE_CLASS_MAP || '{}'); } catch(e){}
          elClass.innerHTML = Object.entries(cc).map(([cid, count]) => {
            const name = classMap[cid] || cid;
            return `<div style="font-size:13px; display:flex; justify-content:space-between; padding-right:12px;"><span style="color:var(--text-dim); text-transform:capitalize;">${name}</span> <span style="font-weight:700;">${count}</span></div>`;
          }).join('');
        }
      }
      
      const list = document.getElementById('recent-list');
      if (!list) return;
      
      // Update canvas overlays and VLM panels
      streams.forEach(s => {
        if (s.drawOverlay) s.drawOverlay();
        const vlmPanel = document.getElementById('vlm-panel-' + s.stream_id);
        if (vlmPanel) {
          const streamVlm = (vlm || []).find(v => v.stream_id === 'stream_' + s.stream_id);
          vlmPanel.innerHTML = renderVLM(streamVlm);
        }
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
  let classMap = {};
  try {
    classMap = import.meta.env.VITE_CLASS_MAP ? JSON.parse(import.meta.env.VITE_CLASS_MAP) : {};
  } catch(e) {
    console.warn("Failed to parse VITE_CLASS_MAP");
  }
  const displayClassName = classMap[evt.class_id] || evt.class_id;

  overlay.innerHTML = `
    <div class="edit-modal-content" style="background:var(--bg-card);border-radius:12px;padding:24px;width:90%;max-width:500px;max-height:90vh;overflow-y:auto;box-shadow:0 24px 48px rgba(0,0,0,0.2);border:1px solid var(--border)">
      <h3 style="margin-bottom:16px;font-weight:800;font-size:18px;color:var(--bg-dark)">Event Details</h3>
      <img src="${getImageUrl(evt.image_path)}" style="width:100%;border-radius:8px;background:#000;margin-bottom:16px;max-height:300px;object-fit:contain" />
      <div style="display:flex;justify-content:space-between;margin-bottom:8px">
        <span style="font-weight:700">Class:</span> <span style="color:var(--text-dim)">${displayClassName}</span>
      </div>
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
        <button id="modal-reject" class="edit-modal-btn" style="padding:10px 20px;border-radius:8px;background:#fef2f2;color:#ef4444;border:1px solid #fecaca;font-weight:700;cursor:pointer;flex:1">Reject</button>
        <button id="modal-verify" class="edit-modal-btn" style="padding:10px 20px;border-radius:8px;background:#ecfdf5;color:#10b981;border:1px solid #a7f3d0;font-weight:700;cursor:pointer;flex:1">Verify</button>
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
    <div class="card" style="margin-bottom: 16px; padding: 20px;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">
        <div>
          <div style="font-weight:700; font-size:16px; color:var(--text); display:flex; align-items:center; gap:8px;">
            🔍 Filters
          </div>
          <div class="text-dim" style="font-size:13px;">Refine and search events</div>
        </div>
        <button class="btn-secondary" id="btn-reset-filters">↺ Reset Filters</button>
      </div>
      <div class="filter-grid">
        <div>
          <label class="field-label">EVENT TYPE</label>
          <input id="f-event" placeholder="All Events" value="${_fv('f-event')}" />
        </div>
        <div>
          <label class="field-label">AREA</label>
          <input id="f-area" placeholder="All Areas" value="${_fv('f-area')}" />
        </div>
        <div>
          <label class="field-label">CLASS ID</label>
          <input id="f-class" placeholder="" value="${_fv('f-class')}" type="number" />
        </div>
        <div>
          <label class="field-label">STREAM ID</label>
          <input id="f-stream" placeholder="" value="${_fv('f-stream')}" type="number" />
        </div>
        
        <div>
          <label class="field-label">START</label>
          <div class="time-inputs">
            <input id="f-startdate" type="date" value="${_fv('f-startdate')}" style="flex:2" />
            <input id="f-starttime" type="time" value="${_fv('f-starttime')}" style="flex:1" />
          </div>
        </div>
        <div>
          <label class="field-label">END</label>
          <div class="time-inputs">
            <input id="f-enddate" type="date" value="${_fv('f-enddate')}" style="flex:2" />
            <input id="f-endtime" type="time" value="${_fv('f-endtime')}" style="flex:1" />
          </div>
        </div>
        <div>
          <label class="field-label">VERIFIED</label>
          <select id="f-verified">
            <option value="" ${!_fv('f-verified') ? 'selected' : ''}>All</option>
            <option value="yes" ${_fv('f-verified')==='yes' ? 'selected' : ''}>Verified</option>
            <option value="no" ${_fv('f-verified')==='no' ? 'selected' : ''}>Pending</option>
          </select>
        </div>
        <div style="display:flex; justify-content:flex-end; align-items:flex-end; gap:8px;">
          <button class="btn-secondary" id="btn-export" style="font-weight:700;">📥 CSV</button>
          <button class="btn-save" id="btn-search">🔍 Search</button>
        </div>
      </div>
    </div>
    
    <div class="card" style="flex:1; display:flex; flex-direction:column; padding:0; overflow:hidden;">
      <div style="display:flex; justify-content:space-between; align-items:center; padding:16px;">
        <div>
          <div style="font-weight:700; font-size:16px;">Event List</div>
          <div class="count-label" style="margin-left:0; margin-top:2px;">Showing ${data.length > 0 ? start+1 : 0} to ${Math.min(start+perPage, data.length)} of ${data.length} entries</div>
        </div>
        <button class="btn-secondary" id="btn-reset-sort">↺ Reset Sort</button>
      </div>
      
      <div class="table-responsive-wrapper" style="flex:1"><table class="gallery-table">
        <thead><tr>${hcols.map((c, i) => { let a = i < 8 ? ' ⇕' : ''; if (gallerySort.col === i) a = gallerySort.asc ? ' ▲' : ' ▼'; return `<th data-col="${i}">${c}${a}</th>`; }).join('')}</tr></thead>
        <tbody>${page.map(e => {
          let classMap = {};
          try {
            classMap = import.meta.env.VITE_CLASS_MAP ? JSON.parse(import.meta.env.VITE_CLASS_MAP) : {};
          } catch(err) {
            console.warn("Failed to parse VITE_CLASS_MAP");
          }
          const displayClassName = classMap[e.class_id] || e.class_id;
          return `<tr>
          <td><img class="thumb" src="${getImageUrl(e.image_path)}" onerror="this.style.background='#cbd5e1'" alt="" /></td>
          <td><strong>${e.event_type}</strong></td><td class="text-dim">${e.area_name}</td>
          <td class="text-dim" style="font-size:11px;">${displayClassName}</td><td class="text-dim" style="font-size:11px;">${e.stream_id}</td>
          <td class="text-dim">📅 ${e.date}</td><td class="text-dim">🕐 ${e.time}</td>
          <td><span class="${e.is_verified ? 'badge-in' : 'badge-out'}">${e.is_verified ? '● Verified' : '● Pending'}</span></td>
          <td style="white-space:nowrap;"><button class="btn-action-edit" data-id="${e.id}" style="padding:2px 8px;">✏️</button> <button class="btn-action-delete" data-id="${e.id}" style="padding:2px 8px;">🗑️</button></td>
        </tr>`;
        }).join('')}</tbody></table>
        ${page.length === 0 ? '<div style="text-align:center; padding:40px; color:var(--text-dim);">No detection events match your filter criteria.</div>' : ''}
      </div>
      <div class="pagination" id="pagination">${renderPagination(totalPages)}</div>
    </div>
  </div>`;
}
let _savedFilters = {};
function _fv(id) { return _savedFilters[id] || ''; }
function getGalleryFilters() {
  const el = id => { const e = document.getElementById(id); const v = e ? e.value : (_savedFilters[id] || ''); _savedFilters[id] = v; return v; };
  return { 
    event_type: el('f-event'), area_name: el('f-area'), class_id: el('f-class'), stream_id: el('f-stream'),
    verified: el('f-verified'), start_date: el('f-startdate'), end_date: el('f-enddate'),
    start_time: el('f-starttime'), end_time: el('f-endtime')
  };
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
  
  document.getElementById('btn-search')?.addEventListener('click', () => {
    getGalleryFilters(); // Reads from DOM and populates _savedFilters
    galleryPage = 1;
    navigateTo('gallery');
  });

  document.getElementById('btn-reset-filters')?.addEventListener('click', () => {
    _savedFilters = {};
    ['f-event', 'f-area', 'f-class', 'f-stream', 'f-verified', 'f-startdate', 'f-enddate', 'f-starttime', 'f-endtime'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    galleryPage = 1;
    navigateTo('gallery');
  });

  document.getElementById('btn-reset-sort')?.addEventListener('click', () => { gallerySort = { col: -1, asc: false }; navigateTo('gallery'); });
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
function renderAnalytics(a, streams) {
  return `<div class="analytics-page">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px">
      <div style="flex:1"><span class="page-title">Analytics Dashboard</span><br><span class="page-subtitle">ROI detection and event distribution analysis</span></div>
      
      <span class="bold">Filter:</span>
      <select class="filter-dd" id="an-filter-verif" style="min-width: 140px;">
        <option value="all">All Events</option>
        <option value="verified">Verified Only</option>
        <option value="pending">Pending Only</option>
      </select>

      <span class="bold">Date Range:</span>
      <select class="filter-dd" id="an-date" style="min-width: 140px;">
        <option value="all">All Time</option>
        <option value="today" selected>Today</option>
        <option value="7d">Last 7 Days</option>
        <option value="30d">Last 30 Days</option>
        <option value="custom">Custom Range...</option>
      </select>
      
      <div id="an-custom-dates" style="display:none; align-items:center; gap:8px;">
        <input type="date" id="an-start" class="filter-dd" />
        <span>to</span>
        <input type="date" id="an-end" class="filter-dd" />
      </div>

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
      <div class="chart-card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;">
          <div><div class="bold">Area Hotspots</div><div class="text-dim">Events per area</div></div>
          <select class="filter-dd" id="an-cam">
            <option value="all">All Cameras</option>
            ${streams.map(s => `<option value="${s.stream_id}">Camera ${s.stream_id}</option>`).join('')}
          </select>
        </div>
        <canvas id="chart-areas"></canvas>
      </div>
      <div class="chart-card"><div class="bold">Stream Distribution</div><div class="text-dim">Events per camera</div><canvas id="chart-streams"></canvas></div>
    </div>
  </div>`;
}
function drawPie(canvasId, data) {
  const canvas = document.getElementById(canvasId); if (!canvas) return;
  const ctx = canvas.getContext('2d'); canvas.width = canvas.offsetWidth * 2; canvas.height = 480; ctx.scale(2, 2);
  const w = canvas.offsetWidth, h = 240, entries = Object.entries(data || {});
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
function bindAnalytics(initialData, streams) {
  const refresh = async () => {
    const dateVal = document.getElementById('an-date')?.value || 'today';
    const verifVal = document.getElementById('an-filter-verif')?.value || 'all';
    const startVal = document.getElementById('an-start')?.value || '';
    const endVal = document.getElementById('an-end')?.value || '';
    const camVal = document.getElementById('an-cam')?.value || 'all';
    
    const a = await getAnalyticsData(dateVal, verifVal, startVal, endVal, camVal);
    document.getElementById('an-total').textContent = a.total || 0;
    document.getElementById('an-verif').textContent = a.verified || 0;
    document.getElementById('an-pend').textContent = a.pending || 0;
    document.getElementById('an-wktot').textContent = a.weekTotal || 0;
    document.getElementById('an-wkver').textContent = a.weekVerified || 0;
    drawPie('chart-events', a.eventCounts || {}); 
    drawPie('chart-verif', a.verifCounts || {});
    drawPie('chart-areas', a.camAreaCounts || a.areaCounts || {}); 
    drawPie('chart-streams', a.streamCounts || {});
  };
  
  // Draw initial charts (fallback to regular areaCounts if camAreaCounts is undefined)
  drawPie('chart-events', initialData.eventCounts); drawPie('chart-verif', initialData.verifCounts);
  drawPie('chart-areas', initialData.camAreaCounts || initialData.areaCounts); drawPie('chart-streams', initialData.streamCounts);
  
  document.getElementById('an-date')?.addEventListener('change', (e) => {
    const customDiv = document.getElementById('an-custom-dates');
    if (e.target.value === 'custom') {
      customDiv.style.display = 'flex';
    } else {
      customDiv.style.display = 'none';
      refresh();
    }
  });
  
  document.getElementById('an-filter-verif')?.addEventListener('change', refresh);
  document.getElementById('an-cam')?.addEventListener('change', refresh);
  document.getElementById('an-start')?.addEventListener('change', refresh);
  document.getElementById('an-end')?.addEventListener('change', refresh);
  document.getElementById('an-refresh')?.addEventListener('click', refresh);
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
    <div style="position:relative; width:100%; max-width:800px; aspect-ratio:16/9; height:auto; background:#1e293b; border-radius:8px; overflow:hidden; margin:0 auto; box-shadow:0 4px 6px rgba(0,0,0,0.3)">
      <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#64748b;font-weight:bold;z-index:1">Camera Feed Placeholder</div>
      <canvas id="ed-canvas" width="800" height="450" style="position:absolute;top:0;left:0;width:100%;height:100%;z-index:10;cursor:crosshair"></canvas>
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
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    points.push({ x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY });
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

// ── ANALYTICS EDITOR STATE (VANILLA) ──
let anStreamId = 0;
let anConfigs = { rois: [], lines: [], config_width: 1280, config_height: 720 };
let anDrawPoints = [];
let anShapeType = 'roi';

async function loadAnConfigs(sid) {
  anConfigs = await getAnalyticsConfig(sid);
  renderAnShapeList();
}
function renderAnShapeList() {
  const box = document.getElementById('an-shape-list-box');
  if(!box) return;
  if ((!anConfigs.rois || !anConfigs.rois.length) && (!anConfigs.lines || !anConfigs.lines.length)) {
    box.innerHTML = `<div style="padding:16px;text-align:center;color:var(--text-dim);font-size:13px;font-style:italic;border:1px dashed var(--border);border-radius:var(--radius-sm)">No shapes configured for this stream.</div>`;
    return;
  }
  let html = '';
  (anConfigs.rois||[]).forEach(r => {
    html += `<div style="display:flex;justify-content:space-between;align-items:center;padding:16px;border-radius:var(--radius-sm);border:1px solid var(--border);background:#fff"><span style="font-weight:700;font-size:14px;color:var(--text)">ROI • ${r.name}</span><span style="color:var(--text-dim);font-size:13px">${r.coords.length/2} pts</span></div>`;
  });
  (anConfigs.lines||[]).forEach(l => {
    html += `<div style="display:flex;justify-content:space-between;align-items:center;padding:16px;border-radius:var(--radius-sm);border:1px solid var(--border);background:#fff"><span style="font-weight:700;font-size:14px;color:var(--text)">Line • ${l.name}</span><span style="color:var(--text-dim);font-size:13px">${l.coords.length/2} pts</span></div>`;
  });
  box.innerHTML = html;
}

// ── SETTINGS ── (mirrors C++ settings_page.cpp layout and on_save_settings)
function renderSettings(streams, settingsData, alarmEvents) {
  const sd = settingsData || {};
  const retentionDays = sd.cleanup_days || '30';
  const recentLimit = sd.recent_limit || '15';
  const imageHost = sd.image_host || (import.meta.env.VITE_MONGO_IMAGE_HOST || 'http://100.123.128.100:5002/');
  const mongoUri = sd.mongo_uri || '';
  const enabledEventsStr = sd.enabled_events || '';
  const streamCount = Math.max(1, streams.length);

  // Build alarm checkboxes (mirrors C++ lines 605-634)
  const defaultEvents = ['roi_entry', 'roi_exit', 'roi_dwell', 'line_cross', 'intrusion', 'fall_detection'];
  const eventTypes = (alarmEvents && alarmEvents.length > 0) ? alarmEvents : defaultEvents;
  const enabledSet = enabledEventsStr ? enabledEventsStr.split(';') : [];
  const alarmHtml = eventTypes.map(et => {
    const checked = enabledEventsStr === '' ? true : enabledSet.includes(et);
    return `<label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:6px 4px;border-radius:6px">
      <input type="checkbox" class="alarm-chk" data-event="${et}" ${checked ? 'checked' : ''} style="width:16px;height:16px;accent-color:#4f46e5;cursor:pointer" />
      <span style="font-size:14px;font-weight:500">${et}</span>
    </label>`;
  }).join('');

  // Build stream URL fields (editable, mirrors C++ lines 398-414)
  const streamUrlsHtml = Array.from({length: streamCount}).map((_, i) => {
    const url = streams[i] ? (streams[i].rtsp_url || '') : '';
    return `<div class="field-row"><span class="field-label">STREAM ${i + 1} URL</span><input class="stream-url-input" data-idx="${i}" placeholder="rtsp://..." value="${url}" /></div>`;
  }).join('');

  // Section order matches C++ layout assembly (lines 638-644):
  // nvds_sec → alarm_sec → cam → display → img_sec → mongo_sec → sec
  return `<div class="settings-page"><div class="settings-content"><div class="settings-inner">
    <div><span class="page-title">Settings</span><br><span class="page-subtitle">Manage camera, storage, security, and display preferences</span></div>
    <div style="margin-top:20px">

      <div class="settings-section" id="sec-nvds"><h3>Analytics (ROI & Lines)</h3><div class="subtitle">Manage NVDS Analytics coordinates</div><div class="sep"></div>
        <div style="display:flex;align-items:center;gap:16px;margin-bottom:16px">
          <span class="field-label" style="font-size:12px;font-weight:600;color:var(--text-dim)">STREAM</span>
          <select id="an-stream-sel" style="flex:1;padding:10px 12px;border-radius:var(--radius-sm);border:1px solid var(--border);background:#f1f5f9;font-weight:500;outline:none">${Array.from({length: streamCount}).map((_,i) => `<option value="${i}">Stream ${i+1}</option>`).join('')}</select>
          <button id="btn-open-canvas" style="padding:10px 16px;border-radius:var(--radius-sm);border:1px solid var(--border);background:#fff;font-weight:700;color:var(--text);cursor:pointer;transition:all 0.2s" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='#fff'">Open Drawing Canvas</button>
        </div>
        <div id="an-shape-list-box" style="display:flex;flex-direction:column;gap:12px"></div>
      </div>

      <div class="settings-section" id="sec-alarm"><h3>Alarm Trigger Settings</h3><div class="subtitle">Select which event types should trigger the audio alarm</div><div class="sep"></div>
        <div style="display:flex;flex-direction:column;gap:8px">${alarmHtml}</div>
      </div>

      <div class="settings-section" id="sec-camera"><h3>Camera Source</h3><div class="subtitle">Configure camera streams and RTSP URLs</div><div class="sep"></div>
        <div class="field-row"><span class="field-label">NUMBER OF STREAMS</span><input type="number" id="set-stream-count" min="1" max="9" value="${streamCount}" style="flex:1" /></div>
        <div id="stream-urls-box" style="display:flex;flex-direction:column;gap:12px;margin-top:12px">${streamUrlsHtml}</div>
      </div>

      <div class="settings-section" id="sec-display"><h3>Display & Maintenance</h3><div class="subtitle">Retention and sidebar preferences</div><div class="sep"></div>
        <div class="field-row"><span class="field-label">RETENTION DAYS</span><input id="set-retention" value="${retentionDays}" /></div>
        <div class="field-row"><span class="field-label">RECENT LIMIT</span><input type="number" id="set-limit" min="5" max="500" value="${recentLimit}" /></div>
      </div>

      <div class="settings-section" id="sec-security"><h3>Security</h3><div class="subtitle">Change your login credentials</div><div class="sep"></div>
        <div class="field-row"><span class="field-label">CURRENT PASSWORD</span><div style="flex:1;position:relative;display:flex;align-items:center"><input type="password" id="pw-current" style="flex:1;padding-right:40px" /><button type="button" class="pw-toggle-btn" data-target="pw-current" style="position:absolute;right:8px;background:none;border:none;cursor:pointer;padding:4px;color:var(--text-dim);opacity:0.6" title="Show password">👁</button></div></div>
        <div class="field-row"><span class="field-label">NEW PASSWORD</span><div style="flex:1;position:relative;display:flex;align-items:center"><input type="password" id="pw-new" style="flex:1;padding-right:40px" /><button type="button" class="pw-toggle-btn" data-target="pw-new" style="position:absolute;right:8px;background:none;border:none;cursor:pointer;padding:4px;color:var(--text-dim);opacity:0.6" title="Show password">👁</button></div></div>
        <div class="field-row"><span class="field-label">CONFIRM</span><div style="flex:1;position:relative;display:flex;align-items:center"><input type="password" id="pw-confirm" style="flex:1;padding-right:40px" /><button type="button" class="pw-toggle-btn" data-target="pw-confirm" style="position:absolute;right:8px;background:none;border:none;cursor:pointer;padding:4px;color:var(--text-dim);opacity:0.6" title="Show password">👁</button></div></div>
        <div id="pw-msg" style="margin-top:4px"></div>
        <div style="text-align:right;margin-top:8px"><button class="btn-secondary" id="btn-pw">Update Password</button></div>
      </div>
    </div>
  </div></div>
  <div class="settings-nav" id="settings-nav">
    <button class="settings-nav-btn active" data-target="sec-nvds">Analytics</button>
    <button class="settings-nav-btn" data-target="sec-alarm">Alarm Settings</button>
    <button class="settings-nav-btn" data-target="sec-camera">Camera Source</button>
    <button class="settings-nav-btn" data-target="sec-display">Display & Maintenance</button>
    <button class="settings-nav-btn" data-target="sec-security">Security</button>
    <div style="margin-top:24px">
      <div id="save-status" style="font-size:13px;margin-bottom:8px"></div>
      <button class="btn-save" id="btn-apply" style="width:100%">Apply Settings</button>
    </div>
  </div></div>`;
}
function bindSettings(streams, settingsData, alarmEvents) {
  // Nav scroll (mirrors C++ on_nav_clicked)
  document.querySelectorAll('.settings-nav-btn').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.settings-nav-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active');
    document.getElementById(btn.dataset.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));

  // Password eye toggle (mirrors GTK gtk_password_entry_set_show_peek_icon)
  document.querySelectorAll('.pw-toggle-btn').forEach(btn => btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    if (!input) return;
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    btn.textContent = isPassword ? '🙈' : '👁';
    btn.title = isPassword ? 'Hide password' : 'Show password';
  }));

  // Dynamic stream count (mirrors C++ update_url_fields lambda)
  document.getElementById('set-stream-count')?.addEventListener('change', (e) => {
    const count = Math.min(9, Math.max(1, parseInt(e.target.value) || 1));
    const box = document.getElementById('stream-urls-box');
    if (!box) return;
    const existing = [];
    box.querySelectorAll('.stream-url-input').forEach(inp => existing.push(inp.value));
    let html = '';
    for (let i = 0; i < count; i++) {
      const url = i < existing.length ? existing[i] : (streams[i] ? (streams[i].rtsp_url || '') : '');
      html += `<div class="field-row"><span class="field-label">STREAM ${i + 1} URL</span><input class="stream-url-input" data-idx="${i}" placeholder="rtsp://..." value="${url}" /></div>`;
    }
    box.innerHTML = html;
  });

  // Analytics Editor Bindings
  anStreamId = 0;
  loadAnConfigs(0);
  document.getElementById('an-stream-sel')?.addEventListener('change', e => {
    anStreamId = parseInt(e.target.value);
    loadAnConfigs(anStreamId);
  });
  document.getElementById('btn-save-an-db')?.addEventListener('click', async () => {
    await saveAnalyticsConfig(anStreamId, anConfigs);
    alert('Saved to database!');
  });
  document.getElementById('btn-open-canvas')?.addEventListener('click', () => {
    anDrawPoints = [];
    anShapeType = 'roi';
    const modalHtml = `
      <div class="an-modal-overlay" id="an-modal">
        <div class="an-modal-content">
          <div class="an-modal-header">
            <div style="display:flex;align-items:center;gap:16px"><div style="font-weight:800;font-size:16px;color:var(--bg-dark)">Camera ${anStreamId + 1} Analytics Editor</div><div style="font-size:13px;color:var(--text-dim)">${anConfigs.config_width}x${anConfigs.config_height}</div></div>
            <button id="an-close-btn" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--text-dim)">×</button>
          </div>
          <div class="an-modal-body">
            <div class="an-canvas-area" style="position:relative">
              <div style="position:relative;width:100%;max-width:1280px;aspect-ratio:16/9;display:flex" class="an-canvas-wrapper">
                <iframe src="http://100.123.128.100:8889/stream${anStreamId + 1}/" style="position:absolute;top:0;left:0;width:100%;height:100%;border:none;object-fit:contain;pointer-events:none" allow="autoplay" allowfullscreen></iframe>
                <canvas id="an-canvas" width="${anConfigs.config_width}" height="${anConfigs.config_height}" class="an-canvas-container" style="position:absolute;top:0;left:0;width:100%;height:100%;z-index:10;background:transparent"></canvas>
              </div>
            </div>
            <div class="an-sidebar">
              <div class="an-sidebar-header">Drawing Tools</div>
              <div style="padding:16px;border-bottom:1px solid var(--border)">
                <div style="margin-bottom:12px"><span class="field-label" style="display:block;margin-bottom:4px">SHAPE TYPE</span><select id="an-type-sel" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--border)"><option value="roi">ROI Polygon</option><option value="line">Line Crossing</option></select></div>
                <div style="margin-bottom:12px"><span class="field-label" style="display:block;margin-bottom:4px">NAME</span><input id="an-name-inp" placeholder="e.g. zone" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--border)"/></div>
                <div style="display:flex;gap:8px"><button id="an-clear-pts" class="btn-secondary" style="flex:1">Clear</button><button id="an-save-shape" class="btn-save" style="flex:1;background:#10b981">Save Shape</button></div>
              </div>
              <div class="an-shape-list" id="an-modal-list"></div>
              <div class="an-sidebar-footer"><button id="an-remove-all" class="btn-secondary" style="color:#ef4444">Remove All</button><button id="an-save-close" class="btn-save">Save to DB & Close</button></div>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);

    const canvas = document.getElementById('an-canvas');
    const ctx = canvas.getContext('2d');
    
    function drawCanvas() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (anConfigs.rois) anConfigs.rois.forEach(roi => {
        if(!roi.coords||roi.coords.length<6) return;
        ctx.beginPath(); ctx.moveTo(roi.coords[0],roi.coords[1]);
        for(let i=2;i<roi.coords.length;i+=2) ctx.lineTo(roi.coords[i],roi.coords[i+1]);
        ctx.closePath(); ctx.fillStyle='rgba(16,185,129,0.2)'; ctx.fill(); ctx.strokeStyle='#10b981'; ctx.lineWidth=2; ctx.stroke();
        ctx.fillStyle='#10b981'; ctx.font='bold 16px Inter'; ctx.fillText(roi.name, roi.coords[0], Math.max(20,roi.coords[1]-10));
      });
      if (anConfigs.lines) anConfigs.lines.forEach(line => {
        if(!line.coords||line.coords.length<4) return;
        ctx.beginPath(); ctx.moveTo(line.coords[0],line.coords[1]); ctx.lineTo(line.coords[2],line.coords[3]);
        ctx.strokeStyle='#ef4444'; ctx.lineWidth=2; ctx.stroke();
        if(line.coords.length>=8) {
          ctx.beginPath(); ctx.strokeStyle='rgba(239,68,68,0.6)';
          const x1=line.coords[4],y1=line.coords[5],x2=line.coords[6],y2=line.coords[7];
          ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); const angle=Math.atan2(y2-y1,x2-x1); const head=10;
          ctx.lineTo(x2-head*Math.cos(angle-Math.PI/6),y2-head*Math.sin(angle-Math.PI/6)); ctx.moveTo(x2,y2); ctx.lineTo(x2-head*Math.cos(angle+Math.PI/6),y2-head*Math.sin(angle+Math.PI/6)); ctx.stroke();
        }
        ctx.fillStyle='#ef4444'; ctx.font='bold 16px Inter'; ctx.fillText(line.name, line.coords[0], Math.max(20,line.coords[1]-10));
      });
      if (anDrawPoints.length>0) {
        if (anShapeType === 'line') {
          if (anDrawPoints.length >= 4) {
            ctx.beginPath(); ctx.moveTo(anDrawPoints[0],anDrawPoints[1]); ctx.lineTo(anDrawPoints[2],anDrawPoints[3]);
            ctx.strokeStyle='#f59e0b'; ctx.lineWidth=2; ctx.stroke();
          }
          if (anDrawPoints.length >= 8) {
            ctx.beginPath(); ctx.strokeStyle='rgba(245,158,11,0.8)';
            const x1=anDrawPoints[4],y1=anDrawPoints[5],x2=anDrawPoints[6],y2=anDrawPoints[7];
            ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); const angle=Math.atan2(y2-y1,x2-x1); const head=10;
            ctx.lineTo(x2-head*Math.cos(angle-Math.PI/6),y2-head*Math.sin(angle-Math.PI/6)); ctx.moveTo(x2,y2); ctx.lineTo(x2-head*Math.cos(angle+Math.PI/6),y2-head*Math.sin(angle+Math.PI/6)); ctx.stroke();
          }
        } else {
          ctx.beginPath(); ctx.moveTo(anDrawPoints[0],anDrawPoints[1]);
          for(let i=2;i<anDrawPoints.length;i+=2) ctx.lineTo(anDrawPoints[i],anDrawPoints[i+1]);
          if(anDrawPoints.length>4) ctx.closePath();
          ctx.fillStyle='rgba(245,158,11,0.2)'; ctx.fill(); ctx.strokeStyle='#f59e0b'; ctx.lineWidth=2; ctx.stroke();
        }
        for(let i=0;i<anDrawPoints.length;i+=2){ ctx.beginPath(); ctx.arc(anDrawPoints[i],anDrawPoints[i+1],5,0,Math.PI*2); ctx.fillStyle='#fff'; ctx.fill(); ctx.strokeStyle='#f59e0b'; ctx.stroke(); }
      }
      
      const list = document.getElementById('an-modal-list');
      let h = '<div style="font-size:12px;font-weight:600;color:var(--text-dim);text-transform:uppercase">Current Shapes</div>';
      (anConfigs.rois||[]).forEach(r => h += `<div class="an-shape-item"><span><span style="color:#10b981;font-weight:bold">ROI</span> ${r.name}</span><button class="btn-rm-md" data-type="roi" data-name="${r.name}" style="background:none;border:none;color:#ef4444;cursor:pointer">×</button></div>`);
      (anConfigs.lines||[]).forEach(l => h += `<div class="an-shape-item"><span><span style="color:#ef4444;font-weight:bold">Line</span> ${l.name}</span><button class="btn-rm-md" data-type="line" data-name="${l.name}" style="background:none;border:none;color:#ef4444;cursor:pointer">×</button></div>`);
      list.innerHTML = h;
      document.querySelectorAll('.btn-rm-md').forEach(b => b.onclick = () => {
        const t=b.dataset.type, n=b.dataset.name;
        if(t==='roi') anConfigs.rois=anConfigs.rois.filter(x=>x.name!==n);
        if(t==='line') anConfigs.lines=anConfigs.lines.filter(x=>x.name!==n);
        drawCanvas();
      });
    }

    canvas.onclick = e => {
      if (anShapeType === 'line' && anDrawPoints.length >= 8) return;
      const rect = canvas.getBoundingClientRect();
      const scaleX = anConfigs.config_width / rect.width, scaleY = anConfigs.config_height / rect.height;
      anDrawPoints.push(Math.round((e.clientX - rect.left)*scaleX), Math.round((e.clientY - rect.top)*scaleY));
      drawCanvas();
    };

    document.getElementById('an-type-sel').onchange = e => { anShapeType = e.target.value; anDrawPoints = []; drawCanvas(); };
    document.getElementById('an-clear-pts').onclick = () => { anDrawPoints = []; drawCanvas(); };
    document.getElementById('an-save-shape').onclick = () => {
      const name = document.getElementById('an-name-inp').value;
      if(!name) return alert('Enter name');
      if(anShapeType==='roi'&&anDrawPoints.length<6) return alert('ROI needs 3+ points');
      if(anShapeType==='line'&&anDrawPoints.length<4) return alert('Line needs 2+ points');
      if(anShapeType==='roi'){ anConfigs.rois=anConfigs.rois.filter(x=>x.name!==name); anConfigs.rois.push({name, coords:anDrawPoints}); }
      else { anConfigs.lines=anConfigs.lines.filter(x=>x.name!==name); anConfigs.lines.push({name, coords:anDrawPoints}); }
      anDrawPoints = []; document.getElementById('an-name-inp').value=''; drawCanvas();
    };
    document.getElementById('an-remove-all').onclick = () => { anConfigs.rois=[]; anConfigs.lines=[]; anDrawPoints=[]; drawCanvas(); };
    
    const close = () => { document.getElementById('an-modal').remove(); renderAnShapeList(); };
    document.getElementById('an-close-btn').onclick = close;
    document.getElementById('an-save-close').onclick = async () => { await saveAnalyticsConfig(anStreamId, anConfigs); close(); };
    
    drawCanvas();
  });



  // Password change (mirrors C++ on_change_password)
  document.getElementById('btn-pw')?.addEventListener('click', async () => {
    const cur = document.getElementById('pw-current').value, nw = document.getElementById('pw-new').value, cf = document.getElementById('pw-confirm').value;
    const msg = document.getElementById('pw-msg');
    msg.textContent = ''; msg.style.color = '';
    if (nw.length < 6) { msg.textContent = 'Password must be at least 6 characters'; msg.style.color = '#ef4444'; return; }
    if (!cur || !nw) { msg.textContent = 'Fill all fields'; msg.style.color = '#ef4444'; return; }
    if (nw !== cf) { msg.textContent = 'Passwords do not match'; msg.style.color = '#ef4444'; return; }
    try {
      await updatePassword(cur, nw);
      msg.textContent = '✓ Password updated successfully'; msg.style.color = '#10b981';
      document.getElementById('pw-current').value = '';
      document.getElementById('pw-new').value = '';
      document.getElementById('pw-confirm').value = '';
    } catch (e) { msg.textContent = '❌ ' + e.message; msg.style.color = '#ef4444'; }
  });

  // Apply Settings (mirrors C++ on_save_settings — full save + restart)
  document.getElementById('btn-apply')?.addEventListener('click', async () => {
    const statusEl = document.getElementById('save-status');
    const btn = document.getElementById('btn-apply');
    statusEl.textContent = ''; statusEl.className = '';

    // 1. Validate URLs (mirrors C++ lines 84-97)
    const urlRegex = /^(rtsp|http|https|webrtc):\/\/([a-zA-Z0-9\-._~%]+:[a-zA-Z0-9\-._~%]+@)?([a-zA-Z0-9\-._]+)(:[0-9]+)?(\/.*)?$/;
    const streamCount = parseInt(document.getElementById('set-stream-count')?.value) || 1;
    const urlInputs = document.querySelectorAll('.stream-url-input');
    const urls = [];
    for (let i = 0; i < streamCount; i++) {
      const u = urlInputs[i]?.value || '';
      if (!u) { statusEl.textContent = `Stream ${i+1} URL cannot be empty`; statusEl.className = 'text-rose'; return; }
      if (!urlRegex.test(u)) { statusEl.textContent = `Stream ${i+1} URL format invalid (e.g. rtsp://user:pass@ip:port/path)`; statusEl.className = 'text-rose'; return; }
      urls.push(u);
    }

    const dbName = getSession().db_name;

    // 2. Build alarm enabled_events (mirrors C++ lines 150-157)
    const checkedEvents = [];
    document.querySelectorAll('.alarm-chk').forEach(chk => {
      if (chk.checked) checkedEvents.push(chk.dataset.event);
    });
    const enabledEventsStr = checkedEvents.join(';');

    try {
      // 3. Save streams to DB (mirrors C++ lines 104-117)
      for (let i = 0; i < streamCount; i++) {
        await fetch(`/api/streams/${i}?db=${encodeURIComponent(dbName)}`, {
          method: 'PUT', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ rtsp_url: urls[i] })
        });
      }

      // 4. Trim excess streams (mirrors C++ lines 119-126)
      await fetch('/api/streams/trim', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ db_name: dbName, keep_count: streamCount })
      });

      // 5. Save settings + alarm config (mirrors C++ Config::save + alarm enabled_events)
      await fetch(`/api/settings?db=${encodeURIComponent(dbName)}`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          cleanup_days: document.getElementById('set-retention')?.value || '30',
          recent_limit: document.getElementById('set-limit')?.value || '15',
          enabled_events: enabledEventsStr
        })
      });

      // 6. Trigger backend restart (mirrors C++ trigger_backend_restart)
      await fetch('/api/system/restart', { method: 'POST' });

      btn.textContent = '✓ Saved';
      setTimeout(() => btn.textContent = 'Apply Settings', 2000);
    } catch (e) {
      statusEl.textContent = 'Error saving settings: ' + e.message;
      statusEl.className = 'text-rose';
    }
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
