const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || './data';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'spellcast.db'));

// ─── SCHEMA ─────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS parents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    carrier TEXT,
    pin TEXT NOT NULL DEFAULT '1234',
    notify_email INTEGER DEFAULT 1,
    notify_sms INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS children (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    avatar TEXT DEFAULT '🧙',
    theme TEXT DEFAULT 'purple',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (parent_id) REFERENCES parents(id)
  );

  CREATE TABLE IF NOT EXISTS word_lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    child_id INTEGER NOT NULL,
    week_label TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (child_id) REFERENCES children(id)
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
    child_id INTEGER NOT NULL,
    score INTEGER NOT NULL,
    correct INTEGER NOT NULL,
    total INTEGER NOT NULL,
    details TEXT,
    taken_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (list_id) REFERENCES word_lists(id),
    FOREIGN KEY (child_id) REFERENCES children(id)
  );

  CREATE TABLE IF NOT EXISTS teachers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT,
    class_name TEXT NOT NULL,
    class_code TEXT NOT NULL UNIQUE,
    pin TEXT NOT NULL DEFAULT '0000',
    notify_email INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS class_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    child_id INTEGER NOT NULL,
    teacher_id INTEGER NOT NULL,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(child_id, teacher_id),
    FOREIGN KEY (child_id) REFERENCES children(id),
    FOREIGN KEY (teacher_id) REFERENCES teachers(id)
  );

`);

// Safe migrations
try { db.exec(`ALTER TABLE word_lists ADD COLUMN teacher_id INTEGER REFERENCES teachers(id)`); } catch(e) {}

// Seed a default parent if none exist
const parentCount = db.prepare(`SELECT COUNT(*) as c FROM parents`).get().c;
if (parentCount === 0) {
  const p = db.prepare(`INSERT INTO parents (name, pin) VALUES ('Parent', '1234')`).run();
  db.prepare(`INSERT INTO children (parent_id, name, avatar, theme) VALUES (?, 'Spellcaster', '🧙', 'purple')`).run(p.lastInsertRowid);
}

// ─── EMAIL / SMS HELPER ──────────────────────────────────────────
const CARRIERS = {
  'att':        '@txt.att.net',
  'tmobile':    '@tmomail.net',
  'verizon':    '@vtext.com',
  'sprint':     '@messaging.sprintpcs.com',
  'boost':      '@sms.myboostmobile.com',
  'cricket':    '@sms.cricketwireless.net',
  'metropcs':   '@mymetropcs.com',
  'uscellular': '@email.uscc.net',
};

function getTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: 587,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function sendResultNotification(parent, child, result, words) {
  if (!process.env.SMTP_USER) return; // Email not configured

  const grade = result.score >= 90 ? 'A' : result.score >= 80 ? 'B' : result.score >= 70 ? 'C' : result.score >= 60 ? 'D' : 'F';
  const trophy = result.score === 100 ? '🏆' : result.score >= 90 ? '🥇' : result.score >= 80 ? '🥈' : result.score >= 70 ? '🥉' : '💪';
  const details = JSON.parse(result.details || '[]');

  const missedWords = details.filter(a => !a.correct).map(a => `• ${a.word} (you wrote: "${a.given}")`).join('\n');
  const correctWords = details.filter(a => a.correct).map(a => `✓ ${a.word}`).join('  ');

  const emailBody = `
${trophy} SpellCast Results for ${child.name}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Grade: ${grade}  |  Score: ${result.score}%  |  ${result.correct}/${result.total} correct

${missedWords.length ? `Words to practice:\n${missedWords}\n` : '🌟 Perfect score! Every word correct!\n'}
Words spelled correctly: ${correctWords || 'none'}

Keep practicing at spellcast-production.up.railway.app
  `.trim();

  const htmlBody = `
