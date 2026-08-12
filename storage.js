// Image processing and object storage.
//
// Photos come straight off a phone camera: HEIC, sideways, 12MB+. Everything
// needed to make them web-ready happens here so the admin never has to rename,
// rotate, resize, or convert anything by hand.
//
// Files go to Cloudflare R2, never to the container filesystem — a Railway
// redeploy wipes the container, and uploads must survive that.

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

// Fail loudly in production rather than silently writing to a disk that is
// about to be destroyed.
if (!r2Configured && process.env.NODE_ENV === 'production') {
  console.error(
    '[storage] R2 is not configured. Uploads will be written to the container ' +
    'filesystem and WILL BE LOST on the next deploy. Set R2_ACCOUNT_ID, ' +
    'R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, and R2_PUBLIC_URL.'
  );
}

const s3 = r2Configured
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${R2.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2.accessKey, secretAccessKey: R2.secretKey }
    })
  : null;

// Local dev fallback so the admin panel is usable without a Cloudflare account.
const localDir = path.join(__dirname, '.local-uploads');
if (!r2Configured && !fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });

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
  const dest = path.join(localDir, key.replace(/\//g, '__'));
  await fs.promises.writeFile(dest, body);
  return `/local-uploads/${path.basename(dest)}`;
}

async function deleteObject(key) {
  if (!key) return;
  try {
    if (s3) {
      await s3.send(new DeleteObjectCommand({ Bucket: R2.bucket, Key: key }));
    } else {
      await fs.promises.unlink(path.join(localDir, key.replace(/\//g, '__'))).catch(() => {});
    }
  } catch (err) {
    // A stranded object costs pennies; a failed delete must not block the admin.
    console.error('[storage] delete failed for', key, err.message);
  }
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
  deleteObject,
  processImage,
  isHeic,
  UploadError,
  r2Configured,
  localDir,
  MAX_UPLOAD_BYTES
};
