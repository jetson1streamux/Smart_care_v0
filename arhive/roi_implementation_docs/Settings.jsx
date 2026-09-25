import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';

// Password field with eye toggle — mirrors GTK's gtk_password_entry_set_show_peek_icon(TRUE)
function PasswordField({ value, onChange, placeholder }) {
  const [visible, setVisible] = useState(false);
  return (
    <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center' }}>
      <input
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        style={{ flex: 1, paddingRight: '40px' }}
      />
      <button
        type="button"
        onClick={() => setVisible(v => !v)}
        style={{
          position: 'absolute',
          right: '8px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '4px',
          color: 'var(--text-dim)',
          fontSize: '16px',
          lineHeight: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: 0.6,
          transition: 'opacity 0.15s'
        }}
        onMouseOver={e => e.currentTarget.style.opacity = '1'}
        onMouseOut={e => e.currentTarget.style.opacity = '0.6'}
        title={visible ? 'Hide password' : 'Show password'}
      >
        {visible ? (
          // Eye-off icon (hide)
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
            <line x1="1" y1="1" x2="23" y2="23" />
          </svg>
        ) : (
          // Eye icon (show)
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </div>
  );
}

export default function Settings() {
  const [loading, setLoading] = useState(true);
  const [activeSection, setActiveSection] = useState('sec-nvds');
  
  // States mapping directly to C++
  // Camera Source
  const [streamCount, setStreamCount] = useState(1);
  const [streamUrls, setStreamUrls] = useState([]); // Array of strings
  
  // Security
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [secStatus, setSecStatus] = useState({ text: '', type: '' });
  
  // Display & Maintenance
  const [retentionDays, setRetentionDays] = useState("30");
  const [recentLimit, setRecentLimit] = useState(15);

  // Alarm Trigger Settings (NEW — mirrors C++ alarm_checkboxes)
  const [alarmEventTypes, setAlarmEventTypes] = useState([]);
  const [alarmChecked, setAlarmChecked] = useState({});

  // Save Status
  const [saveStatus, setSaveStatus] = useState('');
  const [saveStatusClass, setSaveStatusClass] = useState('');
  const [saveBtnText, setSaveBtnText] = useState('Apply Settings');

  // Analytics Editor (NEW)
  const [anStreamId, setAnStreamId] = useState(0);
  const [anConfigs, setAnConfigs] = useState({ rois: [], lines: [], config_width: 1280, config_height: 720 });
  const [showAnModal, setShowAnModal] = useState(false);
  const [anDrawPoints, setAnDrawPoints] = useState([]);
  const [anShapeType, setAnShapeType] = useState('roi');
  const [anShapeName, setAnShapeName] = useState('');
  const anCanvasRef = useRef(null);

  const contentRef = useRef(null);

  const loadAnalyticsConfig = useCallback(async (sid) => {
    try {
      const user = JSON.parse(localStorage.getItem('user') || '{}');
      const dbName = user.db_name || 'user_bajaj_db';
      const res = await fetch(`/api/configs/${sid}?db=${dbName}`);
      const data = await res.json();
      setAnConfigs(data);
    } catch (e) { console.error('Failed to load analytics config:', e); }
  }, []);

  const drawCanvas = useCallback(() => {
    const canvas = anCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw saved ROIs
    if (anConfigs.rois) {
      anConfigs.rois.forEach(roi => {
        if (!roi.coords || roi.coords.length < 6) return;
        ctx.beginPath();
        ctx.moveTo(roi.coords[0], roi.coords[1]);
        for (let i = 2; i < roi.coords.length; i += 2) ctx.lineTo(roi.coords[i], roi.coords[i+1]);
        ctx.closePath();
        ctx.fillStyle = 'rgba(16, 185, 129, 0.2)'; // Emerald
        ctx.fill();
        ctx.strokeStyle = '#10b981';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = '#10b981';
        ctx.font = 'bold 16px Inter';
        ctx.fillText(roi.name, roi.coords[0], Math.max(20, roi.coords[1] - 10));
      });
    }

    // Draw saved Lines
    if (anConfigs.lines) {
      anConfigs.lines.forEach(line => {
        if (!line.coords || line.coords.length < 4) return;
        ctx.beginPath();
        ctx.moveTo(line.coords[0], line.coords[1]);
        ctx.lineTo(line.coords[2], line.coords[3]);
        ctx.strokeStyle = '#ef4444'; // Rose
        ctx.lineWidth = 2;
        ctx.stroke();
        
        // Direction arrow
        if (line.coords.length >= 8) {
          ctx.beginPath();
          ctx.strokeStyle = 'rgba(239, 68, 68, 0.6)';
          const x1 = line.coords[4], y1 = line.coords[5], x2 = line.coords[6], y2 = line.coords[7];
          ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
          const angle = Math.atan2(y2 - y1, x2 - x1);
          const headLen = 10;
          ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI/6), y2 - headLen * Math.sin(angle - Math.PI/6));
          ctx.moveTo(x2, y2);
          ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI/6), y2 - headLen * Math.sin(angle + Math.PI/6));
          ctx.stroke();
        }
        
        ctx.fillStyle = '#ef4444';
        ctx.font = 'bold 16px Inter';
        ctx.fillText(line.name, line.coords[0], Math.max(20, line.coords[1] - 10));
      });
    }

    // Draw current points
    if (anDrawPoints.length > 0) {
      if (anShapeType === 'line') {
        // Draw main line
        if (anDrawPoints.length >= 4) {
          ctx.beginPath();
          ctx.moveTo(anDrawPoints[0], anDrawPoints[1]);
          ctx.lineTo(anDrawPoints[2], anDrawPoints[3]);
          ctx.strokeStyle = '#f59e0b';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        // Draw direction arrow
        if (anDrawPoints.length >= 8) {
          ctx.beginPath();
          ctx.strokeStyle = 'rgba(245, 158, 11, 0.8)';
          const x1 = anDrawPoints[4], y1 = anDrawPoints[5], x2 = anDrawPoints[6], y2 = anDrawPoints[7];
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          const angle = Math.atan2(y2 - y1, x2 - x1);
          const headLen = 10;
          ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI/6), y2 - headLen * Math.sin(angle - Math.PI/6));
          ctx.moveTo(x2, y2);
          ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI/6), y2 - headLen * Math.sin(angle + Math.PI/6));
          ctx.stroke();
        }
      } else {
        // Draw ROI polygon
        ctx.beginPath();
        ctx.moveTo(anDrawPoints[0], anDrawPoints[1]);
        for (let i = 2; i < anDrawPoints.length; i += 2) ctx.lineTo(anDrawPoints[i], anDrawPoints[i+1]);
        if (anDrawPoints.length > 4) ctx.closePath();
        ctx.fillStyle = 'rgba(245, 158, 11, 0.2)';
        ctx.fill();
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      
      // Draw point handles
      for (let i = 0; i < anDrawPoints.length; i += 2) {
        ctx.beginPath();
        ctx.arc(anDrawPoints[i], anDrawPoints[i+1], 5, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.strokeStyle = '#f59e0b';
        ctx.stroke();
      }
    }
  }, [anConfigs, anDrawPoints, anShapeType]);

  useEffect(() => {
    if (showAnModal) {
      // Small timeout to ensure canvas is in DOM
      setTimeout(() => drawCanvas(), 50);
    }
  }, [showAnModal, drawCanvas]);

  useEffect(() => {
    if (!loading) loadAnalyticsConfig(anStreamId);
  }, [anStreamId, loading, loadAnalyticsConfig]);
    // Fetch user db from localStorage
    const user = JSON.parse(localStorage.getItem('user') || '{}');

    const dbName = user.db_name || 'user_bajaj_db';

    // Fetch initial data
    Promise.all([
      fetch(`/api/streams?db=${dbName}`).then(r => r.json()).catch(() => []),
      fetch(`/api/settings?db=${dbName}`).then(r => r.json()).catch(() => ({})),
      fetch(`/api/alarm/events?db=${dbName}`).then(r => r.json()).catch(() => [])
    ]).then(([streamsData, settingsData, eventTypes]) => {
      // Setup streams
      const urls = [];
      const count = Math.max(1, streamsData.length);
      setStreamCount(count);
      for(let i=0; i<9; i++) { // Max 9 streams in GTK spin button range
        urls.push(streamsData[i] ? (streamsData[i].rtsp_url || '') : '');
      }
      setStreamUrls(urls);

      // Setup settings
      if(settingsData.cleanup_days) setRetentionDays(settingsData.cleanup_days);
      if(settingsData.recent_limit) setRecentLimit(parseInt(settingsData.recent_limit));

      // Setup alarm event types (mirrors C++ lines 605-634)
      const types = eventTypes.length > 0
        ? eventTypes
        : ['roi_entry', 'roi_exit', 'roi_dwell', 'line_cross', 'intrusion', 'fall_detection'];
      setAlarmEventTypes(types);

      // Parse enabled_events from config (semicolon-separated, same as C++)
      const enabledStr = settingsData.enabled_events || '';
      const checkedMap = {};
      types.forEach(et => {
        if (enabledStr === '') {
          // Default to all checked when no config exists (same as C++ line 618-619)
          checkedMap[et] = true;
        } else {
          checkedMap[et] = enabledStr.split(';').includes(et);
        }
      });
      setAlarmChecked(checkedMap);

      setLoading(false);
    });
  }, []);

  const handleStreamCountChange = (e) => {
    const val = parseInt(e.target.value) || 1;
    if(val >= 1 && val <= 9) setStreamCount(val);
  };

  const handleUrlChange = (idx, val) => {
    const newUrls = [...streamUrls];
    newUrls[idx] = val;
    setStreamUrls(newUrls);
  };

  const handleAlarmToggle = (eventType) => {
    setAlarmChecked(prev => ({
      ...prev,
      [eventType]: !prev[eventType]
    }));
  };

  const onChangePassword = async () => {
    setSecStatus({text: '', type: ''});
    if (newPassword.length < 6) {
      setSecStatus({text: 'Password must be at least 6 characters', type: 'text-rose'});
      return;
    }
    if (newPassword !== confirmPassword) {
      setSecStatus({text: 'Passwords do not match', type: 'text-rose'});
      return;
    }
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    if(!user.username) {
      setSecStatus({text: 'Not logged in', type: 'text-rose'});
      return;
    }

    try {
      const res = await fetch('/api/auth/password', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          username: user.username,
          current_password: currentPassword,
          new_password: newPassword
        })
      });
      const data = await res.json();
      if(res.ok && data.ok) {
        setSecStatus({text: '✓ Password updated successfully', type: 'text-emerald'});
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
      } else {
        setSecStatus({text: data.error || 'Current password is incorrect', type: 'text-rose'});
      }
    } catch {
      setSecStatus({text: 'Network error', type: 'text-rose'});
    }
  };

  const saveAnalyticsConfigToDb = async (configsToSave) => {
    try {
      const user = JSON.parse(localStorage.getItem('user') || '{}');
      const dbName = user.db_name || 'user_bajaj_db';
      await fetch(`/api/configs/${anStreamId}?db=${dbName}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(configsToSave)
      });
      // reload after save to sync format
      await loadAnalyticsConfig(anStreamId);
    } catch (e) { console.error('Failed to save analytics config:', e); }
  };

  const removeShape = (type, name) => {
    const updated = { ...anConfigs };
    if (type === 'roi') updated.rois = updated.rois.filter(r => r.name !== name);
    if (type === 'line') updated.lines = updated.lines.filter(l => l.name !== name);
    setAnConfigs(updated);
  };

  const onSaveSettings = async () => {
    setSaveStatus('');
    setSaveStatusClass('');

    const urlRegex = /^(rtsp|http|https|webrtc):\/\/([a-zA-Z0-9\-._~%]+:[a-zA-Z0-9\-._~%]+@)?([a-zA-Z0-9\-._]+)(:[0-9]+)?(\/.*)?$/;
    
    // Validate URLs (mirrors C++ lines 86-97)
    for(let i=0; i<streamCount; i++) {
      const u = streamUrls[i];
      if(!u) {
        setSaveStatus(`Stream ${i+1} URL cannot be empty`);
        setSaveStatusClass('text-rose');
        return;
      }
      if(!urlRegex.test(u)) {
        setSaveStatus(`Stream ${i+1} URL format invalid (e.g. rtsp://user:pass@ip:port/path)`);
        setSaveStatusClass('text-rose');
        return;
      }
    }

    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const dbName = user.db_name || 'user_bajaj_db';

    // Build enabled_events string (mirrors C++ lines 150-157)
    const enabledEventsStr = alarmEventTypes
      .filter(et => alarmChecked[et])
      .join(';');

    try {
      // 1. Save Streams
      for(let i=0; i<streamCount; i++) {
        await fetch(`/api/streams/${i}?db=${dbName}`, {
          method: 'PUT',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ rtsp_url: streamUrls[i] })
        });
      }

      // 2. Trim excess streams (mirrors C++ lines 120-126)
      await fetch('/api/streams/trim', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ db_name: dbName, keep_count: streamCount })
      });

      // 3. Save Settings including alarm enabled_events
      await fetch(`/api/settings?db=${dbName}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          cleanup_days: retentionDays,
          recent_limit: recentLimit,
          enabled_events: enabledEventsStr
        })
      });

      // 4. Trigger Backend Restart (mirrors C++ trigger_backend_restart)
      await fetch('/api/system/restart', { method: 'POST' });

      setSaveBtnText('✓ Saved');
      setTimeout(() => setSaveBtnText('Apply Settings'), 2000);

    } catch (e) {
      setSaveStatus('Error saving settings: ' + e.message);
      setSaveStatusClass('text-rose');
    }
  };

  const scrollToSection = (id) => {
    setActiveSection(id);
    const el = document.getElementById(id);
    if(el && contentRef.current) {
      // Use relative position calculation — mirrors C++ gtk_widget_translate_coordinates
      const containerRect = contentRef.current.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const relativeTop = elRect.top - containerRect.top + contentRef.current.scrollTop;
      contentRef.current.scrollTo({
        top: Math.max(0, relativeTop - 20),
        behavior: 'smooth'
      });
    }
  };

  // Observe scrolling to update nav (mirrors C++ on_scroll_value_changed)
  useEffect(() => {
    const handleScroll = () => {
      if(!contentRef.current) return;
      // Section order matches C++ layout assembly (lines 638-644)
      const sections = ['sec-nvds', 'sec-alarm', 'sec-camera', 'sec-display', 'sec-sec'];
      const container = contentRef.current;
      const containerRect = container.getBoundingClientRect();
      const scrollY = container.scrollTop;
      const pageSize = container.clientHeight;
      const scrollHeight = container.scrollHeight;
      const threshold = scrollY + 100;
      
      // Bottom detection (mirrors C++ lines 267-270: scroll_y + page_size >= upper - 5)
      if (scrollY + pageSize >= scrollHeight - 5) {
        setActiveSection(sections[sections.length - 1]);
        return;
      }
      
      // Reverse iterate to find the topmost visible section (mirrors C++ lines 272-280)
      let active = sections[0];
      for(let i=sections.length-1; i>=0; i--) {
        const el = document.getElementById(sections[i]);
        if(el) {
          // Use translate_coordinates equivalent: relative position within scrollable container
          const elRect = el.getBoundingClientRect();
          const relativeTop = elRect.top - containerRect.top + scrollY;
          if(threshold >= relativeTop) {
            active = sections[i];
            break;
          }
        }
      }
      setActiveSection(active);
    };
    const ref = contentRef.current;
    if(ref) ref.addEventListener('scroll', handleScroll);
    return () => {
      if(ref) ref.removeEventListener('scroll', handleScroll);
    };
  }, [loading]);

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', color: 'var(--text-xs)' }}>Loading React Settings...</div>;

  // Nav items order matches C++ lines 656-662
  const navItems = [
    { id: 'sec-nvds', label: 'Analytics' },
    { id: 'sec-alarm', label: 'Alarm Settings' },
    { id: 'sec-camera', label: 'Camera Source' },
    { id: 'sec-display', label: 'Display & Maintenance' },
    { id: 'sec-sec', label: 'Security' }
  ];

  return (
    <div className="settings-page" style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Spacer on the left matching C++ layout */}
      <div className="settings-spacer" style={{ flex: 1, minWidth: 0 }}></div>
      
      <div className="settings-content" ref={contentRef} style={{ width: '100%', maxWidth: '680px', flexShrink: 0, overflowY: 'auto' }}>
        <div className="settings-inner" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div>
            <div className="page-title">Settings</div>
            <div className="page-subtitle">Manage camera, storage, security, and display preferences</div>
          </div>

          {/* ── 1. NVDS Analytics (same as before) ── */}
          <div className="card" id="sec-nvds">
            {/* Analytics Editor Inline UI */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '16px' }}>
              <span className="field-label" style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-dim)' }}>STREAM</span>
              <select 
                value={anStreamId} 
                onChange={e => setAnStreamId(parseInt(e.target.value))}
                style={{ flex: 1, padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: '#f1f5f9', fontWeight: 500, outline: 'none' }}
              >
                {Array.from({length: streamCount}).map((_, i) => (
                  <option key={i} value={i}>Stream {i + 1}</option>
                ))}
              </select>
              <button 
                onClick={() => { setAnDrawPoints([]); setShowAnModal(true); }} 
                style={{ padding: '10px 16px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: '#fff', fontWeight: 700, color: 'var(--text)', cursor: 'pointer', transition: 'all 0.2s' }}
                onMouseOver={e => e.currentTarget.style.background = '#f8fafc'}
                onMouseOut={e => e.currentTarget.style.background = '#fff'}
              >
                Open Drawing Canvas
              </button>
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {(!anConfigs.rois || anConfigs.rois.length === 0) && (!anConfigs.lines || anConfigs.lines.length === 0) ? (
                <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '13px', fontStyle: 'italic', border: '1px dashed var(--border)', borderRadius: 'var(--radius-sm)' }}>
                  No shapes configured for this stream.
                </div>
              ) : (
                <>
                  {anConfigs.rois?.map(r => (
                    <div key={`roi-${r.name}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: '#fff' }}>
                      <span style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text)' }}>ROI • {r.name}</span>
                      <span style={{ color: 'var(--text-dim)', fontSize: '13px' }}>{r.coords.length/2} pts</span>
                    </div>
                  ))}
                  {anConfigs.lines?.map(l => (
                    <div key={`line-${l.name}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: '#fff' }}>
                      <span style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text)' }}>Line • {l.name}</span>
                      <span style={{ color: 'var(--text-dim)', fontSize: '13px' }}>{l.coords.length/2} pts</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>

          {/* ── 2. Alarm Trigger Settings (NEW — mirrors C++ lines 599-635) ── */}
          <div className="card" id="sec-alarm">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginBottom: '16px' }}>
              <div className="bold">Alarm Trigger Settings</div>
              <div className="text-dim">Select which event types should trigger the audio alarm</div>
            </div>
            <div className="sep" style={{ margin: '0 0 16px 0' }}></div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {alarmEventTypes.map(et => (
                <label key={et} style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', padding: '6px 4px', borderRadius: '6px', transition: 'background 0.15s' }}
                  onMouseOver={e => e.currentTarget.style.background = 'var(--bg)'}
                  onMouseOut={e => e.currentTarget.style.background = 'transparent'}
                >
                  <input
                    type="checkbox"
                    checked={!!alarmChecked[et]}
                    onChange={() => handleAlarmToggle(et)}
                    style={{ width: '16px', height: '16px', accentColor: 'var(--accent, #4f46e5)', cursor: 'pointer' }}
                  />
                  <span style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text)' }}>{et}</span>
                </label>
              ))}
            </div>
          </div>

          {/* ── 3. Camera Source ── */}
          <div className="card" id="sec-camera">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginBottom: '16px' }}>
              <div className="bold">Camera Source</div>
              <div className="text-dim">Configure camera streams and RTSP URLs</div>
            </div>
            <div className="sep" style={{ margin: '0 0 16px 0' }}></div>
            
            <div className="field-row">
              <span className="field-label">NUMBER OF STREAMS</span>
              <input 
                type="number" 
                min="1" max="9" 
                value={streamCount} 
                onChange={handleStreamCountChange} 
                style={{ flex: 1 }}
              />
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '12px' }}>
              {Array.from({length: streamCount}).map((_, i) => (
                <div className="field-row" key={i}>
                  <span className="field-label">STREAM {i + 1} URL</span>
                  <input 
                    placeholder="rtsp://..."
                    value={streamUrls[i] || ''}
                    onChange={(e) => handleUrlChange(i, e.target.value)}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* ── 4. Display & Maintenance ── */}
          <div className="card" id="sec-display">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginBottom: '16px' }}>
              <div className="bold">Display & Maintenance</div>
              <div className="text-dim">Retention and sidebar preferences</div>
            </div>
            <div className="sep" style={{ margin: '0 0 16px 0' }}></div>
            <div className="field-row">
              <span className="field-label">RETENTION DAYS</span>
              <input value={retentionDays} onChange={e => setRetentionDays(e.target.value)} />
            </div>
            <div className="field-row">
              <span className="field-label">RECENT LIMIT</span>
              <input type="number" min="5" max="500" value={recentLimit} onChange={e => setRecentLimit(e.target.value)} />
            </div>
          </div>

          {/* ── 5. Security ── */}
          <div className="card" id="sec-sec">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginBottom: '16px' }}>
              <div className="bold">Security</div>
              <div className="text-dim">Change your login credentials</div>
            </div>
            <div className="sep" style={{ margin: '0 0 16px 0' }}></div>
            
            <div className="field-row">
              <span className="field-label">CURRENT PASSWORD</span>
              <PasswordField value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} />
            </div>
            <div className="field-row">
              <span className="field-label">NEW PASSWORD</span>
              <PasswordField value={newPassword} onChange={e => setNewPassword(e.target.value)} />
            </div>
            <div className="field-row">
              <span className="field-label">CONFIRM</span>
              <PasswordField value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} />
            </div>
            
            {secStatus.text && (
              <div className={secStatus.type} style={{ margin: '8px 0', fontSize: '13px' }}>{secStatus.text}</div>
            )}
            
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '8px' }}>
              <button className="btn-secondary" onClick={onChangePassword}>Update Password</button>
            </div>
          </div>
        </div>
      </div>

      <div className="settings-nav-container" style={{ flex: 1, minWidth: 0 }}>
        <div className="settings-nav" style={{ display: 'flex', gap: '8px' }}>
          {navItems.map(sec => (
            <button 
              key={sec.id} 
              className={`settings-nav-btn ${activeSection === sec.id ? 'active' : ''}`}
              onClick={() => scrollToSection(sec.id)}
            >
              {sec.label}
            </button>
          ))}

          <div className="settings-save-wrapper" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {saveStatus && <div className={saveStatusClass} style={{ fontSize: '13px' }}>{saveStatus}</div>}
            <button className="btn-save" onClick={onSaveSettings} style={{ width: '100%' }}>{saveBtnText}</button>
          </div>
        </div>
      </div>
      
      {/* Analytics Modal */}
      {showAnModal && (
        <div className="an-modal-overlay" onClick={(e) => { if (e.target.className === 'an-modal-overlay') setShowAnModal(false); }}>
          <div className="an-modal-content">
            <div className="an-modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                <div style={{ fontWeight: 800, fontSize: '16px', color: 'var(--bg-dark)' }}>Camera {anStreamId + 1} Analytics Editor</div>
                <div style={{ fontSize: '13px', color: 'var(--text-dim)' }}>{anConfigs.config_width}x{anConfigs.config_height}</div>
              </div>
              <button onClick={() => setShowAnModal(false)} style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', color: 'var(--text-dim)' }}>×</button>
            </div>
            <div className="an-modal-body">
              <div className="an-canvas-area" style={{ position: 'relative' }}>
                <div style={{ position: 'relative', width: '100%', maxWidth: '1280px', aspectRatio: '16/9', display: 'flex' }} className="an-canvas-wrapper">
                  {useMemo(() => (
                    <iframe 
                      src={`http://100.123.128.100:8889/stream${anStreamId + 1}/`}
                      style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', border: 'none', objectFit: 'contain', pointerEvents: 'none' }}
                      allow="autoplay"
                      allowFullScreen
                    ></iframe>
                  ), [anStreamId])}
                  <canvas 
                    ref={anCanvasRef}
                    width={anConfigs.config_width} 
                    height={anConfigs.config_height}
                    className="an-canvas-container"
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', zIndex: 10, background: 'transparent' }}
                    onClick={(e) => {
                      if (anShapeType === 'line' && anDrawPoints.length >= 8) return;
                      const rect = e.target.getBoundingClientRect();
                      const scaleX = anConfigs.config_width / rect.width;
                      const scaleY = anConfigs.config_height / rect.height;
                      const x = Math.round((e.clientX - rect.left) * scaleX);
                      const y = Math.round((e.clientY - rect.top) * scaleY);
                      setAnDrawPoints(prev => [...prev, x, y]);
                    }}
                  ></canvas>
                </div>
              </div>
              <div className="an-sidebar">
                <div className="an-sidebar-header">
                  Drawing Tools
                </div>
                <div style={{ padding: '16px', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ marginBottom: '12px' }}>
                    <span className="field-label" style={{ display: 'block', marginBottom: '4px' }}>SHAPE TYPE</span>
                    <select 
                      value={anShapeType} 
                      onChange={e => { setAnShapeType(e.target.value); setAnDrawPoints([]); }}
                      style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid var(--border)' }}
                    >
                      <option value="roi">ROI Polygon</option>
                      <option value="line">Line Crossing</option>
                    </select>
                  </div>
                  <div style={{ marginBottom: '12px' }}>
                    <span className="field-label" style={{ display: 'block', marginBottom: '4px' }}>NAME</span>
                    <input 
                      value={anShapeName} 
                      onChange={e => setAnShapeName(e.target.value)}
                      placeholder={anShapeType === 'roi' ? 'e.g., parking_zone' : 'e.g., entry_line'}
                      style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid var(--border)' }}
                    />
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button onClick={() => setAnDrawPoints([])} className="btn-secondary" style={{ flex: 1 }}>Clear Points</button>
                    <button onClick={() => {
                      if (!anShapeName) return alert('Please enter a name');
                      if (anShapeType === 'roi' && anDrawPoints.length < 6) return alert('ROI requires at least 3 points');
                      if (anShapeType === 'line' && anDrawPoints.length < 4) return alert('Line requires at least 2 points');
                      
                      const updated = { ...anConfigs };
                      if (anShapeType === 'roi') {
                        // remove existing with same name if any
                        updated.rois = updated.rois.filter(r => r.name !== anShapeName);
                        updated.rois.push({ name: anShapeName, coords: anDrawPoints });
                      } else {
                        updated.lines = updated.lines.filter(l => l.name !== anShapeName);
                        updated.lines.push({ name: anShapeName, coords: anDrawPoints });
                      }
                      setAnConfigs(updated);
                      setAnDrawPoints([]);
                      setAnShapeName('');
                    }} className="btn-save" style={{ flex: 1, background: '#10b981' }}>Save Shape</button>
                  </div>
                </div>
                <div className="an-shape-list">
                  <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-dim)', textTransform: 'uppercase' }}>Current Shapes</div>
                  {anConfigs.rois?.map(r => (
                    <div key={`s-roi-${r.name}`} className="an-shape-item">
                      <span><span style={{ color: '#10b981', fontWeight: 'bold' }}>ROI</span> {r.name}</span>
                      <button onClick={() => removeShape('roi', r.name)} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '16px' }}>×</button>
                    </div>
                  ))}
                  {anConfigs.lines?.map(l => (
                    <div key={`s-line-${l.name}`} className="an-shape-item">
                      <span><span style={{ color: '#ef4444', fontWeight: 'bold' }}>Line</span> {l.name}</span>
                      <button onClick={() => removeShape('line', l.name)} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '16px' }}>×</button>
                    </div>
                  ))}
                </div>
                <div className="an-sidebar-footer">
                  <button onClick={() => { setAnConfigs({ ...anConfigs, rois: [], lines: [] }); setAnDrawPoints([]); }} className="btn-secondary" style={{ color: '#ef4444' }}>Remove All</button>
                  <button onClick={() => { saveAnalyticsConfigToDb(anConfigs); setShowAnModal(false); }} className="btn-save">Save to Database & Close</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
