const express = require('express');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const path = require('path');

const db = require('./db');
const auth = require('./auth');
const storage = require('./storage');
const gallery = require('./gallery');
const render = require('./render');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.set('trust proxy', 1);   // Railway terminates TLS in front of us

db.init().catch(err => console.error('[db] unexpected init error:', err.message));

// ── Uploads ────────────────────────────────────────────────────────────
// Kept in memory so nothing ever lands on the container filesystem.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: storage.MAX_UPLOAD_BYTES }
});

// ── Middleware ─────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── Admin pages ────────────────────────────────────────────────────────
// Declared before express.static so /admin can never be served as a file.
app.get('/admin/login', (req, res) => {
  if (auth.readSession(req)) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, 'views', 'admin-login.html'));
});

app.get('/admin', auth.requireAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

// ── Public pages ───────────────────────────────────────────────────────
// Loads both categories once so the page renders in a single pass. Any
// database problem falls through to the template's hardcoded content rather
// than showing an error.
async function loadGallery() {
  const empty = { items: { art: [], home: [] }, featured: { art: null, home: null } };
  if (!db.isReady()) return empty;
  try {
    const [art, home] = await Promise.all([
      gallery.listByCategory('art'),
      gallery.listByCategory('home')
    ]);
    const withPhotos = list => list.filter(i => i.images.length);
    const art2 = withPhotos(art);
    const home2 = withPhotos(home);
    return {
      items: { art: art2, home: home2 },
      featured: {
        art: art2.find(i => i.featured) || null,
        home: home2.find(i => i.featured) || null
      }
    };
  } catch (err) {
    console.error('[render] gallery load failed:', err.message);
    return empty;
  }
}

app.get('/', async (req, res, next) => {
  try {
    const data = await loadGallery();
    // Only what the lightbox needs, so the payload stays small.
    const forClient = {};
    ['art', 'home'].forEach(cat => data.items[cat].forEach(i => {
      forClient[i.id] = {
        id: i.id,
        title: i.title,
        description: i.description,
        price: i.price,
        category: i.category,
        images: i.images.map(im => im.url),
        sms: render.smsLink(i),
        href: `/piece/${i.id}/${render.slug(i.title)}`
      };
    }));

    res.render('index', {
      items: data.items,
      featured: data.featured,
      slug: render.slug,
      smsLink: render.smsLink,
      mailLink: render.mailLink,
      piecesJson: JSON.stringify(forClient).replace(/</g, '\\u003c')
    });
  } catch (err) {
    next(err);
  }
});

// Per-item page: its own title and description so individual pieces can rank.
app.get('/piece/:id/:slug?', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.redirect('/');
  if (!db.isReady()) return res.redirect('/');

  try {
    const { rows } = await db.query(`SELECT * FROM gallery_items WHERE id = $1`, [id]);
    if (!rows.length) return res.redirect('/');
    const [piece] = await gallery.attachImages(rows);

    // Keep one canonical URL per piece.
    const wanted = render.slug(piece.title);
    if (req.params.slug !== wanted) return res.redirect(301, `/piece/${piece.id}/${wanted}`);

    res.render('piece', {
      piece,
      metaDescription: render.metaDescriptionFor(piece),
      smsLink: render.smsLink,
      mailLink: render.mailLink
    });
  } catch (err) {
    next(err);
  }
});

// ── Static ─────────────────────────────────────────────────────────────
if (!storage.r2Configured) {
  app.use('/local-uploads', express.static(storage.localDir));
}
app.use(express.static(path.join(__dirname), {
  index: false,   // '/' is rendered above, never served as a flat file
  setHeaders(res, filePath) {
    if (/\.(png|jpe?g|svg|webp)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  }
}));

// ── Auth API ───────────────────────────────────────────────────────────
app.post('/api/admin/login', async (req, res) => {
  if (auth.isLockedOut(req)) {
    return res.status(429).json({
      error: 'Too many tries. Wait 15 minutes and try again.'
    });
  }

  const { email, password } = req.body || {};
  const result = await auth.verifyCredentials(email, password);

  if (!result.ok) {
    auth.recordFailure(req);
    return res.status(401).json({ error: result.message });
  }

  auth.clearFailures(req);
  auth.issueSession(res, result.email);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  auth.clearSession(res);
  res.json({ ok: true });
});

app.get('/api/admin/me', auth.requireAuth, (req, res) => {
  res.json({ email: req.admin.email });
});

// ── Gallery API ────────────────────────────────────────────────────────
app.use(gallery.router);

// ── Public reviews API ─────────────────────────────────────────────────
app.get('/api/reviews', async (req, res) => {
  if (!db.isReady()) return res.json([]);
  try {
    const { rows } = await db.query(
      `SELECT id, name, text, image_url, approved_at
         FROM reviews WHERE status = 'approved'
        ORDER BY approved_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('[reviews] list failed:', err.message);
    res.json([]);
  }
});

app.post('/api/reviews', upload.single('photo'), async (req, res) => {
  const { name, text } = req.body || {};
  if (!name?.trim() || !text?.trim()) {
    return res.status(400).json({ error: 'Please add your name and your review.' });
  }
  if (!db.isReady()) {
    return res.status(503).json({ error: 'We could not save that just now. Please try again shortly.' });
  }
  try {
    let imageUrl = null;
    if (req.file) {
      const stored = await storage.storeImage(req.file.buffer, 'reviews');
      imageUrl = stored.url;
    }
    await db.query(
      `INSERT INTO reviews (name, text, image_url) VALUES ($1, $2, $3)`,
      [name.trim(), text.trim(), imageUrl]
    );
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof storage.UploadError) {
      return res.status(400).json({ error: err.message });
    }
    console.error('[reviews] submit failed:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ── Admin reviews API ──────────────────────────────────────────────────
app.get('/api/admin/reviews', auth.requireAuth, async (req, res) => {
  if (!db.isReady()) return res.json([]);
  try {
    const { rows } = await db.query(
      `SELECT * FROM reviews
        ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, submitted_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('[reviews] admin list failed:', err.message);
    res.status(500).json({ error: 'Could not load reviews right now.' });
  }
});

app.put('/api/admin/reviews/:id', auth.requireAuth, async (req, res) => {
  const { name, text } = req.body || {};
  try {
    await db.query(
      `UPDATE reviews SET
         name = COALESCE(NULLIF($1,''), name),
         text = COALESCE(NULLIF($2,''), text)
       WHERE id = $3`,
      [name || '', text || '', req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not save that change.' });
  }
});

app.patch('/api/admin/reviews/:id/approve', auth.requireAuth, async (req, res) => {
  try {
    await db.query(
      `UPDATE reviews SET status = 'approved', approved_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not publish that review.' });
  }
});

app.delete('/api/admin/reviews/:id', auth.requireAuth, async (req, res) => {
  try {
    await db.query(`DELETE FROM reviews WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not delete that review.' });
  }
});

// ── Errors ─────────────────────────────────────────────────────────────
// Turns multer and pipeline failures into plain English.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: 'That photo is too big to upload. Try taking a new photo with your ' +
             'camera instead of sending the original file.'
    });
  }
  if (err instanceof storage.UploadError) {
    return res.status(400).json({ error: err.message });
  }
  console.error('[server] unhandled:', err.message);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
