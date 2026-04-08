'use strict';

require('dotenv').config();

const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { marked } = require('marked');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const WIKI_DIR = path.join(__dirname, 'wiki-pages');
const DATA_DIR = path.join(__dirname, 'data');
const AUTH_STATE_FILE = path.join(DATA_DIR, 'auth-state.json');
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const PRIMARY_MODEL = process.env.GEMMA_PRIMARY_MODEL || 'gemma-4-27b-it';
const FALLBACK_MODEL = process.env.GEMMA_FALLBACK_MODEL || 'gemma-3-27b-it';
const MAX_PRO_KEY_GENERATION_ATTEMPTS = parsePositiveInt(process.env.MAX_PRO_KEY_GENERATION_ATTEMPTS, 20);
const ADMIN_GENERATE_LIMIT = Number(process.env.ADMIN_GENERATE_LIMIT || 50);
const PRO_GENERATE_MONTHLY_LIMIT = Number(process.env.PRO_GENERATE_MONTHLY_LIMIT || 100);
const USER_GENERATE_MONTHLY_LIMIT = Number(process.env.USER_GENERATE_MONTHLY_LIMIT || 10);
const SESSION_COOKIE_NAME = 'infinitely_wiki_session';
const SESSION_TTL_DAYS = parsePositiveInt(process.env.SESSION_TTL_DAYS, 30);
const PASSWORD_HASH_ITERATIONS = parsePositiveInt(process.env.PASSWORD_HASH_ITERATIONS, 310000);
const PASSWORD_HASH_KEYLEN = 32;
const PASSWORD_HASH_DIGEST = 'sha256';
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SECONDS_PER_DAY = 24 * 60 * 60;
const USERNAME_MIN_LENGTH = 3;
const USERNAME_MAX_LENGTH = 32;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;

// Ensure wiki-pages directory exists
if (!fs.existsSync(WIKI_DIR)) {
  fs.mkdirSync(WIKI_DIR, { recursive: true });
}
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function loadAuthState() {
  const emptyState = { users: Object.create(null), proKeys: Object.create(null), sessions: Object.create(null) };

  function toSafeMap(input) {
    const safe = Object.create(null);
    if (!input || typeof input !== 'object') return safe;
    for (const [rawKey, value] of Object.entries(input)) {
      const key = String(rawKey);
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      safe[key] = value;
    }
    return safe;
  }

  if (!fs.existsSync(AUTH_STATE_FILE)) {
    return emptyState;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(AUTH_STATE_FILE, 'utf8'));
    return {
      users: toSafeMap(parsed.users),
      proKeys: toSafeMap(parsed.proKeys),
      sessions: toSafeMap(parsed.sessions),
    };
  } catch {
    return emptyState;
  }
}

let authState = loadAuthState();
pruneExpiredSessions();

function saveAuthState() {
  fs.writeFileSync(AUTH_STATE_FILE, JSON.stringify(authState, null, 2), 'utf8');
}

function getCurrentMonthKey() {
  // Use UTC month boundaries so quota resets are consistent regardless of server timezone.
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function isFutureIso(value) {
  if (!value) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time > Date.now();
}

function getPlanForUser(record) {
  const safeRecord = record && typeof record === 'object' ? record : {};
  if (safeRecord.proPermanent) {
    return {
      name: 'pro',
      isPro: true,
      isPermanent: true,
      expiresAt: null,
    };
  }
  if (isFutureIso(safeRecord.proExpiresAt)) {
    return {
      name: 'pro',
      isPro: true,
      isPermanent: false,
      expiresAt: safeRecord.proExpiresAt,
    };
  }
  if (safeRecord.proExpiresAt) {
    safeRecord.proExpiresAt = null;
    saveAuthState();
  }
  return {
    name: 'free',
    isPro: false,
    isPermanent: false,
    expiresAt: null,
  };
}

function normalizeUserId(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, USERNAME_MAX_LENGTH);
  if (!normalized || normalized === '__proto__' || normalized === 'constructor' || normalized === 'prototype') {
    return '';
  }
  return normalized;
}

function validateUsernameInput(value) {
  const raw = String(value || '').trim();
  if (!raw) return { error: 'Username is required.' };
  if (!/^[a-zA-Z0-9_-]+$/.test(raw)) {
    return { error: 'Username may only contain letters, numbers, underscores, and hyphens.' };
  }
  const normalized = normalizeUserId(raw);
  if (normalized.length < USERNAME_MIN_LENGTH || normalized.length > USERNAME_MAX_LENGTH) {
    return { error: `Username must be ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} characters long.` };
  }
  return { normalized };
}