<div style="font-family:sans-serif;max-width:500px;margin:0 auto;background:#1a0533;color:#fff;border-radius:16px;padding:24px;">
  <h2 style="color:#b06fff;">${trophy} SpellCast Results</h2>
  <p style="font-size:1.1em;">Results for <strong>${child.name}</strong></p>
  <div style="background:rgba(255,255,255,0.1);border-radius:12px;padding:16px;margin:16px 0;text-align:center;">
    <div style="font-size:3em;font-weight:800;">${result.score}%</div>
    <div style="color:#b06fff;font-size:1.3em;">Grade ${grade}</div>
    <div style="opacity:0.7;">${result.correct} out of ${result.total} correct</div>
  </div>
  ${missedWords ? `<p style="color:#f87171;"><strong>Words to practice:</strong><br>${details.filter(a=>!a.correct).map(a=>`${a.word} <small>(wrote: "${a.given}")</small>`).join('<br>')}</p>` : '<p style="color:#4ade80;">🌟 Perfect score! Every word correct!</p>'}
  <p style="opacity:0.5;font-size:0.8em;">Sent by SpellCast 🪄</p>
</div>`;

  const transporter = getTransporter();
  const promises = [];

  if (parent.notify_email && parent.email) {
    promises.push(transporter.sendMail({
      from: `SpellCast 🪄 <${process.env.SMTP_USER}>`,
      to: parent.email,
      subject: `${trophy} ${child.name} scored ${result.score}% on SpellCast!`,
      text: emailBody,
      html: htmlBody,
    }));
  }

  if (parent.notify_sms && parent.phone && parent.carrier && CARRIERS[parent.carrier]) {
    const smsEmail = parent.phone.replace(/\D/g,'') + CARRIERS[parent.carrier];
    const smsBody = `SpellCast: ${child.name} got ${result.score}% (${grade}) - ${result.correct}/${result.total} correct${missedWords ? '. Study: ' + details.filter(a=>!a.correct).map(a=>a.word).join(', ') : ' - Perfect!'}`;
    promises.push(transporter.sendMail({
      from: process.env.SMTP_USER,
      to: smsEmail,
      subject: '',
      text: smsBody,
    }));
  }

  await Promise.allSettled(promises);
}

// ─── MIDDLEWARE ──────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'spellcast-magic-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 86400000 }
}));

const requireAdmin = (req, res, next) => {
  if (req.session.parentId) return next();
  res.redirect('/admin/login');
};

// ─── AUTH ROUTES ─────────────────────────────────────────────────
app.get('/admin/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-login.html')));

app.post('/admin/login', (req, res) => {
  const { pin } = req.body;
  const parent = db.prepare(`SELECT * FROM parents WHERE pin = ?`).get(pin);
  if (parent) {
    req.session.parentId = parent.id;
    res.redirect('/admin');
  } else {
    res.redirect('/admin/login?error=1');
  }
});

app.get('/admin/logout', (req, res) => { req.session.destroy(); res.redirect('/admin/login'); });
app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ─── ADMIN API ───────────────────────────────────────────────────
app.get('/api/admin/me', requireAdmin, (req, res) => {
  const parent = db.prepare(`SELECT id,name,email,phone,carrier,notify_email,notify_sms FROM parents WHERE id=?`).get(req.session.parentId);
  const children = db.prepare(`SELECT * FROM children WHERE parent_id=?`).all(req.session.parentId);
  res.json({ parent, children });
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const { name, pin, email, phone, carrier, notify_email, notify_sms } = req.body;
  db.prepare(`UPDATE parents SET name=COALESCE(?,name), pin=COALESCE(NULLIF(?,pin),pin), email=?, phone=?, carrier=?, notify_email=?, notify_sms=? WHERE id=?`)
    .run(name, pin||null, email||null, phone||null, carrier||null, notify_email?1:0, notify_sms?1:0, req.session.parentId);
  res.json({ success: true });
});

app.post('/api/admin/children', requireAdmin, (req, res) => {
  const { name, avatar, theme } = req.body;
  const child = db.prepare(`INSERT INTO children (parent_id,name,avatar,theme) VALUES (?,?,?,?)`).run(req.session.parentId, name, avatar||'🧙', theme||'purple');
  res.json({ success: true, child_id: child.lastInsertRowid });
});

app.put('/api/admin/children/:id', requireAdmin, (req, res) => {
  const { name, avatar, theme } = req.body;
  db.prepare(`UPDATE children SET name=COALESCE(?,name), avatar=COALESCE(?,avatar), theme=COALESCE(?,theme) WHERE id=? AND parent_id=?`)
    .run(name||null, avatar||null, theme||null, req.params.id, req.session.parentId);
  res.json({ success: true });
});

app.delete('/api/admin/children/:id', requireAdmin, (req, res) => {
  db.prepare(`DELETE FROM children WHERE id=? AND parent_id=?`).run(req.params.id, req.session.parentId);
  res.json({ success: true });
});

app.post('/api/admin/lists', requireAdmin, (req, res) => {
  const { child_id, week_label, words } = req.body;
  const child = db.prepare(`SELECT * FROM children WHERE id=? AND parent_id=?`).get(child_id, req.session.parentId);
  if (!child) return res.status(403).json({ error: 'Not your child' });
  const list = db.prepare(`INSERT INTO word_lists (child_id,week_label) VALUES (?,?)`).run(child_id, week_label);
  for (const w of words.slice(0,20)) {
    db.prepare(`INSERT INTO words (list_id,word) VALUES (?,?)`).run(list.lastInsertRowid, w.trim().toLowerCase());
  }
  res.json({ success: true, list_id: list.lastInsertRowid });
});

app.get('/api/admin/lists/:child_id', requireAdmin, (req, res) => {
  const child = db.prepare(`SELECT * FROM children WHERE id=? AND parent_id=?`).get(req.params.child_id, req.session.parentId);
  if (!child) return res.status(403).json({ error: 'Not your child' });
  const lists = db.prepare(`SELECT * FROM word_lists WHERE child_id=? ORDER BY created_at DESC`).all(req.params.child_id);
  for (const l of lists) {
    l.words = db.prepare(`SELECT * FROM words WHERE list_id=?`).all(l.id);
    l.results = db.prepare(`SELECT * FROM test_results WHERE list_id=? ORDER BY taken_at DESC`).all(l.id);
  }
  res.json(lists);
});

app.get('/api/admin/results', requireAdmin, (req, res) => {
  const results = db.prepare(`
    SELECT r.*, c.name as child_name, w.week_label 
    FROM test_results r
    JOIN children c ON r.child_id = c.id
    JOIN word_lists w ON r.list_id = w.id
    WHERE c.parent_id = ?
    ORDER BY r.taken_at DESC LIMIT 100
  `).all(req.session.parentId);
  res.json(results);
});

// ─── TEACHER ROUTES ─────────────────────────────────────────────
const requireTeacher = (req, res, next) => {
  if (req.session.teacherId) return next();
  res.redirect('/teacher/login');
};

app.get('/teacher/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'teacher-login.html')));
app.get('/teacher/logout', (req, res) => { req.session.destroy(); res.redirect('/teacher/login'); });
app.get('/teacher', requireTeacher, (req, res) => res.sendFile(path.join(__dirname, 'public', 'teacher.html')));

app.post('/teacher/login', (req, res) => {
  const { pin } = req.body;
  const teacher = db.prepare(`SELECT * FROM teachers WHERE pin = ?`).get(pin);
  if (teacher) {
    req.session.teacherId = teacher.id;
    res.redirect('/teacher');
  } else {
    res.redirect('/teacher/login?error=1');
  }
});

// Register a new teacher
app.post('/api/teacher/register', (req, res) => {
  const { name, email, class_name, class_code, pin } = req.body;
  if (!name || !class_name || !class_code || !pin) return res.status(400).json({ error: 'Missing fields' });
  const existing = db.prepare(`SELECT id FROM teachers WHERE class_code = ?`).get(class_code.toUpperCase());
  if (existing) return res.status(409).json({ error: 'Class code already taken' });
  const t = db.prepare(`INSERT INTO teachers (name, email, class_name, class_code, pin) VALUES (?,?,?,?,?)`)
    .run(name, email||null, class_name, class_code.toUpperCase(), pin);
  req.session.teacherId = t.lastInsertRowid;
  res.json({ success: true, class_code: class_code.toUpperCase() });
});

// Teacher: get their profile + students
app.get('/api/teacher/me', requireTeacher, (req, res) => {
  const teacher = db.prepare(`SELECT id,name,email,class_name,class_code,notify_email FROM teachers WHERE id=?`).get(req.session.teacherId);
  const students = db.prepare(`
    SELECT c.*, p.name as parent_name, p.email as parent_email,
           (SELECT COUNT(*) FROM test_results r WHERE r.child_id=c.id) as test_count,
           (SELECT r.score FROM test_results r WHERE r.child_id=c.id ORDER BY r.taken_at DESC LIMIT 1) as last_score
    FROM children c
    JOIN class_subscriptions cs ON cs.child_id = c.id
    JOIN parents p ON p.id = c.parent_id
    WHERE cs.teacher_id = ?
    ORDER BY c.name
  `).all(req.session.teacherId);
  res.json({ teacher, students });
});

// Teacher: save settings
app.post('/api/teacher/settings', requireTeacher, (req, res) => {
  const { name, email, class_name, pin, notify_email } = req.body;
  db.prepare(`UPDATE teachers SET name=COALESCE(?,name), email=?, class_name=COALESCE(?,class_name), pin=COALESCE(NULLIF(?,pin),pin), notify_email=? WHERE id=?`)
    .run(name||null, email||null, class_name||null, pin||null, notify_email?1:0, req.session.teacherId);
  res.json({ success: true });
});

// Teacher: push word list to all subscribed children
app.post('/api/teacher/push-list', requireTeacher, (req, res) => {
  const { week_label, words } = req.body;
  if (!week_label || !words?.length) return res.status(400).json({ error: 'Missing data' });

  const students = db.prepare(`SELECT child_id FROM class_subscriptions WHERE teacher_id=?`).all(req.session.teacherId);
  if (!students.length) return res.status(400).json({ error: 'No students in class' });

  let created = 0;
  for (const { child_id } of students) {
    const list = db.prepare(`INSERT INTO word_lists (child_id, week_label, teacher_id) VALUES (?,?,?)`)
      .run(child_id, week_label, req.session.teacherId);
    for (const w of words.slice(0,20)) {
      db.prepare(`INSERT INTO words (list_id, word) VALUES (?,?)`).run(list.lastInsertRowid, w.trim().toLowerCase());
    }
    created++;
  }
  res.json({ success: true, students_updated: created });
});

// Teacher: class grade report
app.get('/api/teacher/grades', requireTeacher, (req, res) => {
  const results = db.prepare(`
    SELECT r.*, c.name as child_name, c.avatar, w.week_label, w.teacher_id
    FROM test_results r
    JOIN children c ON r.child_id = c.id
    JOIN word_lists w ON r.list_id = w.id
    JOIN class_subscriptions cs ON cs.child_id = c.id
    WHERE cs.teacher_id = ?
    ORDER BY r.taken_at DESC LIMIT 200
  `).all(req.session.teacherId);

  // Most missed words across the class
  const missedWords = db.prepare(`
    SELECT wo.word, SUM(wo.miss_count) as total_misses
    FROM words wo
    JOIN word_lists wl ON wo.list_id = wl.id
    JOIN class_subscriptions cs ON cs.child_id = wl.child_id
    WHERE cs.teacher_id = ? AND wo.miss_count > 0
    GROUP BY wo.word ORDER BY total_misses DESC LIMIT 10
  `).all(req.session.teacherId);

  res.json({ results, missedWords });
});

// Parent: join a class by code
app.post('/api/admin/join-class', requireAdmin, (req, res) => {
  const { class_code, child_id } = req.body;
  const child = db.prepare(`SELECT * FROM children WHERE id=? AND parent_id=?`).get(child_id, req.session.parentId);
  if (!child) return res.status(403).json({ error: 'Not your child' });
  const teacher = db.prepare(`SELECT * FROM teachers WHERE class_code=?`).get(class_code.toUpperCase());
  if (!teacher) return res.status(404).json({ error: 'Class code not found' });
  try {
    db.prepare(`INSERT INTO class_subscriptions (child_id, teacher_id) VALUES (?,?)`).run(child_id, teacher.id);
    res.json({ success: true, class_name: teacher.class_name, teacher_name: teacher.name });
  } catch(e) {
    res.status(409).json({ error: 'Already enrolled in this class' });
  }
});

// Parent: get enrolled classes for a child
app.get('/api/admin/classes/:child_id', requireAdmin, (req, res) => {
  const child = db.prepare(`SELECT * FROM children WHERE id=? AND parent_id=?`).get(req.params.child_id, req.session.parentId);
  if (!child) return res.status(403).json({ error: 'Not your child' });
  const classes = db.prepare(`
    SELECT t.id, t.name as teacher_name, t.class_name, t.class_code
    FROM teachers t JOIN class_subscriptions cs ON cs.teacher_id = t.id
    WHERE cs.child_id = ?
  `).all(req.params.child_id);
  res.json(classes);
});

// Parent: leave a class
app.delete('/api/admin/classes/:teacher_id/:child_id', requireAdmin, (req, res) => {
  const child = db.prepare(`SELECT * FROM children WHERE id=? AND parent_id=?`).get(req.params.child_id, req.session.parentId);
  if (!child) return res.status(403).json({ error: 'Not your child' });
  db.prepare(`DELETE FROM class_subscriptions WHERE teacher_id=? AND child_id=?`).run(req.params.teacher_id, req.params.child_id);
  res.json({ success: true });
});

// ─── PUBLIC API ──────────────────────────────────────────────────
// Get all children (for home selector - no auth needed, safe info only)
app.get('/api/children', (req, res) => {
  const children = db.prepare(`SELECT id, name, avatar, theme FROM children ORDER BY name`).all();
  res.json(children);
});

// Get active list for a child
app.get('/api/child/:id/active-list', (req, res) => {
  const child = db.prepare(`SELECT * FROM children WHERE id=?`).get(req.params.id);
  if (!child) return res.json(null);
  const list = db.prepare(`SELECT * FROM word_lists WHERE child_id=? ORDER BY created_at DESC LIMIT 1`).get(child.id);
  if (!list) return res.json(null);
  list.words = db.prepare(`SELECT * FROM words WHERE list_id=? ORDER BY id`).all(list.id);
  list.child = child;
  res.json(list);
});

// Submit test result
app.post('/api/results', async (req, res) => {
  const { list_id, child_id, answers } = req.body;
  const correct = answers.filter(a => a.correct).length;
  const total = answers.length;
  const score = Math.round((correct / total) * 100);

  const updateMiss = db.prepare(`UPDATE words SET miss_count = miss_count + 1 WHERE id = ?`);
  for (const a of answers) { if (!a.correct) updateMiss.run(a.word_id); }

  const result = db.prepare(`INSERT INTO test_results (list_id,child_id,score,correct,total,details) VALUES (?,?,?,?,?,?)`)
    .run(list_id, child_id, score, correct, total, JSON.stringify(answers));

  // Send notification
  try {
    const child = db.prepare(`SELECT * FROM children WHERE id=?`).get(child_id);
    const parent = db.prepare(`SELECT * FROM parents WHERE id=?`).get(child.parent_id);
    const fullResult = db.prepare(`SELECT * FROM test_results WHERE id=?`).get(result.lastInsertRowid);
    await sendResultNotification(parent, child, fullResult, answers);
  } catch(e) { console.error('Notification failed:', e.message); }

  res.json({ score, correct, total });
});

// ─── PAGES ───────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/practice', (req, res) => res.sendFile(path.join(__dirname, 'public', 'practice.html')));
app.get('/test', (req, res) => res.sendFile(path.join(__dirname, 'public', 'test.html')));

app.listen(PORT, () => console.log(`🪄 SpellCast v2 running on port ${PORT}`));
