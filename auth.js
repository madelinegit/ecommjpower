// Single-admin authentication.
//
// Credentials live entirely in environment variables so they can be rotated
// without a code change. The password is only ever present as a bcrypt hash —
// nothing here is exposed to client-side JavaScript.

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'jpc_session';
const SESSION_DAYS = 30;          // long enough that he isn't re-logging in
const MAX_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD_HASH = (process.env.ADMIN_PASSWORD_HASH || '').trim();
const JWT_SECRET = process.env.JWT_SECRET || '';

const configured = Boolean(ADMIN_EMAIL && ADMIN_PASSWORD_HASH && JWT_SECRET);

if (!configured) {
  console.warn(
    '[auth] Admin login is disabled. Set ADMIN_EMAIL, ADMIN_PASSWORD_HASH ' +
    'and JWT_SECRET to enable /admin.'
  );
}

// ── Brute-force throttle ──────────────────────────────────────────────
// In-memory is sufficient for a single-admin site: a restart clearing the
// counters is not a meaningful weakness here.
const attempts = new Map();

function attemptKey(req) {
  return (req.headers['x-forwarded-for'] || req.ip || 'unknown').split(',')[0].trim();
}

function isLockedOut(req) {
  const rec = attempts.get(attemptKey(req));
  if (!rec) return false;
  if (Date.now() - rec.first > ATTEMPT_WINDOW_MS) {
    attempts.delete(attemptKey(req));
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

function recordFailure(req) {
  const key = attemptKey(req);
  const rec = attempts.get(key);
  if (!rec || Date.now() - rec.first > ATTEMPT_WINDOW_MS) {
    attempts.set(key, { count: 1, first: Date.now() });
  } else {
    rec.count += 1;
  }
}

function clearFailures(req) {
  attempts.delete(attemptKey(req));
}

// ── Session ───────────────────────────────────────────────────────────
function issueSession(res, email) {
  const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,                                  // unreadable from JS
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: '/'
  });
}

function clearSession(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function readSession(req) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token || !JWT_SECRET) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

async function verifyCredentials(email, password) {
  if (!configured) {
    return { ok: false, message: 'Login is not set up yet. Contact your developer.' };
  }
  const given = (email || '').trim().toLowerCase();
  const pass = password || '';

  // Always run a bcrypt compare so a wrong email and a wrong password take
  // the same amount of time.
  const hashToCheck = given === ADMIN_EMAIL
    ? ADMIN_PASSWORD_HASH
    : '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';

  let match = false;
  try {
    match = await bcrypt.compare(pass, hashToCheck);
  } catch {
    match = false;
  }

  if (given !== ADMIN_EMAIL || !match) {
    return { ok: false, message: 'That email or password is not right. Try again.' };
  }
  return { ok: true, email: ADMIN_EMAIL };
}

// ── Middleware ────────────────────────────────────────────────────────

// For API routes: 401 JSON.
function requireAuth(req, res, next) {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: 'Please sign in again.' });
  req.admin = session;
  next();
}

// For page routes: bounce to the login screen.
function requireAuthPage(req, res, next) {
  const session = readSession(req);
  if (!session) return res.redirect('/admin/login');
  req.admin = session;
  next();
}

module.exports = {
  COOKIE_NAME,
  SESSION_DAYS,
  configured,
  issueSession,
  clearSession,
  readSession,
  verifyCredentials,
  requireAuth,
  requireAuthPage,
  isLockedOut,
  recordFailure,
  clearFailures
};