function validatePasswordInput(value) {
  const raw = String(value || '');
  if (!raw) return { error: 'Password is required.' };
  if (raw.length < PASSWORD_MIN_LENGTH || raw.length > PASSWORD_MAX_LENGTH) {
    return { error: `Password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters long.` };
  }
  return { password: raw };
}

function hashPassword(password, salt, iterations = PASSWORD_HASH_ITERATIONS) {
  return crypto.pbkdf2Sync(password, salt, iterations, PASSWORD_HASH_KEYLEN, PASSWORD_HASH_DIGEST).toString('hex');
}

function verifyPassword(password, userRecord) {
  if (!userRecord?.passwordHash || !userRecord?.passwordSalt) return false;
  const iterations = Number(userRecord.passwordIterations) || PASSWORD_HASH_ITERATIONS;
  const derived = hashPassword(password, userRecord.passwordSalt, iterations);
  const stored = Buffer.from(userRecord.passwordHash, 'hex');
  const candidate = Buffer.from(derived, 'hex');
  if (stored.length !== candidate.length) return false;
  return crypto.timingSafeEqual(stored, candidate);
}

function getUserRecord(userId) {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) return null;
  const record = authState.users[normalizedUserId];
  if (!record) return null;
  if (!record.username) {
    record.username = normalizedUserId;
    saveAuthState();
  }
  return record;
}

function createUserRecord(userId, password) {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) return null;
  const salt = crypto.randomBytes(16).toString('hex');
  const iterations = PASSWORD_HASH_ITERATIONS;
  const record = {
    username: normalizedUserId,
    role: Object.keys(authState.users).length === 0 ? 'admin' : 'user',
    passwordSalt: salt,
    passwordHash: hashPassword(password, salt, iterations),
    passwordIterations: iterations,
    proExpiresAt: null,
    proPermanent: false,
    generationUsage: { month: getCurrentMonthKey(), count: 0 },
    createdAt: new Date().toISOString(),
  };
  authState.users[normalizedUserId] = record;
  saveAuthState();
  return record;
}

function parseCookies(header) {
  const result = Object.create(null);
  if (!header) return result;
  const parts = header.split(';');
  for (const part of parts) {
    const [rawName, ...rest] = part.trim().split('=');
    if (!rawName) continue;
    const name = rawName.trim();
    if (!name) continue;
    const value = rest.join('=');
    result[name] = decodeURIComponent(value || '');
  }
  return result;
}

function isSecureRequest(req) {
  if (process.env.SESSION_COOKIE_SECURE === 'true') return true;
  if (process.env.SESSION_COOKIE_SECURE === 'false') return false;
  const forwarded = req.headers['x-forwarded-proto'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim().toLowerCase() === 'https';
  }
  return req.secure === true;
}

function pruneExpiredSessions() {
  const now = Date.now();
  let changed = false;
  for (const [token, session] of Object.entries(authState.sessions)) {
    const expires = Date.parse(session.expiresAt || '');
    if (!Number.isFinite(expires) || expires <= now) {
      delete authState.sessions[token];
      changed = true;
    }
  }
  if (changed) saveAuthState();
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * MS_PER_DAY).toISOString();
  authState.sessions[token] = { userId, createdAt, expiresAt };
  saveAuthState();
  return token;
}

function revokeSession(token) {
  if (token && authState.sessions[token]) {
    delete authState.sessions[token];
    saveAuthState();
  }
}

function getSessionToken(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return cookies[SESSION_COOKIE_NAME] || '';
}

function getSessionRecord(token) {
  if (!token) return null;
  pruneExpiredSessions();
  return authState.sessions[token] || null;
}

function setSessionCookie(res, token, req) {
  const maxAgeSeconds = SESSION_TTL_DAYS * SECONDS_PER_DAY;
  const secure = isSecureRequest(req);
  const cookie = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
  res.setHeader('Set-Cookie', cookie);
}

function clearSessionCookie(res, req) {
  const secure = req ? isSecureRequest(req) : false;
  const cookie = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : '',
  ].join('; ');
  res.setHeader('Set-Cookie', cookie);
}

function getSessionUser(req) {
  const token = getSessionToken(req);
  const session = getSessionRecord(token);
  if (!session) return null;
  const record = getUserRecord(session.userId);
  if (!record) {
    revokeSession(token);
    return null;
  }
  return { userId: session.userId, record };
}

