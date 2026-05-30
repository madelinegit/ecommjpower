const express = require('express');
const multer  = require('multer');
const { Pool } = require('pg');
const jwt     = require('jsonwebtoken');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Database ───────────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id           SERIAL PRIMARY KEY,
      name         TEXT NOT NULL,
      text         TEXT NOT NULL,
      image_url    TEXT,
      status       TEXT DEFAULT 'pending',
      submitted_at TIMESTAMPTZ DEFAULT NOW(),
      approved_at  TIMESTAMPTZ
    )
  `);
}
initDb().catch(err => console.error('DB init error:', err));

// ── File uploads ───────────────────────────────────────────────────
const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename:    (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Images only'));
    cb(null, true);
  }
});

// ── Middleware ─────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(path.join(__dirname)));

// ── Auth middleware ────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret');
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── Public API ─────────────────────────────────────────────────────

// Get approved reviews
app.get('/api/reviews', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, text, image_url, approved_at
       FROM reviews WHERE status = 'approved'
       ORDER BY approved_at DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load reviews' });
  }
});

// Submit a review
app.post('/api/reviews', upload.single('photo'), async (req, res) => {
  const { name, text } = req.body;
  if (!name?.trim() || !text?.trim()) {
    return res.status(400).json({ error: 'Name and review text are required' });
  }
  try {
    const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;
    await pool.query(
      `INSERT INTO reviews (name, text, image_url) VALUES ($1, $2, $3)`,
      [name.trim(), text.trim(), imageUrl]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to submit review' });
  }
});

// ── Admin API ──────────────────────────────────────────────────────

// Login
app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body;
  if (
    email    !== process.env.ADMIN_EMAIL    ||
    password !== process.env.ADMIN_PASSWORD
  ) {
    return res.status(401).json({ error: 'Incorrect email or password' });
  }
  const token = jwt.sign(
    { email },
    process.env.JWT_SECRET || 'dev-secret',
    { expiresIn: '8h' }
  );
  res.json({ token });
});

// Get all reviews for admin
app.get('/api/admin/reviews', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM reviews ORDER BY
        CASE status WHEN 'pending' THEN 0 ELSE 1 END,
        submitted_at DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load reviews' });
  }
});

// Edit review text / name
app.put('/api/admin/reviews/:id', requireAuth, async (req, res) => {
  const { name, text } = req.body;
  try {
    await pool.query(
      `UPDATE reviews SET
        name = COALESCE(NULLIF($1,''), name),
        text = COALESCE(NULLIF($2,''), text)
       WHERE id = $3`,
      [name, text, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update review' });
  }
});

// Approve review
app.patch('/api/admin/reviews/:id/approve', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE reviews SET status = 'approved', approved_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to approve review' });
  }
});

// Delete review
app.delete('/api/admin/reviews/:id', requireAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM reviews WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete review' });
  }
});

// Replace image on a review
app.post('/api/admin/reviews/:id/image', requireAuth, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const imageUrl = `/uploads/${req.file.filename}`;
    await pool.query(`UPDATE reviews SET image_url = $1 WHERE id = $2`, [imageUrl, req.params.id]);
    res.json({ ok: true, imageUrl });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update image' });
  }
});

// Remove image from a review
app.delete('/api/admin/reviews/:id/image', requireAuth, async (req, res) => {
  try {
    await pool.query(`UPDATE reviews SET image_url = NULL WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove image' });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
