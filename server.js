const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const https = require('https');

// Config
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'kmb-backend-secret-key-change-in-production';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'kmb.db');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Init DB
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// ============ DATABASE SCHEMA ============
db.exec(`
  -- Admin users
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  -- Bus routes
  CREATE TABLE IF NOT EXISTS routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_number TEXT NOT NULL,
    company TEXT NOT NULL, -- 'KMB' or 'CTB'
    origin_tc TEXT,
    destination_tc TEXT,
    origin_sc TEXT,
    destination_sc TEXT,
    origin_en TEXT,
    destination_en TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    UNIQUE(route_number, company)
  );

  -- Fare data
  CREATE TABLE IF NOT EXISTS fares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id INTEGER REFERENCES routes(id),
    stop_seq INTEGER,
    stop_id TEXT,
    stop_name_tc TEXT,
    stop_name_en TEXT,
    fare REAL,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  -- Service hours
  CREATE TABLE IF NOT EXISTS service_hours (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id INTEGER REFERENCES routes(id),
    direction TEXT NOT NULL, -- 'outbound' or 'inbound'
    first_bus TEXT,
    last_bus TEXT,
    last_updated INTEGER
  );

  -- Announcements
  CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    priority INTEGER DEFAULT 1,  -- 1=一般, 5=中, 10=高(置頂)
    active INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  -- Migration log
  CREATE TABLE IF NOT EXISTS migration_log (
    name TEXT PRIMARY KEY,
    ran_at INTEGER
  );
`);

// Create default admin if none exists (password: admin123)
const adminCount = db.prepare('SELECT COUNT(*) as count FROM admins').get().count;
if (adminCount === 0) {
  // Simple hash for demo - in production use bcrypt
  const passwordHash = 'admin123'; // TODO: hash this
  db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run('admin', passwordHash);
  console.log('Default admin created: admin / admin123');
}

// ============ AUTH MIDDLEWARE ============
function authenticateAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ============ PUBLIC API ROUTES ============

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Simple proxy helper
function proxyGet(req, res, targetHost, targetPath) {
  const options = {
    hostname: targetHost,
    port: 443,
    path: targetPath,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json',
    }
  };
  
  const proxyReq = https.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });
  
  proxyReq.on('error', (err) => {
    res.status(502).json({ error: 'Proxy error', message: err.message });
  });
  
  proxyReq.end();
}

// KMB API proxy
app.use('/api/kmb', (req, res) => {
  const pathPart = req.url.startsWith('/') ? req.url : '/' + req.url;
  proxyGet(req, res, 'data.etabus.gov.hk', '/v1/transport/kmb' + pathPart);
});

// CTB API proxy
app.use('/api/ctb', (req, res) => {
  const pathPart = req.url.startsWith('/') ? req.url : '/' + req.url;
  proxyGet(req, res, 'rt.data.gov.hk', '/v2/transport/citybus' + pathPart);
});

