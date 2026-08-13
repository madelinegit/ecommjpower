// Gallery items: create, read, update, delete, reorder, feature.
//
// Every write that touches ordering or the featured flag runs inside a
// transaction and then repairs the category's invariants, so the data cannot
// drift into a state the public page renders badly.

const express = require('express');
const multer = require('multer');

const db = require('./db');
const auth = require('./auth');
const storage = require('./storage');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: storage.MAX_UPLOAD_BYTES, files: 10 }
});

const CATEGORIES = ['art', 'home'];
const clean = v => (typeof v === 'string' ? v.trim() : '');

function normalizeCategory(value) {
  const c = clean(value).toLowerCase();
  return CATEGORIES.includes(c) ? c : 'art';
}

// Attaches each item's photos in one extra query rather than N.
async function attachImages(items) {
  if (!items.length) return items;
  const ids = items.map(i => i.id);
  const { rows } = await db.query(
    `SELECT id, item_id, url, thumb_url, width, height, position
       FROM gallery_images WHERE item_id = ANY($1::int[])
      ORDER BY position, id`,
    [ids]
  );
  const byItem = new Map(ids.map(id => [id, []]));
  rows.forEach(r => byItem.get(r.item_id)?.push(r));
  items.forEach(i => { i.images = byItem.get(i.id) || []; });
  return items;
}

async function listByCategory(category) {
  const { rows } = await db.query(
    `SELECT * FROM gallery_items WHERE category = $1 ORDER BY position, id`,
    [category]
  );
  return attachImages(rows);
}

// ── Public ─────────────────────────────────────────────────────────────
router.get('/api/gallery', async (req, res) => {
  if (!db.isReady()) return res.json([]);
  try {
    const items = await listByCategory(normalizeCategory(req.query.category));
    // An item with no photo has nothing to show, so keep it out of the grid.
    res.json(items.filter(i => i.images.length));
  } catch (err) {
    console.error('[gallery] public list failed:', err.message);
    res.json([]);
  }
});

// ── Admin: read ────────────────────────────────────────────────────────
router.get('/api/admin/gallery', auth.requireAuth, async (req, res) => {
  if (!db.isReady()) {
    return res.status(503).json({ error: 'The database is not connected yet.' });
  }
  try {
    const { rows } = await db.query(
      `SELECT * FROM gallery_items ORDER BY category, position, id`
    );
    res.json(await attachImages(rows));
  } catch (err) {
    console.error('[gallery] admin list failed:', err.message);
    res.status(500).json({ error: 'Could not load your pieces right now.' });
  }
});

// ── Admin: create ──────────────────────────────────────────────────────
// Title is the only required field. Photos are processed one at a time so a
// single bad file cannot lose the rest of the upload.
router.post('/api/admin/gallery', auth.requireAuth, upload.array('photos', 10), async (req, res) => {
  if (!db.isReady()) {
    return res.status(503).json({ error: 'The database is not connected yet.' });
  }
  const title = clean(req.body.title);
  if (!title) return res.status(400).json({ error: 'Please give this a name.' });

  const category = normalizeCategory(req.body.category);
  const description = clean(req.body.description) || null;
  const price = clean(req.body.price) || null;

  try {
    const item = await db.withTransaction(async client => {
      const { rows } = await client.query(
        `INSERT INTO gallery_items (title, description, price, category, position)
         VALUES ($1, $2, $3, $4,
                 COALESCE((SELECT MAX(position) FROM gallery_items WHERE category = $4), 0) + 1)
         RETURNING *`,
        [title, description, price, category]
      );
      await db.reconcileFeatured(client, category);
      return rows[0];
    });

    const stored = [];
    const failures = [];
    for (const file of req.files || []) {
      try {
        const img = await storage.storeImage(file.buffer, 'gallery');
        const { rows } = await db.query(
          `INSERT INTO gallery_images
             (item_id, url, thumb_url, storage_key, thumb_key, width, height, position)
           VALUES ($1,$2,$3,$4,$5,$6,$7,
                   COALESCE((SELECT MAX(position) FROM gallery_images WHERE item_id = $1), -1) + 1)
           RETURNING *`,
          [item.id, img.url, img.thumbUrl, img.storageKey, img.thumbKey, img.width, img.height]
        );
        stored.push(rows[0]);
      } catch (err) {
        failures.push(err instanceof storage.UploadError
          ? err.message
          : 'One photo would not upload. Check your signal and add it again.');
      }
    }

    res.json({ ok: true, item: { ...item, images: stored }, warnings: failures });
  } catch (err) {
    console.error('[gallery] create failed:', err.message);
    res.status(500).json({ error: 'Could not save that. Please try again.' });
  }
});

