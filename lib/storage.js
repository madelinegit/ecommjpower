// Image processing and object storage.
//
// Photos come straight off a phone camera: HEIC, sideways, 12MB+. Everything
// needed to make them web-ready happens here so the admin never has to rename,
// rotate, resize, or convert anything by hand.
//
// Files are written to a Railway Volume — disk that survives a redeploy. The
// container's own filesystem is wiped on every deploy, so uploads must never
// live there. Cloudflare R2 is still supported if the R2_* variables are set,
// but it is optional: a Volume needs no second account and no card on file.

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;   // 25MB — clears any real phone photo
const FULL_MAX_EDGE    = 1600;               // detail view
const THUMB_MAX_EDGE   = 600;                // grid tile

const R2 = {
  accountId: process.env.R2_ACCOUNT_ID || '',
  accessKey: process.env.R2_ACCESS_KEY_ID || '',
  secretKey: process.env.R2_SECRET_ACCESS_KEY || '',
  bucket:    process.env.R2_BUCKET || '',
  publicUrl: (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '')
};

const r2Configured = Boolean(
  R2.accountId && R2.accessKey && R2.secretKey && R2.bucket && R2.publicUrl
);

const s3 = r2Configured
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${R2.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2.accessKey, secretAccessKey: R2.secretKey }
    })
  : null;

// UPLOADS_DIR is the Volume's mount path in production (e.g. /data). Without
// it we fall back to a gitignored folder, which is fine for local development.
const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, '..', '.local-uploads');
const usingVolume = Boolean(process.env.UPLOADS_DIR);

if (!r2Configured && usingVolume) {
  try {
    fs.mkdirSync(uploadsDir, { recursive: true });
  } catch (err) {
    console.error('[storage] could not create', uploadsDir, '-', err.message);
  }
}

// Say plainly which of the three situations we are in, because the difference
// between "persistent" and "gone on next deploy" is invisible until it bites.
if (r2Configured) {
  console.log('[storage] photos -> Cloudflare R2 bucket', R2.bucket);
} else if (usingVolume) {
  console.log('[storage] photos -> Railway Volume at', uploadsDir);
} else {
  console.log('[storage] photos -> Postgres (media table)');
}

// Kept for the dev static route in server.js.
const localDir = uploadsDir;

// ── Format detection ──────────────────────────────────────────────────
// iOS sometimes hands over a HEIC file named .jpg, so sniff the container
// rather than trusting the filename or the browser-supplied mimetype.
function isHeic(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf.toString('ascii', 4, 8) !== 'ftyp') return false;
  const brand = buf.toString('ascii', 8, 12).toLowerCase();
  return ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis'].includes(brand);
}

class UploadError extends Error {
  constructor(message) { super(message); this.name = 'UploadError'; }
}

// ── Pipeline ──────────────────────────────────────────────────────────
async function processImage(buffer) {
  if (!buffer || !buffer.length) {
    throw new UploadError("That file came through empty. Try picking the photo again.");
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new UploadError(
      "That photo is too big to upload. Try taking a new photo with your camera " +
      "instead of sending the original file."
    );
  }

  let input = buffer;

  if (isHeic(buffer)) {
    // sharp's prebuilt binaries ship without HEIC decode, and HEIC is exactly
    // what an iPhone produces by default — so decode it in pure JS first.
    try {
      const heicConvert = require('heic-convert');
      input = await heicConvert({ buffer, format: 'JPEG', quality: 0.92 });
    } catch {
      throw new UploadError(
        "That photo is in a format we couldn't read. Open it in your Photos app, " +
        "tap Edit then Done, and try uploading it again."
      );
    }
  }

  let meta;
  try {
    meta = await sharp(input).metadata();
  } catch {
    throw new UploadError("That file isn't a photo. Pick an image and try again.");
  }
  if (!meta.width || !meta.height) {
    throw new UploadError("That file isn't a photo. Pick an image and try again.");
  }

  // .rotate() with no argument applies the EXIF orientation, which is what
  // keeps phone photos from rendering sideways.
  const base = () => sharp(input).rotate();

  const full = await base()
    .resize({ width: FULL_MAX_EDGE, height: FULL_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, progressive: true, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  const thumb = await base()
    .resize({ width: THUMB_MAX_EDGE, height: THUMB_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 78, progressive: true, mozjpeg: true })
    .toBuffer();

  return {
    full:   full.data,
    thumb,
    width:  full.info.width,
    height: full.info.height
  };
}

// ── Object storage ────────────────────────────────────────────────────
async function putObject(key, body) {
  if (s3) {
    await s3.send(new PutObjectCommand({
      Bucket: R2.bucket,
      Key: key,
      Body: body,
      ContentType: 'image/jpeg',
      CacheControl: 'public, max-age=31536000, immutable'
    }));
    return `${R2.publicUrl}/${key}`;
  }

  const name = key.replace(/\//g, '__');

  if (usingVolume) {
    await fs.promises.writeFile(path.join(uploadsDir, name), body);
    return `/media/${name}`;
  }

  // Default: straight into Postgres, which already exists and already
  // survives redeploys. No bucket, no volume, no configuration.
  const db = require('./db');
  await db.query(
    `INSERT INTO media (key, bytes, content_type, byte_size)
     VALUES ($1, $2, 'image/jpeg', $3)
     ON CONFLICT (key) DO UPDATE SET bytes = EXCLUDED.bytes,
                                     byte_size = EXCLUDED.byte_size`,
    [name, body, body.length]
  );
  return `/media/${name}`;
}

async function deleteObject(key) {
  if (!key) return;
  const name = key.replace(/\//g, '__');
  try {
    if (s3) {
      await s3.send(new DeleteObjectCommand({ Bucket: R2.bucket, Key: key }));
    } else if (usingVolume) {
      await fs.promises.unlink(path.join(uploadsDir, name)).catch(() => {});
    } else {
      const db = require('./db');
      await db.query(`DELETE FROM media WHERE key = $1`, [name]);
    }
  } catch (err) {
    // A stranded object costs pennies; a failed delete must not block the admin.
    console.error('[storage] delete failed for', key, err.message);
  }
}

// Reads a stored photo back for the /media route.
async function getObject(name) {
  if (usingVolume) {
    try {
      return { bytes: await fs.promises.readFile(path.join(uploadsDir, name)), contentType: 'image/jpeg' };
    } catch {
      return null;
    }
  }
  const db = require('./db');
  const { rows } = await db.query(
    `SELECT bytes, content_type FROM media WHERE key = $1`, [name]
  );
  if (!rows.length) return null;
  return { bytes: rows[0].bytes, contentType: rows[0].content_type };
}

// Processes a phone photo and stores both derivatives.
async function storeImage(buffer, prefix = 'gallery') {
  const { full, thumb, width, height } = await processImage(buffer);
  const id = crypto.randomUUID();

  const fullKey  = `${prefix}/${id}-full.jpg`;
  const thumbKey = `${prefix}/${id}-thumb.jpg`;

  const [url, thumbUrl] = await Promise.all([
    putObject(fullKey, full),
    putObject(thumbKey, thumb)
  ]);

  return { url, thumbUrl, storageKey: fullKey, thumbKey, width, height };
}

module.exports = {
  storeImage,
  getObject,
  deleteObject,
  processImage,
  isHeic,
  UploadError,
  r2Configured,
  usingVolume,
  uploadsDir,
  localDir,
  MAX_UPLOAD_BYTES
};
