/**
 * Import routeFareList.min.json into SQLite database
 * 
 * Data structure from routeFareList.min.json:
 * - routeList: { [key]: { route, seq, orig, dest, co, bound, stops, fares, freq, serviceType, ... } }
 * - stopMap: { [stopId]: [[company, stopId], ...] }
 * - holidays: string[] of holiday dates
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const JSON_PATH = path.join(__dirname, '../../apps/angular/bus-app-angular/src/assets/data/routeFareList.min.json');
const DB_PATH = path.join(__dirname, '../data/kmb.db');

console.log('🔄 Loading JSON data...');
const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));

console.log(`📊 Routes: ${Object.keys(data.routeList).length}`);
console.log(`📊 Stops: ${Object.keys(data.stopMap).length}`);
console.log(`📊 Holidays: ${data.holidays.length}`);

// Init DB
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Create schema
db.exec(`
  -- Holidays
  CREATE TABLE IF NOT EXISTS holidays (
    date TEXT PRIMARY KEY
  );

  -- Stops
  CREATE TABLE IF NOT EXISTS stops (
    stop_id TEXT PRIMARY KEY,
    company TEXT,
    nlb_stop_id TEXT,
    name_tc TEXT,
    name_en TEXT,
    lat REAL,
    lon REAL
  );

  -- Routes
  CREATE TABLE IF NOT EXISTS routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_number TEXT NOT NULL,
    seq INTEGER,
    company TEXT NOT NULL,
    origin_tc TEXT,
    destination_tc TEXT,
    origin_en TEXT,
    destination_en TEXT,
    service_type TEXT,
    gtfs_id TEXT,
    jt TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    UNIQUE(route_number, seq, company)
  );

  -- Route-Stops mapping
  CREATE TABLE IF NOT EXISTS route_stops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id INTEGER REFERENCES routes(id),
    stop_id TEXT REFERENCES stops(stop_id),
    stop_seq INTEGER,
    UNIQUE(route_id, stop_seq)
  );

  -- Fares
  CREATE TABLE IF NOT EXISTS fares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id INTEGER REFERENCES routes(id),
    fare REAL,
    fare_holiday REAL,
    stop_seq INTEGER,
    UNIQUE(route_id, stop_seq)
  );

  -- Service frequency
  CREATE TABLE IF NOT EXISTS service_freq (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id INTEGER REFERENCES routes(id),
    bound TEXT,
    start_time TEXT,
    end_time TEXT,
    headway INTEGER,
    UNIQUE(route_id, bound, start_time)
  );

  -- Migration log
  CREATE TABLE IF NOT EXISTS migration_log (
    name TEXT PRIMARY KEY,
    ran_at INTEGER
  );
`);

// Clear existing data (for re-import)
console.log('🗑️ Clearing existing data...');
db.exec('DELETE FROM route_stops');
db.exec('DELETE FROM fares');
db.exec('DELETE FROM service_freq');
db.exec('DELETE FROM routes');
db.exec('DELETE FROM stops');
db.exec('DELETE FROM holidays');

// Insert holidays
console.log('📅 Importing holidays...');
const insertHoliday = db.prepare('INSERT OR IGNORE INTO holidays (date) VALUES (?)');
for (const date of data.holidays) {
  insertHoliday.run(date);
}

// Build stop lookup from stopList
console.log('🛑 Building stop lookup...');
const stopLookup = {};
if (data.stopList) {
  for (const stop of data.stopList) {
    stopLookup[stop.stop_id] = {
      name_tc: stop.name_tc,
      name_en: stop.name_en,
      lat: stop.lat,
      lon: stop.lon
    };
  }
}
console.log(`📊 Stop lookup size: ${Object.keys(stopLookup).length}`);

// Insert stops from stopMap
console.log('🛑 Importing stops...');
const insertStop = db.prepare(`
  INSERT OR IGNORE INTO stops (stop_id, company, nlb_stop_id, name_tc, name_en)
  VALUES (?, ?, ?, ?, ?)
`);

let stopCount = 0;
for (const [stopId, info] of Object.entries(data.stopMap)) {
  // info is array of [company, nlbId] pairs
  for (const [company, nlbId] of info) {
    const stopInfo = stopLookup[stopId] || {};
    insertStop.run(
      stopId,
      company,
      nlbId || null,
      stopInfo.name_tc || null,
      stopInfo.name_en || null
    );
    stopCount++;
  }
}
console.log(`📊 Stops inserted: ${stopCount}`);

// Insert routes and related data
console.log('🚌 Importing routes...');
const insertRoute = db.prepare(`
  INSERT OR REPLACE INTO routes (route_number, seq, company, origin_tc, destination_tc, origin_en, destination_en, service_type, gtfs_id, jt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertRouteStop = db.prepare(`
  INSERT INTO route_stops (route_id, stop_id, stop_seq)
  VALUES (?, ?, ?)
`);

const insertFare = db.prepare(`
  INSERT INTO fares (route_id, fare, stop_seq)
  VALUES (?, ?, ?)
`);

const insertFreq = db.prepare(`
  INSERT INTO service_freq (route_id, bound, start_time, end_time, headway)
  VALUES (?, ?, ?, ?, ?)
`);

let routeCount = 0;
let routeStopCount = 0;
let fareCount = 0;
let freqCount = 0;

const transaction = db.transaction(() => {
  for (const [key, routeData] of Object.entries(data.routeList)) {
    // Parse key: routeNumber+seq+origin+dest
    const parts = key.split('+');
    const routeNumber = parts[0];
    const seq = parseInt(parts[1]) || 0;
    const company = routeData.co && routeData.co[0] ? routeData.co[0].toUpperCase() : 'KMB';
    
    // Insert route
    const result = insertRoute.run(
      routeNumber,
      seq,
      company,
      routeData.orig?.zh || null,
      routeData.dest?.zh || null,
      routeData.orig?.en || null,
      routeData.dest?.en || null,
      routeData.serviceType || null,
      routeData.gtfsId || null,
      routeData.jt || null
    );
    
    const routeId = result.lastInsertRowid;
    routeCount++;
    
    // Insert route-stops mapping
    if (routeData.stops && routeData.stops.kmb) {
      routeData.stops.kmb.forEach((stopId, index) => {
        insertRouteStop.run(routeId, stopId, index + 1);
        routeStopCount++;
      });
    }
    
    // Insert fares
    if (routeData.fares) {
      routeData.fares.forEach((fare, index) => {
        if (fare && fare !== '') {
          insertFare.run(routeId, parseFloat(fare), index + 1);
          fareCount++;
        }
      });
    }
    
    // Insert service frequency
    if (routeData.freq) {
      for (const [bound, timeSlots] of Object.entries(routeData.freq)) {
        for (const [startTime, [endTime, headway]] of Object.entries(timeSlots)) {
          insertFreq.run(routeId, bound, startTime, endTime, headway);
          freqCount++;
        }
      }
    }
  }
});

transaction();

console.log('✅ Import complete!');
console.log(`- Routes: ${routeCount}`);
console.log(`- Route-Stops: ${routeStopCount}`);
console.log(`- Fares: ${fareCount}`);
console.log(`- Service frequencies: ${freqCount}`);

// Log migration
db.prepare('INSERT OR REPLACE INTO migration_log (name, ran_at) VALUES (?, ?)').run('import_routefare_v1', Date.now());

// Show stats
const stats = {
  routes: db.prepare('SELECT COUNT(*) as c FROM routes').get().c,
  stops: db.prepare('SELECT COUNT(*) as c FROM stops').get().c,
  routeStops: db.prepare('SELECT COUNT(*) as c FROM route_stops').get().c,
  fares: db.prepare('SELECT COUNT(*) as c FROM fares').get().c,
  holidays: db.prepare('SELECT COUNT(*) as c FROM holidays').get().c,
};

console.log('\n📈 Final DB stats:');
console.log(JSON.stringify(stats, null, 2));

db.close();