// Get all routes (with pagination)
app.get('/api/routes', (req, res) => {
  try {
    const { page = 1, limit = 50, company, search } = req.query;
    const offset = (page - 1) * limit;
    
    let sql = 'SELECT * FROM routes WHERE 1=1';
    const params = [];
    
    if (company) {
      sql += ' AND company = ?';
      params.push(company);
    }
    if (search) {
      sql += ' AND (route_number LIKE ? OR origin_tc LIKE ? OR destination_tc LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    
    sql += ' ORDER BY route_number LIMIT ? OFFSET ?';
    params.push(limit, offset);
    
    const routes = db.prepare(sql).all(...params);
    const total = db.prepare('SELECT COUNT(*) as count FROM routes').get().count;
    
    res.json({ routes, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get route by ID with fares and service info
app.get('/api/routes/:id', (req, res) => {
  try {
    const route = db.prepare('SELECT * FROM routes WHERE id = ?').get(req.params.id);
    if (!route) {
      return res.status(404).json({ error: 'Route not found' });
    }
    
    const fares = db.prepare(`
      SELECT f.fare, f.stop_seq, s.name_tc as stop_name_tc
      FROM fares f
      LEFT JOIN stops s ON f.stop_id = s.stop_id
      WHERE f.route_id = ?
      ORDER BY f.stop_seq
    `).all(req.params.id);
    
    const serviceFreq = db.prepare('SELECT * FROM service_freq WHERE route_id = ? ORDER BY bound, start_time').all(req.params.id);
    
    res.json({ ...route, fares, serviceFreq });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get fares by route number
app.get('/api/fares/:routeNumber', (req, res) => {
  try {
    const { company } = req.query;
    let sql = `
      SELECT f.fare, f.stop_seq, r.route_number, r.company, r.origin_tc, r.destination_tc,
             s.name_tc as stop_name_tc
      FROM fares f
      JOIN routes r ON f.route_id = r.id
      LEFT JOIN stops s ON f.stop_id = s.stop_id
      WHERE r.route_number = ?
    `;
    const params = [req.params.routeNumber];
    
    if (company) {
      sql += ' AND UPPER(r.company) = UPPER(?)';
      params.push(company);
    }
    
    sql += ' ORDER BY f.stop_seq';
    
    const fares = db.prepare(sql).all(...params);
    res.json(fares);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get service hours
app.get('/api/service-hours/:routeNumber', (req, res) => {
  try {
    const { company } = req.query;
    let sql = `
      SELECT sf.*, r.route_number, r.company
      FROM service_freq sf
      JOIN routes r ON sf.route_id = r.id
      WHERE r.route_number = ?
    `;
    const params = [req.params.routeNumber];
    
    if (company) {
      sql += ' AND UPPER(r.company) = UPPER(?)';
      params.push(company);
    }
    
    sql += ' ORDER BY sf.bound, sf.start_time';
    
    const serviceHours = db.prepare(sql).all(...params);
    res.json(serviceHours);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get announcements
app.get('/api/announcements', (req, res) => {
  try {
    const announcements = db.prepare(
      'SELECT * FROM announcements WHERE active = 1 ORDER BY priority DESC, created_at DESC'
    ).all();
    res.json(announcements);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ ADMIN API ROUTES ============

// Admin login
app.post('/api/admin/login', (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
    
    if (!admin || admin.password_hash !== password) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = jwt.sign({ id: admin.id, username: admin.username }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, username: admin.username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get admin info
app.get('/api/admin/me', authenticateAdmin, (req, res) => {
  res.json({ id: req.admin.id, username: req.admin.username });
});

// Change password
app.put('/api/admin/password', authenticateAdmin, (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password required' });
    }
    
    if (newPassword.length < 4) {
      return res.status(400).json({ error: 'New password must be at least 4 characters' });
    }
    
    // Verify current password
    const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.admin.id);
    if (!admin || admin.password_hash !== currentPassword) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    
    // Update password
    db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(newPassword, req.admin.id);
    
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CRUD: Routes
app.get('/api/admin/routes', authenticateAdmin, (req, res) => {
  try {
    const routes = db.prepare('SELECT * FROM routes ORDER BY route_number').all();
    res.json(routes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/routes', authenticateAdmin, (req, res) => {
  try {
    const { route_number, company, origin_tc, destination_tc, origin_sc, destination_sc, origin_en, destination_en } = req.body;
    
    const result = db.prepare(`
      INSERT INTO routes (route_number, company, origin_tc, destination_tc, origin_sc, destination_sc, origin_en, destination_en)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(route_number, company, origin_tc, destination_tc, origin_sc, destination_sc, origin_en, destination_en);
    
    res.json({ id: result.lastInsertRowid, message: 'Route created' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/routes/:id', authenticateAdmin, (req, res) => {
  try {
    const { origin_tc, destination_tc, origin_sc, destination_sc, origin_en, destination_en } = req.body;
    
    db.prepare(`
      UPDATE routes SET origin_tc = ?, destination_tc = ?, origin_sc = ?, destination_sc = ?, origin_en = ?, destination_en = ?
      WHERE id = ?
    `).run(origin_tc, destination_tc, origin_sc, destination_sc, origin_en, destination_en, req.params.id);
    
    res.json({ message: 'Route updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/routes/:id', authenticateAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM fares WHERE route_id = ?').run(req.params.id);
    db.prepare('DELETE FROM service_hours WHERE route_id = ?').run(req.params.id);
    db.prepare('DELETE FROM routes WHERE id = ?').run(req.params.id);
    res.json({ message: 'Route deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CRUD: Fares
app.get('/api/admin/routes/:id/fares', authenticateAdmin, (req, res) => {
  try {
    const fares = db.prepare('SELECT * FROM fares WHERE route_id = ? ORDER BY stop_seq').all(req.params.id);
    res.json(fares);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/fares', authenticateAdmin, (req, res) => {
  try {
    const { route_id, stop_seq, stop_id, stop_name_tc, stop_name_en, fare } = req.body;
    
    const result = db.prepare(`
      INSERT INTO fares (route_id, stop_seq, stop_id, stop_name_tc, stop_name_en, fare)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(route_id, stop_seq, stop_id, stop_name_tc, stop_name_en, fare);
    
    res.json({ id: result.lastInsertRowid, message: 'Fare added' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all fares with route info (for admin)
app.get('/api/admin/fares', authenticateAdmin, (req, res) => {
  try {
    const { search, limit = 100, offset = 0 } = req.query;
    
    let sql = `
      SELECT f.id, f.fare, f.stop_seq, r.route_number, r.company, r.origin_tc, r.destination_tc,
             s.name_tc as stop_name_tc
      FROM fares f
      JOIN routes r ON f.route_id = r.id
      LEFT JOIN stops s ON f.stop_id = s.stop_id
      WHERE 1=1
    `;
    const params = [];
    
    if (search) {
      sql += ' AND r.route_number LIKE ?';
      params.push(`%${search}%`);
    }
    
    sql += ' ORDER BY r.route_number, f.stop_seq LIMIT ? OFFSET ?';
    params.push(limit, offset);
    
    const fares = db.prepare(sql).all(...params);
    const total = db.prepare('SELECT COUNT(*) as count FROM fares').get().count;
    
    res.json({ fares, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/fares/:id', authenticateAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM fares WHERE id = ?').run(req.params.id);
    res.json({ message: 'Fare deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/fares/:id', authenticateAdmin, (req, res) => {
  try {
    const { fare } = req.body;
    db.prepare('UPDATE fares SET fare = ? WHERE id = ?').run(fare, req.params.id);
    res.json({ message: 'Fare updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CRUD: Service Hours
app.get('/api/admin/routes/:id/service-hours', authenticateAdmin, (req, res) => {
  try {
    const serviceHours = db.prepare('SELECT * FROM service_hours WHERE route_id = ?').all(req.params.id);
    res.json(serviceHours);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/service-hours', authenticateAdmin, (req, res) => {
  try {
    const { route_id, direction, first_bus, last_bus } = req.body;
    
    const existing = db.prepare('SELECT id FROM service_hours WHERE route_id = ? AND direction = ?')
      .get(route_id, direction);
    
    if (existing) {
      db.prepare('UPDATE service_hours SET first_bus = ?, last_bus = ?, last_updated = strftime(\'%s\', \'now\') WHERE id = ?')
        .run(first_bus, last_bus, existing.id);
      res.json({ message: 'Service hours updated' });
    } else {
      const result = db.prepare(`
        INSERT INTO service_hours (route_id, direction, first_bus, last_bus)
        VALUES (?, ?, ?, ?)
      `).run(route_id, direction, first_bus, last_bus);
      res.json({ id: result.lastInsertRowid, message: 'Service hours created' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Service frequency CRUD
app.get('/api/admin/routes/:id/service-freq', authenticateAdmin, (req, res) => {
  try {
    const freqs = db.prepare('SELECT * FROM service_freq WHERE route_id = ? ORDER BY bound, start_time').all(req.params.id);
    res.json(freqs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/service-freq', authenticateAdmin, (req, res) => {
  try {
    const { route_id, bound, start_time, end_time, headway } = req.body;
    
    const result = db.prepare(`
      INSERT INTO service_freq (route_id, bound, start_time, end_time, headway)
      VALUES (?, ?, ?, ?, ?)
    `).run(route_id, bound, start_time, end_time, headway);
    
    res.json({ id: result.lastInsertRowid, message: 'Service frequency created' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/service-freq/:id', authenticateAdmin, (req, res) => {
  try {
    const { start_time, end_time, headway } = req.body;
    db.prepare('UPDATE service_freq SET start_time = ?, end_time = ?, headway = ? WHERE id = ?')
      .run(start_time, end_time, headway, req.params.id);
    res.json({ message: 'Service frequency updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/service-freq/:id', authenticateAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM service_freq WHERE id = ?').run(req.params.id);
    res.json({ message: 'Service frequency deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CRUD: Announcements
app.get('/api/admin/announcements', authenticateAdmin, (req, res) => {
  try {
    const announcements = db.prepare('SELECT * FROM announcements ORDER BY priority DESC, created_at DESC').all();
    res.json(announcements);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/announcements', authenticateAdmin, (req, res) => {
  try {
    const { title, content, priority } = req.body;
    
    const result = db.prepare(`
      INSERT INTO announcements (title, content, priority)
      VALUES (?, ?, ?)
    `).run(title, content, priority || 1);
    
    res.json({ id: result.lastInsertRowid, message: 'Announcement created' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/announcements/:id', authenticateAdmin, (req, res) => {
  try {
    const { title, content, priority, active } = req.body;
    
    db.prepare('UPDATE announcements SET title = ?, content = ?, priority = ?, active = ? WHERE id = ?')
      .run(title, content, priority || 1, active !== undefined ? active : 1, req.params.id);
    
    res.json({ message: 'Announcement updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/announcements/:id', authenticateAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM announcements WHERE id = ?').run(req.params.id);
    res.json({ message: 'Announcement deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stats
app.get('/api/admin/stats', authenticateAdmin, (req, res) => {
  try {
    const stats = {
      routes: db.prepare('SELECT COUNT(*) as count FROM routes').get().count,
      fares: db.prepare('SELECT COUNT(*) as count FROM fares').get().count,
      freqs: db.prepare('SELECT COUNT(*) as count FROM service_freq').get().count,
      announcements: db.prepare('SELECT COUNT(*) as count FROM announcements').get().count,
    };
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all service freqs with route info
app.get('/api/admin/service-freq', authenticateAdmin, (req, res) => {
  try {
    const { search, limit = 100, offset = 0 } = req.query;
    
    let sql = `
      SELECT sf.*, r.route_number, r.company, r.origin_tc, r.destination_tc
      FROM service_freq sf
      JOIN routes r ON sf.route_id = r.id
      WHERE 1=1
    `;
    const params = [];
    
    if (search) {
      sql += ' AND r.route_number LIKE ?';
      params.push(`%${search}%`);
    }
    
    sql += ' ORDER BY r.route_number, sf.bound, sf.start_time LIMIT ? OFFSET ?';
    params.push(limit, offset);
    
    const freqs = db.prepare(sql).all(...params);
    const total = db.prepare('SELECT COUNT(*) as count FROM service_freq').get().count;
    
    res.json({ freqs, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ STATIC FILES (Admin Panel) ============
app.use('/admin', express.static(path.join(__dirname, 'public')));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ START SERVER ============
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚌 KMB Backend running on http://0.0.0.0:${PORT}`);
  console.log(`📊 Admin Panel: http://0.0.0.0:${PORT}/admin`);
  console.log(`🔐 Default login: admin / admin123`);
});

module.exports = app;
