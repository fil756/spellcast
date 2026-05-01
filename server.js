const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || './data';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'spellcast.db'));

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS word_lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_label TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS words (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id INTEGER NOT NULL,
    word TEXT NOT NULL,
    miss_count INTEGER DEFAULT 0,
    FOREIGN KEY (list_id) REFERENCES word_lists(id)
  );

  CREATE TABLE IF NOT EXISTS test_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id INTEGER NOT NULL,
    score INTEGER NOT NULL,
    total INTEGER NOT NULL,
    taken_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    details TEXT,
    FOREIGN KEY (list_id) REFERENCES word_lists(id)
  );
`);

// Default settings
const defaults = {
  child_name: 'Spellcaster',
  admin_pin: '1234',
  app_theme: 'purple'
};
for (const [key, value] of Object.entries(defaults)) {
  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run(key, value);
}

const getSetting = (key) => db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key)?.value;
const setSetting = (key, value) => db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, value);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'spellcast-magic-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 86400000 }
}));

// Auth middleware
const requireAdmin = (req, res, next) => {
  if (req.session.isAdmin) return next();
  res.redirect('/admin/login');
};

// ─── ADMIN ROUTES ───────────────────────────────────────────────

app.get('/admin/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

app.post('/admin/login', (req, res) => {
  const { pin } = req.body;
  if (pin === getSetting('admin_pin')) {
    req.session.isAdmin = true;
    res.redirect('/admin');
  } else {
    res.redirect('/admin/login?error=1');
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// API: Get settings
app.get('/api/settings', requireAdmin, (req, res) => {
  res.json({
    child_name: getSetting('child_name'),
    admin_pin: getSetting('admin_pin'),
    app_theme: getSetting('app_theme')
  });
});

// API: Save settings
app.post('/api/settings', requireAdmin, (req, res) => {
  const { child_name, admin_pin, app_theme } = req.body;
  if (child_name) setSetting('child_name', child_name);
  if (admin_pin) setSetting('admin_pin', admin_pin);
  if (app_theme) setSetting('app_theme', app_theme);
  res.json({ success: true });
});

// API: Create new word list
app.post('/api/lists', requireAdmin, (req, res) => {
  const { week_label, words } = req.body;
  if (!week_label || !words || words.length === 0) {
    return res.status(400).json({ error: 'Missing week_label or words' });
  }
  const list = db.prepare(`INSERT INTO word_lists (week_label) VALUES (?)`).run(week_label);
  const insertWord = db.prepare(`INSERT INTO words (list_id, word) VALUES (?, ?)`);
  for (const word of words.slice(0, 20)) {
    insertWord.run(list.lastInsertRowid, word.trim().toLowerCase());
  }
  res.json({ success: true, list_id: list.lastInsertRowid });
});

// API: Get all lists
app.get('/api/lists', requireAdmin, (req, res) => {
  const lists = db.prepare(`SELECT * FROM word_lists ORDER BY created_at DESC`).all();
  for (const list of lists) {
    list.words = db.prepare(`SELECT * FROM words WHERE list_id = ?`).all(list.id);
    list.results = db.prepare(`SELECT * FROM test_results WHERE list_id = ? ORDER BY taken_at DESC`).all(list.id);
  }
  res.json(lists);
});

// API: Get active list (most recent)
app.get('/api/active-list', (req, res) => {
  const list = db.prepare(`SELECT * FROM word_lists ORDER BY created_at DESC LIMIT 1`).get();
  if (!list) return res.json(null);
  list.words = db.prepare(`SELECT * FROM words WHERE list_id = ? ORDER BY id`).all(list.id);
  list.child_name = getSetting('child_name');
  list.app_theme = getSetting('app_theme');
  res.json(list);
});

// API: Submit test result
app.post('/api/results', (req, res) => {
  const { list_id, answers } = req.body;
  // answers: [{ word_id, word, given, correct }]
  const total = answers.length;
  const correct = answers.filter(a => a.correct).length;
  const score = Math.round((correct / total) * 100);

  // Update miss counts
  const updateMiss = db.prepare(`UPDATE words SET miss_count = miss_count + 1 WHERE id = ?`);
  for (const a of answers) {
    if (!a.correct) updateMiss.run(a.word_id);
  }

  db.prepare(`INSERT INTO test_results (list_id, score, total, details) VALUES (?, ?, ?, ?)`)
    .run(list_id, score, total, JSON.stringify(answers));

  res.json({ score, correct, total });
});

// API: Get test results for admin
app.get('/api/results', requireAdmin, (req, res) => {
  const results = db.prepare(`
    SELECT r.*, w.week_label FROM test_results r
    JOIN word_lists w ON r.list_id = w.id
    ORDER BY r.taken_at DESC LIMIT 50
  `).all();
  res.json(results);
});

// Child pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/practice', (req, res) => res.sendFile(path.join(__dirname, 'public', 'practice.html')));
app.get('/test', (req, res) => res.sendFile(path.join(__dirname, 'public', 'test.html')));

app.listen(PORT, () => console.log(`SpellCast running on port ${PORT}`));
