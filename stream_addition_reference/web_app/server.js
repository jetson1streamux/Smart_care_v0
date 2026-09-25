// StreamUX Web — Backend API Server
// Mirrors the desktop app's MongoClient (src/utils/mongo_client.cpp) data flow exactly.
import express from 'express';
import { MongoClient, ObjectId } from 'mongodb';
import { execSync } from 'child_process';

// ── Config (matches build/config.ini) ──
const MONGO_URI = process.env.MONGO_URI || 'mongodb://app_user:AppUser%40Building2026!@100.123.128.100:27017/?authSource=admin';
const IMAGE_HOST = process.env.IMAGE_HOST || 'http://100.123.128.100:5002/';
const PORT = process.env.API_PORT || 3001;

const app = express();
app.use(express.json());

let client;
let isConnected = false;

async function connectDB() {
  try {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    // Ping to verify (mirrors MongoClient::ping())
    await client.db('admin').command({ ping: 1 });
    isConnected = true;
    console.log('[HEALTH] MongoDB connected successfully');
  } catch (err) {
    console.error('[HEALTH] MongoDB connection failed:', err.message);
    isConnected = false;
  }
}

// ── Middleware: check DB connection ──
function requireDB(req, res, next) {
  if (!isConnected || !client) {
    return res.status(503).json({ error: 'MongoDB not connected' });
  }
  next();
}

