const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const mysql = require('mysql2/promise');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
require('dotenv').config();

// 🔌 ARDUINO - OPTIONAL (won't crash if not connected)
let arduinoPort = null;
let parser = null;

try {
  const { SerialPort } = require('serialport');
  const { ReadlineParser } = require('@serialport/parser-readline');

  arduinoPort = new SerialPort({
    path: process.env.ARDUINO_PORT || 'COM6',
    baudRate: 9600
  });

  parser = arduinoPort.pipe(new ReadlineParser({ delimiter: '\n' }));

  arduinoPort.on('open', () => {
    console.log('🔌 Arduino Connected (Hardware Mode)');
  });

  arduinoPort.on('error', (err) => {
    console.log('⚠️  Arduino not connected - Running in Software-Only Mode');
    arduinoPort = null;
  });

  if (parser) {
    parser.on('data', (data) => {
      const uid = data.trim();
      if (!uid || uid.includes('Enter') || uid.length < 6) return;
      console.log(`📡 RFID UID: ${uid}`);
      const token = 'A' + Date.now().toString().slice(-3);
      const patient = `RFID-${uid.slice(-4)}`;
      db.run(
        "INSERT INTO queue (token, patient, counter, status, priority, synced) VALUES (?, ?, ?, 'waiting', 'normal', 0)",
        [token, patient, 1],
        function (err) {
          if (err) return console.error(err);
          console.log(`✅ RFID Token Created: ${token}`);
          io.emit('queueUpdate');
        }
      );
    });
  }
} catch (e) {
  console.log('⚠️  SerialPort not available - Running in Software-Only Mode (No hardware needed)');
}

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static('Public'));

// ──────────────────────────────────────────────
// 🗄️  SQLite (OFFLINE-FIRST)
// ──────────────────────────────────────────────
const db = new sqlite3.Database('./queue.db');
console.log('✅ SQLite Connected - OFFLINE READY');

// Priority weight: emergency=3, senior=2, normal=1
const PRIORITY_WEIGHT = { emergency: 3, senior: 2, normal: 1 };

db.serialize(() => {
  db.run(`DROP TABLE IF EXISTS queue`);
  db.run(`CREATE TABLE queue (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    token        TEXT    NOT NULL,
    patient      TEXT    NOT NULL,
    counter      INTEGER DEFAULT 1,
    status       TEXT    DEFAULT 'waiting',
    priority     TEXT    DEFAULT 'normal',
    priority_weight INTEGER DEFAULT 1,
    registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    called_at    DATETIME,
    served_at    DATETIME,
    synced       INTEGER DEFAULT 0,
    device_id    TEXT    DEFAULT 'GOVT-OPD-01'
  )`);

  db.run(`DROP TABLE IF EXISTS service_log`);
  db.run(`CREATE TABLE service_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    priority      TEXT,
    service_secs  INTEGER,
    logged_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  console.log('✅ GOVT Hospital queue table ready');
});

// ──────────────────────────────────────────────
// 🌐 MySQL (ONLINE SYNC)
// ──────────────────────────────────────────────
let mysqlPool = null;
let onlineStatus = { mysql: false, lastSync: null, pending: 0 };

async function initMySQL() {
  try {
    mysqlPool = await mysql.createPool({
      host: process.env.MYSQL_HOST || 'localhost',
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASS || '',
      database: process.env.MYSQL_DB || 'govt_hospital',
      waitForConnections: true,
      connectionLimit: 10
    });
    onlineStatus.mysql = true;
    console.log('✅ MySQL Connected - ONLINE MODE');
  } catch (e) {
    onlineStatus.mysql = false;
    console.log('⚠️  MySQL Offline - Using SQLite Only');
  }
}

// ──────────────────────────────────────────────
// 🔮 WAITING TIME PREDICTION
// ──────────────────────────────────────────────
function getAvgServiceTime(priority) {
  return new Promise((resolve) => {
    db.get(
      `SELECT AVG(service_secs) as avg FROM service_log WHERE priority = ? LIMIT 20`,
      [priority],
      (err, row) => {
        if (err || !row || !row.avg) {
          const defaults = { emergency: 120, senior: 240, normal: 300 };
          resolve(defaults[priority] || 300);
        } else {
          resolve(Math.round(row.avg));
        }
      }
    );
  });
}

async function estimateWaitTime(position, priority) {
  const avgSecs = await getAvgServiceTime(priority);
  const totalSecs = position * avgSecs;
  return Math.round(totalSecs / 60);
}

// ──────────────────────────────────────────────
// 📡 APIs
// ──────────────────────────────────────────────
app.get('/api/queue', async (req, res) => {
  db.all(
    `SELECT * FROM queue 
     WHERE status != 'served' 
     ORDER BY priority_weight DESC, id ASC 
     LIMIT 30`,
    async (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const waitingRows = rows.filter(r => r.status === 'waiting');
      const enriched = await Promise.all(
        rows.map(async (row) => {
          if (row.status !== 'waiting') return { ...row, estimated_wait_mins: 0 };
          const pos = waitingRows.findIndex(r => r.id === row.id);
          const mins = await estimateWaitTime(pos + 1, row.priority);
          return { ...row, estimated_wait_mins: mins };
        })
      );
      res.json(enriched);
    }
  );
});
// MCP GET endpoint for SSE
app.get('/mcp', (req, res) => {
  res.json({
    name: 'smart-queue-health',
    version: '1.0.0',
    description: 'Smart Queue Management for Government Hospitals'
  });
});
app.post('/api/scan', (req, res) => {
  const {
    token   = 'A' + Date.now().toString().slice(-3),
    patient = 'Patient',
    counter = 1,
    priority = 'normal'
  } = req.body;

  const weight = PRIORITY_WEIGHT[priority] || 1;

  db.run(
    `INSERT INTO queue (token, patient, counter, status, priority, priority_weight, synced)
     VALUES (?, ?, ?, 'waiting', ?, ?, 0)`,
    [token.toUpperCase(), patient, counter, priority, weight],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      console.log(`✅ Token ${token} queued [${priority}] (ID: ${this.lastID})`);
      io.emit('queueUpdate');
      res.json({ success: true, token, id: this.lastID, priority });
    }
  );
});

app.post('/api/next', (req, res) => {
  db.get(
    `SELECT * FROM queue 
     WHERE status = 'waiting' 
     ORDER BY priority_weight DESC, id ASC 
     LIMIT 1`,
    (err, row) => {
      if (!row) return res.json({ success: false, message: 'No patients waiting' });
      db.run(
        `UPDATE queue SET status = 'called', called_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [row.id],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });
          console.log(`📢 Calling ${row.token} [${row.priority}] → Counter ${row.counter}`);
          io.emit('queueUpdate', { called: row.token, priority: row.priority });
          res.json({ success: true, token: row.token, priority: row.priority });
        }
      );
    }
  );
});