// ── Admin: update ──────────────────────────────────────────────────────
router.put('/api/admin/gallery/:id', auth.requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const title = clean(req.body.title);
  if (!title) return res.status(400).json({ error: 'Please give this a name.' });

  try {
    const updated = await db.withTransaction(async client => {
      const { rows: before } = await client.query(
        `SELECT category FROM gallery_items WHERE id = $1`, [id]
      );
      if (!before.length) return null;
      const oldCategory = before[0].category;
      const newCategory = normalizeCategory(req.body.category);
      const moved = oldCategory !== newCategory;

      const { rows } = await client.query(
        `UPDATE gallery_items
            SET title = $1, description = $2, price = $3, category = $4,
                featured = CASE WHEN $5 THEN FALSE ELSE featured END,
                position = CASE WHEN $5
                  THEN COALESCE((SELECT MAX(position) FROM gallery_items WHERE category = $4), 0) + 1
                  ELSE position END,
                updated_at = NOW()
          WHERE id = $6
        RETURNING *`,
        [title, clean(req.body.description) || null, clean(req.body.price) || null,
         newCategory, moved, id]
      );

      if (moved) {
        await db.normalizePositions(client, oldCategory);
        await db.normalizePositions(client, newCategory);
        await db.reconcileFeatured(client, oldCategory);
      }
      await db.reconcileFeatured(client, newCategory);
      return rows[0];
    });

    if (!updated) return res.status(404).json({ error: 'That piece is no longer there.' });
    res.json({ ok: true, item: updated });
  } catch (err) {
    console.error('[gallery] update failed:', err.message);
    res.status(500).json({ error: 'Could not save that change.' });
  }
});

// ── Admin: add photos to an existing item ──────────────────────────────
router.post('/api/admin/gallery/:id/photos', auth.requireAuth, upload.array('photos', 10), async (req, res) => {
  const id = Number(req.params.id);
  try {
    const { rows: exists } = await db.query(`SELECT id FROM gallery_items WHERE id = $1`, [id]);
    if (!exists.length) return res.status(404).json({ error: 'That piece is no longer there.' });

    const stored = [];
    const failures = [];
    for (const file of req.files || []) {
      try {
        const img = await storage.storeImage(file.buffer, 'gallery');
        const { rows } = await db.query(
          `INSERT INTO gallery_images
             (item_id, url, thumb_url, storage_key, thumb_key, width, height, position)
           VALUES ($1,$2,$3,$4,$5,$6,$7,
                   COALESCE((SELECT MAX(position) FROM gallery_images WHERE item_id = $1), -1) + 1)
           RETURNING *`,
          [id, img.url, img.thumbUrl, img.storageKey, img.thumbKey, img.width, img.height]
        );
        stored.push(rows[0]);
      } catch (err) {
        failures.push(err instanceof storage.UploadError
          ? err.message
          : 'One photo would not upload. Check your signal and add it again.');
      }
    }
    if (!stored.length && failures.length) {
      return res.status(400).json({ error: failures[0] });
    }
    res.json({ ok: true, images: stored, warnings: failures });
  } catch (err) {
    console.error('[gallery] add photos failed:', err.message);
    res.status(500).json({ error: 'Could not add that photo. Please try again.' });
  }
});