function getMonthlyGenerationLimit(role, userRecord) {
  if (role === 'admin') return null;
  return getPlanForUser(userRecord).isPro ? PRO_GENERATE_MONTHLY_LIMIT : USER_GENERATE_MONTHLY_LIMIT;
}

function normalizeGenerationUsage(record) {
  const month = getCurrentMonthKey();
  const usage = record.generationUsage && typeof record.generationUsage === 'object'
    ? record.generationUsage
    : { month, count: 0 };
  if (usage.month !== month) {
    record.generationUsage = { month, count: 0 };
    saveAuthState();
    return record.generationUsage;
  }
  if (!Number.isFinite(Number(usage.count)) || Number(usage.count) < 0) {
    record.generationUsage = { month, count: 0 };
    saveAuthState();
    return record.generationUsage;
  }
  return usage;
}

function addMonthsSafe(date, months) {
  const base = new Date(date);
  const day = base.getUTCDate();
  base.setUTCDate(1);
  base.setUTCMonth(base.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  base.setUTCDate(Math.min(day, lastDay));
  return base;
}

function getGenerationStatus(role, record) {
  const monthlyLimit = getMonthlyGenerationLimit(role, record);
  const usage = normalizeGenerationUsage(record);
  return {
    monthlyLimit,
    monthlyUsed: usage.count,
    monthlyRemaining: monthlyLimit === null ? null : Math.max(0, monthlyLimit - usage.count),
    month: usage.month,
  };
}

function consumeGenerationQuota(role, record) {
  const monthlyLimit = getMonthlyGenerationLimit(role, record);
  if (monthlyLimit === null) {
    return { allowed: true, status: getGenerationStatus(role, record) };
  }
  const usage = normalizeGenerationUsage(record);
  if (usage.count >= monthlyLimit) {
    return { allowed: false, status: getGenerationStatus(role, record) };
  }
  usage.count += 1;
  record.generationUsage = usage;
  saveAuthState();
  return { allowed: true, status: getGenerationStatus(role, record) };
}

function makeProKey() {
  // Avoid ambiguous characters (I/O/1/0) so admins and users can read keys reliably.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const randomChunk = () =>
    Array.from({ length: 6 }, () => alphabet[crypto.randomInt(0, alphabet.length)]).join('');
  let key = '';
  for (let attempt = 0; attempt < MAX_PRO_KEY_GENERATION_ATTEMPTS; attempt += 1) {
    key = `PRO-${randomChunk()}-${randomChunk()}-${randomChunk()}`;
    if (!Object.hasOwn(authState.proKeys, key)) {
      return key;
    }
  }
  throw new Error('Unable to generate a unique Pro key. Please try again.');
}

// Rate limiters
const readLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

function getRateLimitKey(req) {
  const session = getSessionUser(req);
  return session?.userId || ipKeyGenerator(req);
}

const adminGenerateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: ADMIN_GENERATE_LIMIT,
  keyGenerator: (req) => req.user?.userId || getRateLimitKey(req),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Admin generation limit reached. Please try again later.' },
});

const adminPanelLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: (req) => getRateLimitKey(req),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many admin requests. Please try again later.' },
});

// Convert a topic string into a URL-safe slug
function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 100);
}