app.post('/api/serve', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });

  db.get(`SELECT * FROM queue WHERE id = ?`, [id], (err, row) => {
    if (!row) return res.status(404).json({ error: 'Not found' });
    db.run(
      `UPDATE queue SET status = 'served', served_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [id],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        if (row.called_at) {
          const calledMs  = new Date(row.called_at).getTime();
          const servedMs  = Date.now();
          const secs      = Math.round((servedMs - calledMs) / 1000);
          if (secs > 0 && secs < 3600) {
            db.run(
              `INSERT INTO service_log (priority, service_secs) VALUES (?, ?)`,
              [row.priority, secs]
            );
          }
        }
        io.emit('queueUpdate');
        res.json({ success: true, token: row.token });
      }
    );
  });
});

app.get('/api/predict', (req, res) => {
  const priority = req.query.priority || 'normal';
  db.get(
    `SELECT COUNT(*) as count FROM queue 
     WHERE status = 'waiting' AND priority_weight <= ?`,
    [PRIORITY_WEIGHT[priority] || 1],
    async (err, row) => {
      const position = (row?.count || 0) + 1;
      const mins = await estimateWaitTime(position, priority);
      res.json({ priority, position, estimated_wait_mins: mins });
    }
  );
});

app.get('/api/status', (req, res) => {
  db.get(
    `SELECT COUNT(*) as total, 
            SUM(CASE WHEN synced=0 THEN 1 ELSE 0 END) as pending,
            SUM(CASE WHEN status='waiting' THEN 1 ELSE 0 END) as waiting
     FROM queue`,
    (err, row) => {
      res.json({
        online: onlineStatus.mysql,
        lastSync: onlineStatus.lastSync,
        hardware: arduinoPort ? '🔌 Arduino Connected' : '💻 Software-Only Mode',
        sqlite: {
          total: row?.total || 0,
          waiting: row?.waiting || 0,
          pendingSync: row?.pending || 0
        },
        mysql: onlineStatus.mysql ? '🟢 LIVE' : '🔴 OFFLINE'
      });
    }
  );
});

app.get('/api/health', (req, res) => {
  db.get(
    `SELECT COUNT(*) as total, SUM(CASE WHEN synced=0 THEN 1 ELSE 0 END) as pending FROM queue`,
    (err, row) => {
      res.json({
        status: 'GOVT Smart Queue LIVE',
        sqlite_status: '✅ LIVE',
        mysql_status: onlineStatus.mysql ? '🟢 ACTIVE' : '🔴 OFFLINE',
        hardware_status: arduinoPort ? '🔌 Arduino' : '💻 Software Mode',
        total_records: row?.total || 0,
        pending_sync: row?.pending || 0,
        timestamp: new Date().toISOString()
      });
    }
  );
});

// ──────────────────────────────────────────────
// 🤖 MCP ENDPOINT
// ──────────────────────────────────────────────
app.get('/mcp', (req, res) => {
  res.json({
    name: 'smart-queue-health',
    version: '1.0.0',
    description: 'Smart Queue Management for Government Hospitals'
  });
});

app.post('/mcp', express.json(), (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { method, params, id } = req.body;

  if (method === 'initialize') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'smart-queue-health', version: '1.0.0' }
      }
    });
  }

  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'get_queue_status',
            description: 'Get current queue status and waiting patients',
            inputSchema: { type: 'object', properties: {} }
          },
          {
            name: 'add_patient',
            description: 'Add a patient to the hospital queue',
            inputSchema: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                priority: { type: 'string', enum: ['emergency', 'senior', 'normal'] }
              }
            }
          },
          {
            name: 'call_next_patient',
            description: 'Call the next patient in queue',
            inputSchema: { type: 'object', properties: {} }
          },
          {
            name: 'predict_wait_time',
            description: 'Predict wait time for a patient',
            inputSchema: {
              type: 'object',
              properties: {
                priority: { type: 'string' }
              }
            }
          }
        ]
      }
    });
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};

    if (toolName === 'get_queue_status') {
      return db.all(
        `SELECT token, patient, priority, status FROM queue WHERE status = 'waiting' ORDER BY priority_weight DESC, id ASC`,
        [],
        (err, rows) => {
          const text = rows.length === 0
            ? 'No patients waiting.'
            : `${rows.length} patient(s) waiting:\n` + rows.map(r => `- ${r.patient} [${r.priority}] Token: ${r.token}`).join('\n');
          res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
        }
      );
    }

    if (toolName === 'add_patient') {
      const { name = 'Patient', priority = 'normal' } = toolArgs;
      const token = 'A' + Date.now().toString().slice(-3);
      const weight = PRIORITY_WEIGHT[priority] || 1;
      return db.run(
        `INSERT INTO queue (token, patient, counter, status, priority, priority_weight, synced) VALUES (?, ?, 1, 'waiting', ?, ?, 0)`,
        [token, name, priority, weight],
        function(err) {
          io.emit('queueUpdate');
          res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Patient ${name} added. Token: ${token}, Priority: ${priority}` }] } });
        }
      );
    }

    if (toolName === 'call_next_patient') {
      return db.get(
        `SELECT * FROM queue WHERE status = 'waiting' ORDER BY priority_weight DESC, id ASC LIMIT 1`,
        [],
        (err, row) => {
          if (!row) return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'No patients waiting.' }] } });
          db.run(`UPDATE queue SET status = 'called', called_at = CURRENT_TIMESTAMP WHERE id = ?`, [row.id]);
          io.emit('queueUpdate');
          res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Calling: ${row.patient}, Token: ${row.token}, Priority: ${row.priority}` }] } });
        }
      );
    }

    if (toolName === 'predict_wait_time') {
      const priority = toolArgs.priority || 'normal';
      return db.get(
        `SELECT COUNT(*) as count FROM queue WHERE status = 'waiting'`,
        [],
        async (err, row) => {
          const mins = await estimateWaitTime((row?.count || 0) + 1, priority);
          res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Estimated wait: ${mins} minutes for ${priority} priority` }] } });
        }
      );
    }
  }

  res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ok' }] } });
});

