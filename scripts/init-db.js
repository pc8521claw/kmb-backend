/**
 * Initialize DB with data if empty
 * Run automatically on startup
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/kmb.db');
const DATA_PATH = path.join(__dirname, '../data/routeFareList.min.json');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Check if DB is empty
const dbExists = fs.existsSync(DB_PATH);
let needsImport = false;

if (dbExists) {
  const db = new Database(DB_PATH, { readonly: true });
  const routeCount = db.prepare('SELECT COUNT(*) as c FROM routes').get()?.c || 0;
  db.close();
  needsImport = routeCount === 0;
} else {
  needsImport = true;
}

if (!needsImport) {
  console.log('📊 Database already has data, skipping import');
  process.exit(0);
}

if (!fs.existsSync(DATA_PATH)) {
  console.log('⚠️ routeFareList.min.json not found at', DATA_PATH);
  console.log('Please copy the file to data/ folder or run: npm run import');
  process.exit(0);
}

console.log('📥 Importing data...');

// Load JSON
const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Create schema
db.exec(`
  CREATE TABLE IF NOT EXISTS holidays (date TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS stops (stop_id TEXT PRIMARY KEY, company TEXT, nlb_stop_id TEXT, name_tc TEXT);
  CREATE TABLE IF NOT EXISTS routes (id INTEGER PRIMARY KEY, route_number TEXT NOT NULL, seq INTEGER, company TEXT NOT NULL, origin_tc TEXT, destination_tc TEXT, origin_en TEXT, destination_en TEXT, service_type TEXT, gtfs_id TEXT, jt TEXT);
  CREATE TABLE IF NOT EXISTS route_stops (id INTEGER PRIMARY KEY, route_id INTEGER, stop_id TEXT, stop_seq INTEGER);
  CREATE TABLE IF NOT EXISTS fares (id INTEGER PRIMARY KEY, route_id INTEGER, fare REAL, stop_seq INTEGER, stop_id TEXT);
  CREATE TABLE IF NOT EXISTS service_freq (id INTEGER PRIMARY KEY, route_id INTEGER, bound TEXT, start_time TEXT, end_time TEXT, headway INTEGER);
  CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT);
`);

// Create default admin only if none exists
const adminCount = db.prepare('SELECT COUNT(*) as count FROM admins').get()?.count || 0;
if (adminCount === 0) {
  db.prepare('INSERT OR IGNORE INTO admins (username, password_hash) VALUES (?, ?)').run('admin', 'admin123');
  console.log('Default admin created: admin / admin123');
} else {
  console.log('Admin exists, skipping default creation');
}

// Insert holidays
const insertHoliday = db.prepare('INSERT OR IGNORE INTO holidays (date) VALUES (?)');
for (const date of data.holidays) insertHoliday.run(date);

// Insert stops
const insertStop = db.prepare('INSERT OR IGNORE INTO stops (stop_id, company, nlb_stop_id, name_tc) VALUES (?, ?, ?, ?)');
for (const [stopId, info] of Object.entries(data.stopMap)) {
  if (Array.isArray(info)) {
    for (const [company, nlbId] of info) {
      const stopInfo = data.stopList?.[stopId];
      insertStop.run(stopId, company, nlbId || null, stopInfo?.name?.zh || null);
    }
  }
}

// Insert routes
const insertRoute = db.prepare('INSERT INTO routes (route_number, seq, company, origin_tc, destination_tc, origin_en, destination_en, service_type, gtfs_id, jt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
const insertRouteStop = db.prepare('INSERT INTO route_stops (route_id, stop_id, stop_seq) VALUES (?, ?, ?)');
const insertFare = db.prepare('INSERT INTO fares (route_id, fare, stop_seq, stop_id) VALUES (?, ?, ?, ?)');
const insertFreq = db.prepare('INSERT INTO service_freq (route_id, bound, start_time, end_time, headway) VALUES (?, ?, ?, ?, ?)');

let routeCount = 0;
const tx = db.transaction(() => {
  for (const [key, routeData] of Object.entries(data.routeList)) {
    const parts = key.split('+');
    const routeNumber = parts[0];
    const seq = parseInt(parts[1]) || 0;
    const company = routeData.co?.[0]?.toUpperCase() || 'KMB';
    
    const stops = routeData.stops?.kmb || routeData.stops?.gmb;
    if (!stops) continue;
    
    const r = insertRoute.run(routeNumber, seq, company, routeData.orig?.zh || null, routeData.dest?.zh || null, routeData.orig?.en || null, routeData.dest?.en || null, routeData.serviceType || null, routeData.gtfsId || null, routeData.jt || null);
    const routeId = r.lastInsertRowid;
    routeCount++;
    
    stops.forEach((stopId, i) => {
      insertRouteStop.run(routeId, stopId, i + 1);
      if (routeData.fares?.[i]) {
        insertFare.run(routeId, parseFloat(routeData.fares[i]), i + 1, stopId);
      }
    });
    
    if (routeData.freq) {
      for (const [bound, ts] of Object.entries(routeData.freq)) {
        if (ts && typeof ts === 'object') {
          for (const [st, val] of Object.entries(ts)) {
            if (Array.isArray(val) && val.length >= 2) {
              insertFreq.run(routeId, bound, st, val[0], val[1]);
            }
          }
        }
      }
    }
  }
});
tx();

const stats = {
  routes: db.prepare('SELECT COUNT(*) c FROM routes').get().c,
  stops: db.prepare('SELECT COUNT(*) c FROM stops').get().c,
  fares: db.prepare('SELECT COUNT(*) c FROM fares').get().c,
};
console.log('✅ Import complete:', JSON.stringify(stats));
db.close();