// ── Admin: remove one photo ────────────────────────────────────────────
router.delete('/api/admin/gallery/:id/photos/:imageId', auth.requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `DELETE FROM gallery_images WHERE id = $1 AND item_id = $2
       RETURNING storage_key, thumb_key`,
      [Number(req.params.imageId), Number(req.params.id)]
    );
    if (rows.length) {
      await storage.deleteObject(rows[0].storage_key);
      await storage.deleteObject(rows[0].thumb_key);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[gallery] delete photo failed:', err.message);
    res.status(500).json({ error: 'Could not remove that photo.' });
  }
});

// ── Admin: delete an item ──────────────────────────────────────────────
router.delete('/api/admin/gallery/:id', auth.requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const { rows: images } = await db.query(
      `SELECT storage_key, thumb_key FROM gallery_images WHERE item_id = $1`, [id]
    );

    const category = await db.withTransaction(async client => {
      const { rows } = await client.query(
        `DELETE FROM gallery_items WHERE id = $1 RETURNING category`, [id]
      );
      if (!rows.length) return null;
      const cat = rows[0].category;
      await db.normalizePositions(client, cat);
      // The featured item may have just been deleted; promote a successor.
      await db.reconcileFeatured(client, cat);
      return cat;
    });

    if (!category) return res.status(404).json({ error: 'That piece is already gone.' });

    // Files go after the row is safely gone, so a storage hiccup cannot
    // leave a record pointing at a deleted image.
    for (const img of images) {
      await storage.deleteObject(img.storage_key);
      await storage.deleteObject(img.thumb_key);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[gallery] delete failed:', err.message);
    res.status(500).json({ error: 'Could not delete that piece.' });
  }
});

// ── Admin: reorder ─────────────────────────────────────────────────────
// Arrow buttons, not drag-and-drop: reliable on a touch screen.
router.post('/api/admin/gallery/:id/move', auth.requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const dir = req.body.direction === 'down' ? 'down' : 'up';

  try {
    await db.withTransaction(async client => {
      const { rows } = await client.query(
        `SELECT id, category, position FROM gallery_items WHERE id = $1`, [id]
      );
      if (!rows.length) return;
      const me = rows[0];

      const { rows: neighbours } = await client.query(
        dir === 'up'
          ? `SELECT id, position FROM gallery_items
              WHERE category = $1 AND (position, id) < ($2, $3)
              ORDER BY position DESC, id DESC LIMIT 1`
          : `SELECT id, position FROM gallery_items
              WHERE category = $1 AND (position, id) > ($2, $3)
              ORDER BY position ASC, id ASC LIMIT 1`,
        [me.category, me.position, me.id]
      );
      if (!neighbours.length) return;   // already at the end

      const other = neighbours[0];
      await client.query(`UPDATE gallery_items SET position = $1 WHERE id = $2`,
        [other.position, me.id]);
      await client.query(`UPDATE gallery_items SET position = $1 WHERE id = $2`,
        [me.position, other.id]);
      await db.normalizePositions(client, me.category);
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[gallery] move failed:', err.message);
    res.status(500).json({ error: 'Could not move that piece.' });
  }
});

// ── Admin: feature ─────────────────────────────────────────────────────
// Unset then set in one transaction, so the partial unique index is never
// violated and the category can never end up with two or zero.
router.post('/api/admin/gallery/:id/feature', auth.requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const ok = await db.withTransaction(async client => {
      const { rows } = await client.query(
        `SELECT category FROM gallery_items WHERE id = $1`, [id]
      );
      if (!rows.length) return false;
      const category = rows[0].category;
      await client.query(
        `UPDATE gallery_items SET featured = FALSE WHERE category = $1 AND featured`,
        [category]
      );
      await client.query(
        `UPDATE gallery_items SET featured = TRUE, updated_at = NOW() WHERE id = $1`,
        [id]
      );
      return true;
    });
    if (!ok) return res.status(404).json({ error: 'That piece is no longer there.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[gallery] feature failed:', err.message);
    res.status(500).json({ error: 'Could not set the featured piece.' });
  }
});

module.exports = { router, listByCategory, attachImages };