// ──────────────────────────────────────────────
// 🔄 MySQL Auto-Sync (every 30s)
// ──────────────────────────────────────────────
async function syncToMySQL() {
  if (!onlineStatus.mysql || !mysqlPool) { onlineStatus.mysql = false; return; }

  db.get(`SELECT COUNT(*) as pending FROM queue WHERE synced = 0`, async (err, row) => {
    onlineStatus.pending = row?.pending || 0;
    if (onlineStatus.pending === 0) return;

    const rows = await new Promise(resolve =>
      db.all(`SELECT * FROM queue WHERE synced = 0 LIMIT 10`, (e, r) => resolve(r))
    );

    for (const row of rows) {
      try {
        await mysqlPool.execute(
          `INSERT IGNORE INTO queue 
           (token, patient, counter, status, priority, priority_weight, registered_at, synced, device_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
          [
            row.token, row.patient, row.counter || 1,
            row.status, row.priority || 'normal',
            row.priority_weight || 1,
            row.registered_at || new Date().toISOString().slice(0, 19).replace('T', ' '),
            row.device_id || 'GOVT-OPD'
          ]
        );
        await new Promise(resolve =>
          db.run(`UPDATE queue SET synced = 1 WHERE id = ?`, [row.id], resolve)
        );
        console.log(`✅ Synced: ${row.token}`);
      } catch (e) {
        console.error(`❌ Sync failed ${row.token}:`, e.message);
      }
    }

    onlineStatus.lastSync = new Date().toISOString();
  });
}

setInterval(syncToMySQL, 30000);

// ──────────────────────────────────────────────
// 🚀 START
// ──────────────────────────────────────────────
async function start() {
  await initMySQL();
  server.listen(3000, () => {
    console.log('\n🚀 GOVT SMART QUEUE SYSTEM LIVE!');
    console.log('🌐 Web    : http://localhost:3000');
    console.log('📊 Status : http://localhost:3000/api/status');
    console.log('📱 Queue  : http://localhost:3000/api/queue');
    console.log('🔧 Health : http://localhost:3000/api/health');
    console.log('🔮 Predict: http://localhost:3000/api/predict?priority=normal');
    console.log('🤖 MCP    : http://localhost:3000/mcp');
    console.log('💻 Hardware: ' + (arduinoPort ? 'Arduino Connected' : 'Software-Only Mode'));
  });
}

start();
