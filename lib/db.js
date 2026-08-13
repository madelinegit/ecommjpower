// Postgres access layer.
//
// The site must render even when the database is unreachable, so nothing here
// throws at boot. `ready` tells the rest of the app whether real data is
// available; callers fall back to hardcoded defaults when it is false.

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || '';

const pool = connectionString
  ? new Pool({
      connectionString,
      // Railway's managed Postgres terminates TLS with its own cert.
      ssl: /localhost|127\.0\.0\.1/.test(connectionString)
        ? false
        : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    })
  : null;

// An idle client erroring out must not take the process down with it.
if (pool) pool.on('error', err => console.error('[db] idle client error:', err.message));

let ready = false;
const isReady = () => ready;

async function query(text, params) {
  if (!pool) throw new Error('DATABASE_URL is not set');
  return pool.query(text, params);
}

// Runs every boot. CREATE TABLE IF NOT EXISTS makes this safe to repeat.
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS reviews (
     id           SERIAL PRIMARY KEY,
     name         TEXT NOT NULL,
     text         TEXT NOT NULL,
     image_url    TEXT,
     status       TEXT DEFAULT 'pending',
     submitted_at TIMESTAMPTZ DEFAULT NOW(),
     approved_at  TIMESTAMPTZ
   )`,

  `CREATE TABLE IF NOT EXISTS gallery_items (
     id          SERIAL PRIMARY KEY,
     title       TEXT NOT NULL,
     description TEXT,
     price       TEXT,
     category    TEXT NOT NULL CHECK (category IN ('art','home')),
     featured    BOOLEAN NOT NULL DEFAULT FALSE,
     position    INTEGER NOT NULL DEFAULT 0,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  `CREATE TABLE IF NOT EXISTS gallery_images (
     id          SERIAL PRIMARY KEY,
     item_id     INTEGER NOT NULL REFERENCES gallery_items(id) ON DELETE CASCADE,
     url         TEXT NOT NULL,
     thumb_url   TEXT NOT NULL,
     storage_key TEXT NOT NULL,
     thumb_key   TEXT NOT NULL,
     width       INTEGER,
     height      INTEGER,
     position    INTEGER NOT NULL DEFAULT 0
   )`,

  `CREATE TABLE IF NOT EXISTS site_content (
     key        TEXT PRIMARY KEY,
     value      TEXT NOT NULL DEFAULT '',
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  `ALTER TABLE gallery_images ADD COLUMN IF NOT EXISTS content_hash TEXT`,

  // Photo bytes live in Postgres so they survive a redeploy without a second
  // service to sign up for. At a few hundred photos of ~200KB this is a few
  // tens of megabytes — trivial for the database, and it means storage needs
  // no configuration at all.
  `CREATE TABLE IF NOT EXISTS media (
     key         TEXT PRIMARY KEY,
     bytes       BYTEA NOT NULL,
     content_type TEXT NOT NULL DEFAULT 'image/jpeg',
     byte_size   INTEGER NOT NULL,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  `ALTER TABLE gallery_items ADD COLUMN IF NOT EXISTS availability TEXT
     NOT NULL DEFAULT 'available'`,

  // Bullet points, one per line. Kept separate from description so the
  // paragraph and the spec list can be styled differently, the way the
  // original lantern block reads.
  `ALTER TABLE gallery_items ADD COLUMN IF NOT EXISTS features TEXT`,

  // 'photo' is an ordinary gallery shot. 'before' and 'after' pair up into a
  // drag-to-compare slider, which is the strongest proof asset on the site
  // for home projects.
  `ALTER TABLE gallery_images ADD COLUMN IF NOT EXISTS kind TEXT
     NOT NULL DEFAULT 'photo'`
];

// Indexes are applied separately: a unique index can legitimately fail on
// pre-existing duplicate rows, and that must not abort the whole migration
// and take the site down to fallback content.
const INDEXES = [
  // Hard guarantee: a category can never hold two featured items, whatever
  // the application layer does.
  `CREATE UNIQUE INDEX IF NOT EXISTS one_featured_per_category
     ON gallery_items (category) WHERE featured`,

  // Blocks the same name twice in the same view, case- and space-insensitive.
  `CREATE UNIQUE INDEX IF NOT EXISTS gallery_items_unique_title
     ON gallery_items (category, lower(btrim(title)))`,

  // Stops the identical photo being attached to a piece twice.
  `CREATE UNIQUE INDEX IF NOT EXISTS gallery_images_unique_content
     ON gallery_images (item_id, content_hash) WHERE content_hash IS NOT NULL`,

  `CREATE INDEX IF NOT EXISTS gallery_items_order
     ON gallery_items (category, position, id)`,

  `CREATE INDEX IF NOT EXISTS gallery_images_item
     ON gallery_images (item_id, position)`
];

async function init() {
  if (!pool) {
    console.warn('[db] DATABASE_URL is not set — running on fallback content only.');
    return false;
  }
  try {
    for (const sql of MIGRATIONS) await pool.query(sql);
    ready = true;
  } catch (err) {
    ready = false;
    console.error('[db] init failed, serving fallback content:', err.message);
    return false;
  }

  for (const sql of INDEXES) {
    try {
      await pool.query(sql);
    } catch (err) {
      console.error('[db] index skipped:', err.message);
    }
  }

  console.log('[db] connected, schema up to date');
  return true;
}

// Rewrites a category's positions to a clean 1..N. Called after every insert,
// delete, move, and category change so gaps and duplicates self-heal.
async function normalizePositions(client, category) {
  await client.query(
    `UPDATE gallery_items g SET position = r.rn
       FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY position, id) AS rn
               FROM gallery_items WHERE category = $1) r
      WHERE g.id = r.id AND g.position IS DISTINCT FROM r.rn`,
    [category]
  );
}

// Guarantees a category with at least one item always has exactly one
// featured item. Called after insert, delete, and category change.
async function reconcileFeatured(client, category) {
  const { rows } = await client.query(
    `SELECT COUNT(*) FILTER (WHERE featured) AS featured_count,
            COUNT(*)                        AS total
       FROM gallery_items WHERE category = $1`,
    [category]
  );
  const { featured_count: featured, total } = rows[0];
  if (Number(total) === 0 || Number(featured) === 1) return;

  // Promote the first item; the unique index already prevents a count above 1.
  await client.query(
    `UPDATE gallery_items SET featured = TRUE
      WHERE id = (SELECT id FROM gallery_items
                   WHERE category = $1 ORDER BY position, id LIMIT 1)`,
    [category]
  );
}

// Runs fn inside a transaction, rolling back on any error.
async function withTransaction(fn) {
  if (!pool) throw new Error('DATABASE_URL is not set');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  query,
  init,
  isReady,
  withTransaction,
  normalizePositions,
  reconcileFeatured
};