// ══════════════════════════════════════════════
// AUTH — mirrors MongoClient::authenticateUser()
// ══════════════════════════════════════════════
app.post('/api/auth/login', requireDB, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    // Query global_db.users (same as desktop: mongoc_client_get_collection(client, "global_db", "users"))
    const users = client.db('global_db').collection('users');
    const user = await users.findOne({ username });
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Desktop uses crypt() from crypt.h for bcrypt verification.
    // We use the system's python3 + bcrypt or htpasswd to verify since
    // the Node.js bcryptjs library handles $2b$ hashes.
    let valid = false;
    try {
      // Use dynamic import for bcryptjs (may or may not be installed)
      const bcrypt = await import('bcryptjs');
      valid = bcrypt.default.compareSync(password, user.password);
    } catch {
      // Fallback: use system python3 with crypt module
      try {
        const result = execSync(
          `python3 -c "import crypt; print(crypt.crypt('${password.replace(/'/g, "\\'")}', '${user.password.replace(/'/g, "\\'")}') == '${user.password.replace(/'/g, "\\'")}')"`,
          { encoding: 'utf-8', timeout: 5000 }
        ).trim();
        valid = result === 'True';
      } catch {
        return res.status(500).json({ error: 'Password verification unavailable' });
      }
    }

    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Return db_name (same as desktop: App::getInstance().setCurrentDbName(db_name))
    res.json({ username, db_name: user.db_name });
  } catch (err) {
    console.error('[AUTH] Login error:', err.message);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// ── Password Update — mirrors MongoClient::updateUserPassword() ──
app.post('/api/auth/password', requireDB, async (req, res) => {
  try {
    const { username, current_password, new_password } = req.body;
    if (!username || !current_password || !new_password) {
      return res.status(400).json({ error: 'All fields required' });
    }

    // Verify current password first
    const users = client.db('global_db').collection('users');
    const user = await users.findOne({ username });
    if (!user) return res.status(404).json({ error: 'User not found' });

    let valid = false;
    try {
      const bcrypt = await import('bcryptjs');
      valid = bcrypt.default.compareSync(current_password, user.password);
    } catch {
      return res.status(500).json({ error: 'Password verification unavailable' });
    }
    if (!valid) return res.status(401).json({ error: 'Current password incorrect' });

    // Hash new password (mirrors desktop's bcrypt with $2b$12$)
    const bcrypt = await import('bcryptjs');
    const hash = bcrypt.default.hashSync(new_password, 12);
    await users.updateOne({ username }, { $set: { password: hash } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════
// STREAMS — mirrors MongoClient::getStreams()
// ══════════════════════════════════════════════
app.get('/api/streams', requireDB, async (req, res) => {
  try {
    const db_name = req.query.db;
    if (!db_name) return res.status(400).json({ error: 'db parameter required' });

    // Same as desktop: mongoc_collection_find_with_opts(coll, query, opts, nullptr) with sort by order_index
    const coll = client.db(db_name).collection('streams');
    const streams = await coll.find({}).sort({ order_index: 1 }).toArray();

    res.json(streams.map(s => ({
      stream_id: s.stream_id,
      rtsp_url: s.rtsp_url || '',
      webrtc_url: s.webrtc_url || '',
      order_index: s.order_index || 0,
      fallback_url: s.fallback_url || '',
      is_active: s.is_active || 0,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Update Stream URL — mirrors MongoClient::updateStreamUrl() ──
app.put('/api/streams/:id', requireDB, async (req, res) => {
  try {
    const db_name = req.query.db;
    const stream_id = parseInt(req.params.id);
    const { rtsp_url } = req.body;

    const coll = client.db(db_name).collection('streams');
    // Upsert (same as desktop: bson_init(&opts); BSON_APPEND_BOOL(&opts, "upsert", true))
    await coll.updateOne(
      { stream_id },
      { $set: { rtsp_url, stream_id, order_index: stream_id } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Delete Stream — mirrors MongoClient::deleteStream() ──
app.delete('/api/streams/:id', requireDB, async (req, res) => {
  try {
    const db_name = req.query.db;
    const stream_id = parseInt(req.params.id);
    await client.db(db_name).collection('streams').deleteOne({ stream_id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Delete Excess Streams — mirrors MongoClient::deleteExcessStreams() ──
app.post('/api/streams/trim', requireDB, async (req, res) => {
  try {
    const { db_name, keep_count } = req.body;
    await client.db(db_name).collection('streams').deleteMany({ stream_id: { $gte: keep_count } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════
// CAPTURED IMAGES — mirrors MongoClient::getCapturedImages()
// ══════════════════════════════════════════════
app.get('/api/events', requireDB, async (req, res) => {
  try {
    const db_name = req.query.db;
    if (!db_name) return res.status(400).json({ error: 'db parameter required' });

    const limit = parseInt(req.query.limit) || 50;
    const since_id = req.query.since || '';
    const before_id = req.query.before || '';
    const date_gte = req.query.date_gte || '';

    const coll = client.db(db_name).collection('captured_images');

    // Build query (same logic as desktop's getCapturedImages)
    const query = {};
    if (since_id || before_id) {
      query._id = {};
      if (since_id && ObjectId.isValid(since_id)) query._id.$gt = new ObjectId(since_id);
      if (before_id && ObjectId.isValid(before_id)) query._id.$lt = new ObjectId(before_id);
    }
    if (date_gte) {
      query.date = { $gte: date_gte };
    }

    // Sort _id: -1, limit (same as desktop)
    const docs = await coll.find(query).sort({ _id: -1 }).limit(limit).toArray();

    res.json(docs.map(d => ({
      id: d._id.toString(),
      event_type: d.event_type || '',
      area_name: d.area_name || '',
      object_id: d.object_id || 0,
      class_id: d.class_id || 0,
      stream_id: d.stream_id || 0,
      frame_number: d.frame_number || 0,
      image_path: d.image_path || '',
      date: d.date || '',
      time: d.time || '',
      is_verified: !!d.is_verified,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Get Single Event — mirrors MongoClient::getCapturedImageById() ──
app.get('/api/events/:id', requireDB, async (req, res) => {
  try {
    const db_name = req.query.db;
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid ID' });

    const doc = await client.db(db_name).collection('captured_images').findOne({ _id: new ObjectId(id) });
    if (!doc) return res.status(404).json({ error: 'Not found' });

    res.json({
      id: doc._id.toString(),
      event_type: doc.event_type || '',
      area_name: doc.area_name || '',
      object_id: doc.object_id || 0,
      class_id: doc.class_id || 0,
      stream_id: doc.stream_id || 0,
      frame_number: doc.frame_number || 0,
      image_path: doc.image_path || '',
      date: doc.date || '',
      time: doc.time || '',
      is_verified: !!doc.is_verified,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Update Event — mirrors MongoClient::updateCapturedImage() ──
app.put('/api/events/:id', requireDB, async (req, res) => {
  try {
    const db_name = req.query.db;
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid ID' });

    const { is_verified } = req.body;
    await client.db(db_name).collection('captured_images').updateOne(
      { _id: new ObjectId(id) },
      { $set: { is_verified: !!is_verified } }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Delete Event — mirrors MongoClient::deleteCapturedImage() ──
app.delete('/api/events/:id', requireDB, async (req, res) => {
  try {
    const db_name = req.query.db;
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid ID' });

    await client.db(db_name).collection('captured_images').deleteOne({ _id: new ObjectId(id) });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════
// DAILY STATS — mirrors MongoClient::getDailyEventStats()
// ══════════════════════════════════════════════
app.get('/api/stats/daily', requireDB, async (req, res) => {
  try {
    const db_name = req.query.db;
    const date = req.query.date;
    if (!db_name || !date) return res.status(400).json({ error: 'db and date required' });

    const coll = client.db(db_name).collection('captured_images');

    // Same as desktop: count total, count verified, pending = total - verified
    const total = await coll.countDocuments({ date });
    const verified = await coll.countDocuments({ date, is_verified: true });
    const pending = Math.max(0, total - verified);

    res.json({ total, verified, pending });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════
// ANALYTICS AGGREGATION (server-side for efficiency)
// ══════════════════════════════════════════════
app.get('/api/stats/analytics', requireDB, async (req, res) => {
  try {
    const db_name = req.query.db;
    const date_range = req.query.range || 'all'; // 'all', 'today', '7d', '30d'
    if (!db_name) return res.status(400).json({ error: 'db required' });

    const coll = client.db(db_name).collection('captured_images');
    const now = new Date();
    const query = {};

    if (date_range === 'today') {
      query.date = now.toISOString().slice(0, 10);
    } else if (date_range === '7d') {
      query.date = { $gte: new Date(now - 7 * 86400000).toISOString().slice(0, 10) };
    } else if (date_range === '30d') {
      query.date = { $gte: new Date(now - 30 * 86400000).toISOString().slice(0, 10) };
    }

    const docs = await coll.find(query).toArray();

    const eventCounts = {}, areaCounts = {}, streamCounts = {};
    const verifCounts = { Verified: 0, Unverified: 0 };

    docs.forEach(e => {
      eventCounts[e.event_type] = (eventCounts[e.event_type] || 0) + 1;
      areaCounts[e.area_name] = (areaCounts[e.area_name] || 0) + 1;
      const sk = 'Cam ' + e.stream_id;
      streamCounts[sk] = (streamCounts[sk] || 0) + 1;
      e.is_verified ? verifCounts.Verified++ : verifCounts.Unverified++;
    });

    // Week stats
    const weekAgo = new Date(now - 7 * 86400000).toISOString().slice(0, 10);
    const weekData = docs.filter(e => e.date >= weekAgo);

    res.json({
      total: docs.length,
      verified: verifCounts.Verified,
      pending: verifCounts.Unverified,
      weekTotal: weekData.length,
      weekVerified: weekData.filter(e => e.is_verified).length,
      eventCounts, areaCounts, streamCounts, verifCounts,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════
// ANALYTICS CONFIGS — mirrors MongoClient::getAnalyticsConfig / saveAnalyticsConfig
// ══════════════════════════════════════════════
app.get('/api/configs/:stream_id', requireDB, async (req, res) => {
  try {
    const db_name = req.query.db;
    const stream_id = parseInt(req.params.stream_id);
    const doc = await client.db(db_name).collection('client_configs').findOne({ config_name: 'client_app_config' });
    
    let config_width = 1280;
    let config_height = 720;
    let rois = [];
    let lines = [];
    
    if (doc && doc.data) {
      if (doc.data.property) {
        if (doc.data.property['config-width']) config_width = parseInt(doc.data.property['config-width']) || 1280;
        if (doc.data.property['config-height']) config_height = parseInt(doc.data.property['config-height']) || 720;
      }
      
      const roiKey = `roi-filtering-stream-${stream_id}`;
      if (doc.data[roiKey]) {
        for (const [k, v] of Object.entries(doc.data[roiKey])) {
          if (k.startsWith('roi-')) {
            const coords = v.split(';').map(n => parseInt(n)).filter(n => !isNaN(n));
            const name = k.substring(4);
            const count = await client.db(db_name).collection('captured_images').countDocuments({ area_name: name, stream_id: stream_id });
            rois.push({ name, coords, count });
          }
        }
      }
      
      const lineKey = `line-crossing-stream-${stream_id}`;
      if (doc.data[lineKey]) {
        for (const [k, v] of Object.entries(doc.data[lineKey])) {
          if (k.startsWith('line-crossing-')) {
            const parts = v.split(';').map(n => parseInt(n)).filter(n => !isNaN(n));
            const name = k.substring(14);
            const count = await client.db(db_name).collection('captured_images').countDocuments({ area_name: name, stream_id: stream_id });
            lines.push({ name, coords: parts, count });
          }
        }
      }
    }
    
    res.json({ stream_id, config_width, config_height, rois, lines });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/configs/:stream_id', requireDB, async (req, res) => {
  try {
    const db_name = req.query.db;
    const stream_id = parseInt(req.params.stream_id);
    const { raw_text, config_width, config_height } = req.body;
    await client.db(db_name).collection('client_configs').updateOne(
      { stream_id },
      { $set: { stream_id, raw_text, config_width: config_width || 1920, config_height: config_height || 1080 } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════
// REAL-TIME EVENTS (SSE) — mirrors UdpListener
// ══════════════════════════════════════════════
const clients = new Set();
app.get('/api/stream-updates', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// Mock UDP trigger (since desktop app binds to 8889, we can just use a polling interval on the server to push updates if needed, or simply rely on frontend polling)
setInterval(() => {
  clients.forEach(c => c.write('data: PING\\n\\n'));
}, 5000);

// ══════════════════════════════════════════════
// CONFIG & HEALTH
// ══════════════════════════════════════════════
app.get('/api/config', (req, res) => {
  res.json({
    image_host: IMAGE_HOST,
    webrtc_base: process.env.WEBRTC_BASE || 'http://100.123.128.100:8889',
  });
});

app.get('/api/health/mongo', async (req, res) => {
  try {
    if (!client) return res.json({ ok: false });
    await client.db('admin').command({ ping: 1 });
    res.json({ ok: true });
  } catch {
    res.json({ ok: false });
  }
});

app.get('/api/health/image', async (req, res) => {
  try {
    const r = await fetch(IMAGE_HOST, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
    res.json({ ok: true });
  } catch {
    res.json({ ok: false });
  }
});

// ── Start Server ──
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`[SERVER] StreamUX API running on http://localhost:${PORT}`);
  });
});