// Resolve and validate a wiki page path, returning null if unsafe
function safeWikiPath(slug) {
  const sanitized = slug.replace(/[^a-z0-9-]/g, '');
  if (!sanitized) return null;
  const base = path.resolve(WIKI_DIR);
  const resolved = path.resolve(base, `${sanitized}.md`);
  // Ensure resolved path stays inside WIKI_DIR (cross-platform check)
  const relative = path.relative(base, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return { sanitized, resolved };
}

// Extract the first non-banner heading from markdown content
function extractTitle(content, fallback) {
  const match = content.match(/^#{1,2}\s+(.+)$/m);
  return match ? match[1] : fallback;
}

function requireAuth(allowedRoles = []) {
  return (req, res, next) => {
    const session = getSessionUser(req);
    if (!session?.userId) {
      if (getSessionToken(req)) {
        clearSessionCookie(res, req);
      }
      if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Authentication required.' });
      }
      return res.redirect('/');
    }

    const userRecord = session.record;
    if (!userRecord) {
      clearSessionCookie(res, req);
      return res.status(400).json({ error: 'Invalid user.' });
    }

    const role = userRecord.role;
    if (allowedRoles.length > 0 && !allowedRoles.includes(role)) {
      return res.status(403).json({ error: 'Insufficient permissions.' });
    }

    req.user = {
      userId: session.userId,
      role,
      plan: getPlanForUser(userRecord),
    };
    req.userRecord = userRecord;
    return next();
  };
}

async function generateArticleWithFallback(genAI, prompt) {
  const primary = genAI.getGenerativeModel({ model: PRIMARY_MODEL });

  try {
    const result = await primary.generateContent(prompt);
    return { text: result.response.text(), modelUsed: PRIMARY_MODEL };
  } catch (primaryErr) {
    if (FALLBACK_MODEL === PRIMARY_MODEL) {
      throw new Error(
        `Primary and fallback models are both "${PRIMARY_MODEL}". Single-attempt generation failed: ${primaryErr.message || primaryErr}`
      );
    }

    const fallback = genAI.getGenerativeModel({ model: FALLBACK_MODEL });
    try {
      const result = await fallback.generateContent(prompt);
      return { text: result.response.text(), modelUsed: FALLBACK_MODEL };
    } catch (fallbackErr) {
      const combined = new Error(
        `Primary model "${PRIMARY_MODEL}" failed: ${primaryErr.message || primaryErr}. ` +
        `Fallback model "${FALLBACK_MODEL}" failed: ${fallbackErr.message || fallbackErr}`
      );
      combined.cause = { primaryErr, fallbackErr };
      throw combined;
    }
  }
}

function generationLimiterByRole(req, res, next) {
  if (req.user.role === 'admin') {
    return adminGenerateLimiter(req, res, next);
  }
  return next();
}

function buildAuthPayload(userId, userRecord) {
  return {
    userId,
    username: userRecord.username || userId,
    role: userRecord.role,
    plan: getPlanForUser(userRecord),
    generation: getGenerationStatus(userRecord.role, userRecord),
  };
}

function redeemProKeyForUser(rawKey, userRecord, userId) {
  const key = String(rawKey || '').trim().toUpperCase();
  if (!key) return { error: 'Key is required.' };
  const keyRecord = Object.hasOwn(authState.proKeys, key) ? authState.proKeys[key] : null;
  if (!keyRecord) return { error: 'Invalid key.' };
  if (keyRecord.redeemedBy) return { error: 'This key has already been redeemed.' };
  if (userRecord.proPermanent) return { error: 'You already have a permanent Pro plan.' };

  if (keyRecord.duration === 'permanent') {
    userRecord.proPermanent = true;
    userRecord.proExpiresAt = null;
  } else {
    const now = Date.now();
    const current = Date.parse(userRecord.proExpiresAt || '');
    const base = Number.isFinite(current) && current > now ? new Date(current) : new Date();
    const expiry = keyRecord.duration === 'annual' ? addMonthsSafe(base, 12) : addMonthsSafe(base, 1);
    userRecord.proExpiresAt = expiry.toISOString();
  }

  keyRecord.redeemedBy = userId;
  keyRecord.redeemedAt = new Date().toISOString();
  saveAuthState();

  return {
    keyRecord,
    plan: getPlanForUser(userRecord),
    generation: getGenerationStatus(userRecord.role, userRecord),
  };
}

app.post('/api/auth/signup', readLimiter, (req, res) => {
  const usernameCheck = validateUsernameInput(req.body && req.body.username);
  if (usernameCheck.error) {
    return res.status(400).json({ error: usernameCheck.error });
  }
  const passwordCheck = validatePasswordInput(req.body && req.body.password);
  if (passwordCheck.error) {
    return res.status(400).json({ error: passwordCheck.error });
  }
  const userId = usernameCheck.normalized;
  if (Object.hasOwn(authState.users, userId)) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }

  const rawKey = req.body && req.body.proKey;
  const trimmedKey = rawKey ? String(rawKey).trim().toUpperCase() : '';
  if (trimmedKey) {
    const keyRecord = Object.hasOwn(authState.proKeys, trimmedKey) ? authState.proKeys[trimmedKey] : null;
    if (!keyRecord) {
      return res.status(404).json({ error: 'Invalid Pro key.' });
    }
    if (keyRecord.redeemedBy) {
      return res.status(409).json({ error: 'This Pro key has already been redeemed.' });
    }
  }

  const userRecord = createUserRecord(userId, passwordCheck.password);
  if (!userRecord) {
    return res.status(400).json({ error: 'Invalid user.' });
  }

  if (trimmedKey) {
    const redemption = redeemProKeyForUser(trimmedKey, userRecord, userId);
    if (redemption.error) {
      delete authState.users[userId];
      saveAuthState();
      return res.status(400).json({ error: redemption.error });
    }
  }

  const token = createSession(userId);
  setSessionCookie(res, token, req);
  return res.status(201).json(buildAuthPayload(userId, userRecord));
});

