const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || './data';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'spellcast.db'));

// Audio cache directory
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

// ─── TTS HELPER ──────────────────────────────────────────────────
async function generateAudio(word, listId) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null; // Fall back to browser TTS

  const safeWord = word.replace(/[^a-zA-Z0-9\-']/g, '_');
  const filePath = path.join(AUDIO_DIR, `${listId}_${safeWord}.mp3`);
  if (fs.existsSync(filePath)) return filePath; // Already cached

  return new Promise((resolve) => {
    const body = JSON.stringify({ model: 'tts-1', input: word, voice: 'nova', speed: 0.85 });
    const req = https.request({
      hostname: 'api.openai.com', path: '/v1/audio/speech',
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      if (res.statusCode !== 200) { resolve(null); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        fs.writeFileSync(filePath, Buffer.concat(chunks));
        resolve(filePath);
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

async function generateAudioForList(listId, words) {
  // Fire and forget — generate in background
  for (const word of words) {
    generateAudio(word, listId).catch(() => {});
  }
}

// ─── SENDGRID EMAIL ──────────────────────────────────────────────
const SENDGRID_FROM = { email: 'phil@atelierdp.com', name: 'Phil Parrish' };

async function sendEmail({ to, subject, html, text }) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) { console.error('SENDGRID_API_KEY not set'); return false; }

  const body = JSON.stringify({
    personalizations: [{ to: [{ email: to }] }],
    from: SENDGRID_FROM,
    subject,
    content: [
      { type: 'text/plain', value: text || subject },
      { type: 'text/html', value: html }
    ]
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.sendgrid.com',
      path: '/v3/mail/send',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 300);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.setTimeout(10000, () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

function getMagicLinkEmail(name, link, role) {
  const roleLabel = role === 'teacher' ? 'Teacher Portal' : 'Parent Dashboard';
  return {
    html: `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#1a0533;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#1a0533;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#2d1065;border-radius:16px;overflow:hidden;max-width:600px;width:100%;">
        <tr><td style="background:linear-gradient(135deg,#7c3aed,#b06fff);padding:32px;text-align:center;">
          <div style="font-size:48px;margin-bottom:8px;">🪄</div>
          <h1 style="color:#fff;margin:0;font-size:28px;font-weight:800;">SpellCast</h1>
          <p style="color:rgba(255,255,255,0.8);margin:8px 0 0;font-size:14px;">Magic Spelling Practice</p>
        </td></tr>
        <tr><td style="padding:40px 32px;">
          <h2 style="color:#fff;margin:0 0 8px;font-size:22px;">Hi ${name}! 👋</h2>
          <p style="color:rgba(255,255,255,0.75);margin:0 0 32px;font-size:16px;line-height:1.6;">
            Click the magic button below to sign in to your <strong style="color:#b06fff;">${roleLabel}</strong>.<br>
            This link expires in <strong style="color:#b06fff;">15 minutes</strong>.
          </p>
          <div style="text-align:center;margin:32px 0;">
            <a href="${link}" style="display:inline-block;background:linear-gradient(135deg,#7c3aed,#b06fff);color:#fff;text-decoration:none;padding:16px 40px;border-radius:50px;font-size:18px;font-weight:700;letter-spacing:0.5px;">
              ✨ Sign In to SpellCast
            </a>
          </div>
          <p style="color:rgba(255,255,255,0.4);font-size:13px;text-align:center;margin:24px 0 0;">
            If you didn't request this, you can safely ignore it.<br>
            Link: <a href="${link}" style="color:#b06fff;">${link}</a>
          </p>
        </td></tr>
        <tr><td style="padding:20px 32px;border-top:1px solid rgba(255,255,255,0.1);text-align:center;">
          <p style="color:rgba(255,255,255,0.3);font-size:12px;margin:0;">SpellCast · Atelier Design & Print · McPherson, KS</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
    text: `Hi ${name}! Sign in to your SpellCast ${roleLabel}: ${link}\n\nThis link expires in 15 minutes. If you didn't request this, ignore this email.`
  };
}

function createMagicToken(email, role) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  db.prepare(`DELETE FROM magic_tokens WHERE email=? AND role=?`).run(email, role); // revoke old
  db.prepare(`INSERT INTO magic_tokens (token,email,role,expires_at) VALUES (?,?,?,?)`).run(token, email, role, expires);
  return token;
}

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

  CREATE TABLE IF NOT EXISTS magic_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'parent',
    used INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL
  );
`);

// Safe migrations
try { db.exec(`ALTER TABLE word_lists ADD COLUMN child_id INTEGER REFERENCES children(id)`); } catch(e) {}
try { db.exec(`ALTER TABLE word_lists ADD COLUMN teacher_id INTEGER REFERENCES teachers(id)`); } catch(e) {}
try { db.exec(`ALTER TABLE test_results ADD COLUMN child_id INTEGER REFERENCES children(id)`); } catch(e) {}
try { db.exec(`ALTER TABLE test_results ADD COLUMN correct INTEGER DEFAULT 0`); } catch(e) {}

// Backfill child_id on old word_lists rows that are missing it
db.exec(`
  UPDATE word_lists SET child_id = (
    SELECT child_id FROM test_results WHERE list_id = word_lists.id LIMIT 1
  ) WHERE child_id IS NULL
`);
// If still null, link to the first child of the first parent (legacy single-child setup)
const firstChild = db.prepare(`SELECT id FROM children LIMIT 1`).get();
if (firstChild) {
  db.exec(`UPDATE word_lists SET child_id = ${firstChild.id} WHERE child_id IS NULL`);
  db.exec(`UPDATE test_results SET child_id = (
    SELECT child_id FROM word_lists WHERE id = test_results.list_id
  ) WHERE child_id IS NULL`);
}

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
  if (!req.session.parentId) return res.redirect('/login');
  // If parentId set but no childId (e.g. magic link auth), send to child selection
  if (!req.session.childId) return res.redirect(`/select-child?parentId=${req.session.parentId}`);
  next();
};

const requireTeacher = (req, res, next) => {
  if (req.session.teacherId) return next();
  res.redirect('/teacher/login');
};

// ─── AUTH ROUTES ─────────────────────────────────────────────────
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/select-child', (req, res) => res.sendFile(path.join(__dirname, 'public', 'select-child.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/admin/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-login.html')));

// ─── PUBLIC API (NO AUTH) ────────────────────────────────────────
// Get all parents (public list for login dropdown)
app.get('/api/public/parents', (req, res) => {
  const parents = db.prepare(`SELECT id,name FROM parents ORDER BY name ASC`).all();
  res.json(parents);
});

// Verify parent PIN
app.post('/api/public/verify-pin', (req, res) => {
  const { parentId, pin } = req.body;
  if (!parentId || !pin) return res.status(400).json({ error: 'Missing parent or PIN' });

  const parent = db.prepare(`SELECT id FROM parents WHERE id=? AND pin=?`).get(parentId, pin);
  if (!parent) return res.status(401).json({ error: 'Invalid PIN' });

  res.json({ parentId: parent.id });
});

// Get children for a parent (after PIN verify)
app.get('/api/public/parent-children', (req, res) => {
  const parentId = req.query.parentId;
  if (!parentId) return res.status(400).json({ error: 'Missing parentId' });

  const children = db.prepare(`SELECT id,name,avatar,theme FROM children WHERE parent_id=? ORDER BY name ASC`).all(parentId);
  res.json(children);
});

// Select a child (stores in session)
app.post('/api/public/select-child', (req, res) => {
  const { parentId, childId } = req.body;
  if (!parentId || !childId) return res.status(400).json({ error: 'Missing parentId or childId' });

  // Verify child belongs to parent
  const child = db.prepare(`SELECT id FROM children WHERE id=? AND parent_id=?`).get(childId, parentId);
  if (!child) return res.status(401).json({ error: 'Child does not belong to parent' });

  req.session.parentId = parentId;
  req.session.childId = childId;
  res.json({ success: true });
});

// Registration — creates parent account + sends magic link
app.post('/api/auth/register', async (req, res) => {
  const { name, email, role } = req.body;
  if (!name || !email) return res.json({ success: false, error: 'Name and email required' });
  const r = (role === 'teacher') ? 'teacher' : 'parent';

  if (r === 'parent') {
    let parent = db.prepare(`SELECT * FROM parents WHERE email=?`).get(email);
    if (!parent) {
      const ins = db.prepare(`INSERT INTO parents (name,email,pin) VALUES (?,?,'1234')`).run(name, email);
      // Create default child
      db.prepare(`INSERT INTO children (parent_id,name,avatar,theme) VALUES (?,'Spellcaster','🧙','purple')`).run(ins.lastInsertRowid);
      parent = db.prepare(`SELECT * FROM parents WHERE id=?`).get(ins.lastInsertRowid);
    }
    const token = createMagicToken(email, 'parent');
    const BASE = process.env.BASE_URL || `https://spellcast-production.up.railway.app`;
    const link = `${BASE}/api/auth/verify/${token}`;
    const { html, text } = getMagicLinkEmail(parent.name, link, 'parent');
    const sent = await sendEmail({ to: email, subject: '🪄 Your SpellCast Sign-In Link', html, text });
    res.json({ success: true, sent, message: sent ? 'Check your email for a magic sign-in link!' : 'Account created but email failed — contact support.' });
  } else {
    let teacher = db.prepare(`SELECT * FROM teachers WHERE email=?`).get(email);
    if (!teacher) {
      const code = (name.toUpperCase().replace(/[^A-Z]/g,'').substring(0,6) + Math.floor(100+Math.random()*900));
      db.prepare(`INSERT INTO teachers (name,email,class_name,class_code,pin) VALUES (?,?,?,?,'0000')`).run(name, email, `${name}'s Class`, code);
      teacher = db.prepare(`SELECT * FROM teachers WHERE email=?`).get(email);
    }
    const token = createMagicToken(email, 'teacher');
    const BASE = process.env.BASE_URL || `https://spellcast-production.up.railway.app`;
    const link = `${BASE}/api/auth/verify/${token}`;
    const { html, text } = getMagicLinkEmail(teacher.name, link, 'teacher');
    const sent = await sendEmail({ to: email, subject: '🪄 Your SpellCast Teacher Sign-In Link', html, text });
    res.json({ success: true, sent });
  }
});

// Request magic link (for existing users who forgot PIN)
app.post('/api/auth/magic-link', async (req, res) => {
  const { email, role } = req.body;
  if (!email) return res.json({ success: false, error: 'Email required' });
  const r = (role === 'teacher') ? 'teacher' : 'parent';
  const user = r === 'parent'
    ? db.prepare(`SELECT * FROM parents WHERE email=?`).get(email)
    : db.prepare(`SELECT * FROM teachers WHERE email=?`).get(email);
  // Always respond the same to prevent email enumeration
  if (user) {
    const token = createMagicToken(email, r);
    const BASE = process.env.BASE_URL || `https://spellcast-production.up.railway.app`;
    const link = `${BASE}/api/auth/verify/${token}`;
    const { html, text } = getMagicLinkEmail(user.name, link, r);
    await sendEmail({ to: email, subject: '🪄 Your SpellCast Sign-In Link', html, text });
  }
  res.json({ success: true, message: "If that email is registered, you'll get a link shortly." });
});

// Verify magic link token
app.get('/api/auth/verify/:token', (req, res) => {
  const now = new Date().toISOString();
  const record = db.prepare(`SELECT * FROM magic_tokens WHERE token=? AND used=0 AND expires_at > ?`).get(req.params.token, now);
  if (!record) return res.redirect('/admin/login?error=expired');

  db.prepare(`UPDATE magic_tokens SET used=1 WHERE id=?`).run(record.id);

  if (record.role === 'parent') {
    const parent = db.prepare(`SELECT * FROM parents WHERE email=?`).get(record.email);
    if (!parent) return res.redirect('/admin/login?error=notfound');
    req.session.parentId = parent.id;
    req.session.magicAuth = true;
    res.redirect(`/select-child?parentId=${parent.id}&magic=1`);
  } else {
    const teacher = db.prepare(`SELECT * FROM teachers WHERE email=?`).get(record.email);
    if (!teacher) return res.redirect('/teacher/login?error=notfound');
    req.session.teacherId = teacher.id;
    req.session.magicAuth = true;
    res.redirect('/teacher?magic=1');
  }
});

// Legacy admin login — redirect to new flow
app.post('/admin/login', (req, res) => {
  res.redirect('/login');
});

app.get('/admin/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });
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
  const child = db.prepare(`SELECT * FROM children WHERE id=? AND parent_id=?`).get(req.params.id, req.session.parentId);
  if (!child) return res.status(403).json({ error: 'Not found' });
  // Cascade delete in order: test_results → words → word_lists → class_subscriptions → child
  const lists = db.prepare(`SELECT id FROM word_lists WHERE child_id=?`).all(child.id);
  for (const l of lists) {
    db.prepare(`DELETE FROM words WHERE list_id=?`).run(l.id);
    db.prepare(`DELETE FROM test_results WHERE list_id=?`).run(l.id);
  }
  db.prepare(`DELETE FROM word_lists WHERE child_id=?`).run(child.id);
  db.prepare(`DELETE FROM class_subscriptions WHERE child_id=?`).run(child.id);
  db.prepare(`DELETE FROM children WHERE id=?`).run(child.id);
  res.json({ success: true });
});

app.post('/api/admin/lists', requireAdmin, (req, res) => {
  const { child_id, week_label, words } = req.body;
  const child = db.prepare(`SELECT * FROM children WHERE id=? AND parent_id=?`).get(child_id, req.session.parentId);
  if (!child) return res.status(403).json({ error: 'Not your child' });
  const list = db.prepare(`INSERT INTO word_lists (child_id,week_label) VALUES (?,?)`).run(child_id, week_label);
  for (const w of words.slice(0,20)) {
    db.prepare(`INSERT INTO words (list_id,word) VALUES (?,?)`).run(list.lastInsertRowid, w.trim());
  }
  // Pre-generate TTS audio in background
  generateAudioForList(list.lastInsertRowid, words.slice(0,20).map(w => w.trim()));
  res.json({ success: true, list_id: list.lastInsertRowid });
});

// Update existing list words
app.put('/api/admin/lists/:list_id', requireAdmin, (req, res) => {
  const { words, week_label } = req.body;
  const list = db.prepare(`
    SELECT wl.* FROM word_lists wl JOIN children c ON wl.child_id=c.id
    WHERE wl.id=? AND c.parent_id=?`).get(req.params.list_id, req.session.parentId);
  if (!list) return res.status(403).json({ error: 'Not found' });
  db.prepare(`DELETE FROM words WHERE list_id=?`).run(list.id);
  for (const w of (words||[]).slice(0,20)) {
    db.prepare(`INSERT INTO words (list_id,word) VALUES (?,?)`).run(list.id, w.trim());
  }
  if (week_label) db.prepare(`UPDATE word_lists SET week_label=? WHERE id=?`).run(week_label, list.id);
  // Pre-generate TTS audio in background
  generateAudioForList(list.id, (words||[]).slice(0,20).map(w => w.trim()));
  res.json({ success: true });
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
    JOIN word_lists wl2 ON r.list_id = wl2.id JOIN children c ON wl2.child_id = c.id
    JOIN word_lists w ON r.list_id = w.id
    WHERE c.parent_id = ?
    ORDER BY r.taken_at DESC LIMIT 100
  `).all(req.session.parentId);
  res.json(results);
});

// ─── TEACHER ROUTES ─────────────────────────────────────────────
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
           (SELECT COUNT(*) FROM test_results r JOIN word_lists wl ON r.list_id=wl.id WHERE wl.child_id=c.id) as test_count,
           (SELECT r.score FROM test_results r JOIN word_lists wl ON r.list_id=wl.id WHERE wl.child_id=c.id ORDER BY r.taken_at DESC LIMIT 1) as last_score
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
      db.prepare(`INSERT INTO words (list_id, word) VALUES (?,?)`).run(list.lastInsertRowid, w.trim());
    }
    generateAudioForList(list.lastInsertRowid, words.slice(0,20).map(w => w.trim()));
    created++;
  }
  res.json({ success: true, students_updated: created });
});

// Teacher: class grade report
app.get('/api/teacher/grades', requireTeacher, (req, res) => {
  const results = db.prepare(`
    SELECT r.*, c.name as child_name, c.avatar, wl.week_label, wl.teacher_id
    FROM test_results r
    JOIN word_lists wl ON r.list_id = wl.id
    JOIN children c ON wl.child_id = c.id
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

// ─── SESSION MANAGEMENT ────────────────────────────────────────
// Get current session child info
app.get('/api/session-child', (req, res) => {
  if (!req.session.parentId || !req.session.childId) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  const child = db.prepare(`SELECT * FROM children WHERE id=? AND parent_id=?`).get(req.session.childId, req.session.parentId);
  if (!child) return res.status(401).json({ error: 'Invalid session' });
  res.json({ childId: child.id, child });
});

// Get parent's children (authenticated endpoint)
app.get('/api/parent-children', (req, res) => {
  if (!req.session.parentId) return res.status(401).json({ error: 'Not logged in' });
  const children = db.prepare(`SELECT id,name,avatar,theme FROM children WHERE parent_id=? ORDER BY name ASC`).all(req.session.parentId);
  res.json(children);
});

// Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    res.json({ success: true });
  });
});

// ─── AUDIO ENDPOINT ─────────────────────────────────────────────
app.get('/api/audio/:list_id/:word', (req, res) => {
  const rawWord = req.params.word;
  if (!rawWord || rawWord === 'undefined' || rawWord === 'null') return res.status(400).json({ error: 'Invalid word' });
  const safeWord = rawWord.replace(/[^a-zA-Z0-9\-']/g, '_');
  const filePath = path.join(AUDIO_DIR, `${req.params.list_id}_${safeWord}.mp3`);
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(filePath);
  }
  // Not yet generated — generate now and return
  generateAudio(req.params.word, req.params.list_id).then(fp => {
    if (fp) {
      res.setHeader('Content-Type', 'audio/mpeg');
      res.sendFile(fp);
    } else {
      res.status(404).json({ error: 'Audio not available' });
    }
  });
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