app.post('/api/auth/login', readLimiter, (req, res) => {
  const usernameCheck = validateUsernameInput(req.body && req.body.username);
  if (usernameCheck.error) {
    return res.status(400).json({ error: usernameCheck.error });
  }
  const passwordCheck = validatePasswordInput(req.body && req.body.password);
  if (passwordCheck.error) {
    return res.status(400).json({ error: passwordCheck.error });
  }

  const userRecord = getUserRecord(usernameCheck.normalized);
  if (!userRecord || !verifyPassword(passwordCheck.password, userRecord)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  const existingToken = getSessionToken(req);
  if (existingToken) revokeSession(existingToken);
  const token = createSession(usernameCheck.normalized);
  setSessionCookie(res, token, req);
  return res.json(buildAuthPayload(usernameCheck.normalized, userRecord));
});

app.post('/api/auth/logout', readLimiter, (req, res) => {
  const token = getSessionToken(req);
  if (token) revokeSession(token);
  clearSessionCookie(res, req);
  return res.json({ success: true });
});

app.get('/api/auth/me', readLimiter, requireAuth(), (req, res) => {
  return res.json(buildAuthPayload(req.user.userId, req.userRecord));
});

app.get('/admin', adminPanelLimiter, requireAuth(['admin']), (req, res) => {
  return res.sendFile(path.join(__dirname, 'admin-panel.html'));
});

app.get('/api/admin/overview', adminPanelLimiter, requireAuth(['admin']), (req, res) => {
  const users = Object.entries(authState.users).map(([userId, user]) => ({
    userId,
    role: user.role,
    plan: getPlanForUser(user),
    generation: getGenerationStatus(user.role, user),
    createdAt: user.createdAt || null,
  }));
  const proKeys = Object.values(authState.proKeys).sort((a, b) => {
    const aTime = Date.parse(a.createdAt || '') || 0;
    const bTime = Date.parse(b.createdAt || '') || 0;
    return bTime - aTime;
  });
  return res.json({ users, proKeys });
});

app.post('/api/admin/users/promote', adminPanelLimiter, requireAuth(['admin']), (req, res) => {
  const targetUserId = normalizeUserId(req.body && req.body.userId);
  if (!targetUserId) {
    return res.status(400).json({ error: 'Valid userId is required.' });
  }
  const target = getUserRecord(targetUserId);
  if (!target) {
    return res.status(404).json({ error: 'User not found.' });
  }
  target.role = 'admin';
  saveAuthState();
  return res.json({ userId: targetUserId, role: target.role });
});

app.post('/api/admin/pro-keys', adminPanelLimiter, requireAuth(['admin']), (req, res) => {
  const requestedDuration = String((req.body && req.body.duration) || 'monthly').toLowerCase();
  const duration = ['monthly', 'annual', 'permanent'].includes(requestedDuration)
    ? requestedDuration
    : null;
  if (!duration) {
    return res.status(400).json({ error: 'Duration must be monthly, annual, or permanent.' });
  }

  let key = '';
  try {
    key = makeProKey();
  } catch (err) {
    return res.status(500).json({ error: 'Could not generate a unique Pro key right now.' });
  }
  const createdAt = new Date().toISOString();
  authState.proKeys[key] = {
    key,
    duration,
    createdBy: req.user.userId,
    createdAt,
    redeemedBy: null,
    redeemedAt: null,
  };
  saveAuthState();
  return res.status(201).json(authState.proKeys[key]);
});

app.post('/api/pro/redeem', readLimiter, requireAuth(), (req, res) => {
  const redemption = redeemProKeyForUser(req.body && req.body.key, req.userRecord, req.user.userId);
  if (redemption.error) {
    let status = 400;
    if (redemption.error.includes('Invalid key')) status = 404;
    if (redemption.error.includes('already') || redemption.error.includes('permanent')) status = 409;
    return res.status(status).json({ error: redemption.error });
  }
  return res.json({
    success: true,
    plan: redemption.plan,
    generation: redemption.generation,
    redeemedKey: {
      key: redemption.keyRecord.key,
      duration: redemption.keyRecord.duration,
      redeemedAt: redemption.keyRecord.redeemedAt,
    },
  });
});

// List all saved wiki pages
app.get('/api/pages', readLimiter, requireAuth(), (req, res) => {
  try {
    const files = fs.readdirSync(WIKI_DIR).filter((f) => f.endsWith('.md'));
    const pages = files.map((file) => {
      const slug = path.basename(file, '.md');
      const content = fs.readFileSync(path.join(WIKI_DIR, file), 'utf8');
      const title = extractTitle(content, slug);
      return { slug, title };
    });
    res.json(pages);
  } catch (err) {
    res.status(500).json({ error: 'Failed to list pages.' });
  }
});

// Generate a new wiki page
app.post('/api/generate', requireAuth(), generationLimiterByRole, async (req, res) => {
  const topic = (req.body && req.body.topic) ? String(req.body.topic).trim() : '';
  if (!topic) {
    return res.status(400).json({ error: 'Topic is required.' });
  }
  if (topic.length > 200) {
    return res.status(400).json({ error: 'Topic is too long (max 200 characters).' });
  }

  const slug = slugify(topic);
  if (!slug) {
    return res.status(400).json({ error: 'Topic produced an invalid slug.' });
  }

  const safe = safeWikiPath(slug);
  if (!safe) {
    return res.status(400).json({ error: 'Topic produced an invalid slug.' });
  }

  // Return cached page if it already exists
  if (fs.existsSync(safe.resolved)) {
    return res.json({ slug: safe.sanitized, cached: true, generation: getGenerationStatus(req.user.role, req.userRecord) });
  }

  const quota = consumeGenerationQuota(req.user.role, req.userRecord);
  if (!quota.allowed) {
    return res.status(429).json({
      error: 'Monthly generation limit reached for your plan.',
      generation: quota.status,
    });
  }

  if (!API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY environment variable is not set.' });
  }

  try {
    const genAI = new GoogleGenerativeAI(API_KEY);

    const prompt = `Write a comprehensive Wikipedia-style article about "${topic}". 
The article must be written in Markdown format.
Start with a level-1 heading that is the article title.
Include the following sections where applicable: Overview, History, Key Concepts, Notable Facts, See Also.
Use proper Markdown formatting: headings (##, ###), bold (**text**), bullet lists, and numbered lists.
Do NOT include any preamble, disclaimers, or meta-commentary — output ONLY the Markdown article content.`;

    const { text, modelUsed } = await generateArticleWithFallback(genAI, prompt);
    const safeModelUsed = String(modelUsed).replace(/[^a-zA-Z0-9._-]/g, '');

    // Prepend the AI warning banner
    const banner = `> ⚠️ **AI-Generated Content** — This article was created by an AI model (${safeModelUsed || 'unknown-model'}). It may contain inaccuracies. Do not rely on it as a factual reference.\n\n`;
    const fullContent = banner + text;

    fs.writeFileSync(safe.resolved, fullContent, 'utf8');
    return res.json({ slug: safe.sanitized, cached: false, modelUsed, generation: quota.status });
  } catch (err) {
    console.error('Gemini API error:', err);
    return res.status(500).json({ error: 'Failed to generate article. ' + (err.message || '') });
  }
});

// Serve a wiki page rendered as HTML
app.get('/wiki/:slug', readLimiter, requireAuth(), (req, res) => {
  const safe = safeWikiPath(req.params.slug);
  if (!safe) {
    return res.status(400).send('Invalid page slug.');
  }

  if (!fs.existsSync(safe.resolved)) {
    return res.status(404).send('Page not found.');
  }

  const markdown = fs.readFileSync(safe.resolved, 'utf8');
  const title = extractTitle(markdown, safe.sanitized);
  const htmlContent = marked(markdown);

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)} — Infinitely Wiki</title>
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <header class="site-header">
    <a href="/" class="site-logo">🌐 Infinitely Wiki</a>
  </header>
  <main class="wiki-article">
    ${htmlContent}
  </main>
  <footer class="site-footer">
    <p>Generated by <strong>Gemma AI</strong> via Google Gemini API. Content may be inaccurate.</p>
    <p><a href="/">← Back to search</a></p>
  </footer>
</body>
</html>`);
});

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

app.listen(PORT, HOST, () => {
  const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`Infinitely Wiki server running at http://${displayHost}:${PORT}`);
});

module.exports = app;
