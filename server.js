'use strict';

require('dotenv').config();

const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { marked } = require('marked');
const { rateLimit } = require('express-rate-limit');
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
const TRUST_PROXY = process.env.TRUST_PROXY;
const WIKI_DIR = path.join(__dirname, 'wiki-pages');
const DATA_DIR = path.join(__dirname, 'data');
const AUTH_STATE_FILE = path.join(DATA_DIR, 'auth-state.json');
const ARTICLE_STATE_FILE = path.join(DATA_DIR, 'article-state.json');
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
const MAX_STORED_ARTICLE_ACTIONS = 5000;
const TANGENTIAL_SELECTION_START = 0.25;
const TANGENTIAL_SELECTION_END = 0.75;
const INFINITE_SCROLL_ROOT_MARGIN = '600px 0px 600px 0px';
// Cache object is reassigned whenever wiki file signatures change.
let wikiRelationshipCache = {
  signature: '',
  records: [],
  graph: new Map(),
};
const BADGE_DEFINITIONS = [
  { id: 'gen-1', category: 'generation', threshold: 1, name: 'First Article', description: 'Generate your first article.' },
  { id: 'gen-10', category: 'generation', threshold: 10, name: 'Researcher', description: 'Generate 10 articles.' },
  { id: 'gen-50', category: 'generation', threshold: 50, name: 'Archivist', description: 'Generate 50 articles.' },
  { id: 'scroll-5', category: 'scroll', threshold: 5, name: 'Wanderer', description: 'Discover 5 articles via infinite scroll.' },
  { id: 'scroll-25', category: 'scroll', threshold: 25, name: 'Explorer', description: 'Discover 25 articles via infinite scroll.' },
  { id: 'scroll-100', category: 'scroll', threshold: 100, name: 'Infinite Voyager', description: 'Discover 100 articles via infinite scroll.' },
];
const MAX_COMMENT_LENGTH = 1000;
const MAX_COMMENTS_PER_ARTICLE = 1000;
const MAX_SANITIZED_SLUGS = 1000;
const MAX_PROFILE_PICTURE_URL_LENGTH = 500;

function parseTrustProxy(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'loopback';
  const normalized = raw.toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  return raw;
}

app.set('trust proxy', parseTrustProxy(TRUST_PROXY));

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

function loadArticleState() {
  const emptyState = { articles: Object.create(null) };

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

  if (!fs.existsSync(ARTICLE_STATE_FILE)) {
    return emptyState;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(ARTICLE_STATE_FILE, 'utf8'));
    return { articles: toSafeMap(parsed.articles) };
  } catch {
    return emptyState;
  }
}

let articleState = loadArticleState();

function saveAuthState() {
  fs.writeFileSync(AUTH_STATE_FILE, JSON.stringify(authState, null, 2), 'utf8');
}

function saveArticleState() {
  fs.writeFileSync(ARTICLE_STATE_FILE, JSON.stringify(articleState, null, 2), 'utf8');
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

function sanitizeProfilePictureUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.length > MAX_PROFILE_PICTURE_URL_LENGTH) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return '';
  }
  return parsed.toString();
}

function validateProfilePictureInput(value) {
  const raw = String(value || '').trim();
  if (!raw) return { profilePictureUrl: '' };
  if (raw.length > MAX_PROFILE_PICTURE_URL_LENGTH) {
    return { error: `Profile picture URL is too long (max ${MAX_PROFILE_PICTURE_URL_LENGTH} characters).` };
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: 'Profile picture URL must be a valid URL.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'Profile picture URL must use http or https.' };
  }
  return { profilePictureUrl: parsed.toString() };
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
  let changed = false;
  if (!record.username) {
    record.username = normalizedUserId;
    changed = true;
  }
  if (!Array.isArray(record.likedArticles)) {
    record.likedArticles = [];
    changed = true;
  }
  if (!Array.isArray(record.savedArticles)) {
    record.savedArticles = [];
    changed = true;
  }
  const sanitizedProfilePictureUrl = sanitizeProfilePictureUrl(record.profilePictureUrl);
  if ((record.profilePictureUrl || '') !== sanitizedProfilePictureUrl) {
    record.profilePictureUrl = sanitizedProfilePictureUrl;
    changed = true;
  }
  if (changed) {
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
    stats: {
      generatedArticles: 0,
      infiniteScrollDiscoveries: 0,
    },
    likedArticles: [],
    savedArticles: [],
    profilePictureUrl: '',
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

function ensureUserProgress(record) {
  const existing = record && typeof record.stats === 'object' ? record.stats : {};
  const generatedArticles = Number.isFinite(Number(existing.generatedArticles))
    ? Math.max(0, Number(existing.generatedArticles))
    : 0;
  const infiniteScrollDiscoveries = Number.isFinite(Number(existing.infiniteScrollDiscoveries))
    ? Math.max(0, Number(existing.infiniteScrollDiscoveries))
    : 0;
  const normalized = { generatedArticles, infiniteScrollDiscoveries };
  if (!record.stats
    || record.stats.generatedArticles !== generatedArticles
    || record.stats.infiniteScrollDiscoveries !== infiniteScrollDiscoveries) {
    record.stats = normalized;
    saveAuthState();
  }
  return record.stats;
}

function incrementUserProgress(record, field, amount = 1) {
  if (!record || (field !== 'generatedArticles' && field !== 'infiniteScrollDiscoveries')) return;
  const stats = ensureUserProgress(record);
  const delta = Number.isFinite(Number(amount)) ? Number(amount) : 0;
  if (delta <= 0) return;
  stats[field] = Math.max(0, Number(stats[field] || 0) + delta);
  record.stats = stats;
  saveAuthState();
}

function getUserBadges(record) {
  const stats = ensureUserProgress(record);
  return BADGE_DEFINITIONS.map((badge) => {
    const progress = badge.category === 'generation'
      ? stats.generatedArticles
      : stats.infiniteScrollDiscoveries;
    return {
      ...badge,
      earned: progress >= badge.threshold,
      progress,
    };
  });
}

function ensureArticleRecord(slug) {
  const safeSlug = String(slug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!safeSlug) return null;
  const existing = articleState.articles[safeSlug];
  if (existing && typeof existing === 'object') {
    if (!Array.isArray(existing.comments)) {
      existing.comments = [];
      saveArticleState();
    }
    return existing;
  }
  const created = { generatedBy: null, generatedAt: null, comments: [] };
  articleState.articles[safeSlug] = created;
  saveArticleState();
  return created;
}

function recordArticleGenerator(slug, userId) {
  const record = ensureArticleRecord(slug);
  if (!record) return;
  if (!record.generatedBy) {
    record.generatedBy = userId;
    record.generatedAt = new Date().toISOString();
    saveArticleState();
  }
}

function getArticleGeneratorInfo(slug) {
  const record = ensureArticleRecord(slug);
  if (!record) return null;
  const generatorId = normalizeUserId(record.generatedBy || '');
  if (!generatorId) return null;
  const generatorRecord = getUserRecord(generatorId);
  if (!generatorRecord) return null;
  return {
    userId: generatorId,
    username: generatorRecord.username || generatorId,
    profilePictureUrl: sanitizeProfilePictureUrl(generatorRecord.profilePictureUrl),
    generatedAt: record.generatedAt || null,
  };
}

function listArticleComments(slug) {
  const record = ensureArticleRecord(slug);
  if (!record) return [];
  const comments = Array.isArray(record.comments) ? record.comments : [];
  return comments
    .filter((comment) => comment && typeof comment === 'object')
    .map((comment) => {
      const authorId = normalizeUserId(comment.authorId || '');
      const authorRecord = authorId ? getUserRecord(authorId) : null;
      return {
        id: String(comment.id || ''),
        body: String(comment.body || ''),
        createdAt: comment.createdAt || null,
        author: authorId
          ? {
            userId: authorId,
            username: authorRecord?.username || authorId,
            profilePictureUrl: sanitizeProfilePictureUrl(authorRecord?.profilePictureUrl),
          }
          : null,
      };
    })
    .filter((comment) => comment.id && comment.body);
}

function addArticleComment(slug, authorId, body) {
  const text = String(body || '').trim();
  if (!text) return { error: 'Comment is required.' };
  if (text.length > MAX_COMMENT_LENGTH) {
    return { error: `Comment is too long (max ${MAX_COMMENT_LENGTH} characters).` };
  }
  const record = ensureArticleRecord(slug);
  if (!record) return { error: 'Invalid page slug.' };
  const comment = {
    id: crypto.randomUUID(),
    authorId,
    body: text,
    createdAt: new Date().toISOString(),
  };
  if (!Array.isArray(record.comments)) record.comments = [];
  record.comments.push(comment);
  if (record.comments.length > MAX_COMMENTS_PER_ARTICLE) {
    record.comments = record.comments.slice(-MAX_COMMENTS_PER_ARTICLE);
  }
  saveArticleState();
  return { comment };
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
  if (session?.userId) return session.userId;
  return req.ip || 'ip:unknown';
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

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => getRateLimitKey(req),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many write requests. Please try again later.' },
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

const RELATIONSHIP_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'about', 'also', 'have', 'has', 'had',
  'their', 'there', 'them', 'they', 'then', 'than', 'were', 'was', 'are', 'but', 'not', 'you', 'your',
  'our', 'its', 'who', 'what', 'when', 'where', 'how', 'why', 'which', 'can', 'may', 'such', 'other',
  'some', 'more', 'most', 'many', 'each', 'over', 'under', 'during', 'after', 'before', 'between',
  'through', 'within', 'without', 'using', 'used', 'use', 'these', 'those', 'because', 'while', 'been',
  'will', 'would', 'could', 'should', 'onto', 'upon', 'like', 'very', 'much', 'both', 'only',
]);

function readWikiPageRecords() {
  const files = fs.readdirSync(WIKI_DIR).filter((f) => f.endsWith('.md'));
  return files.map((file) => {
    const slug = path.basename(file, '.md');
    const markdown = fs.readFileSync(path.join(WIKI_DIR, file), 'utf8');
    const title = extractTitle(markdown, slug);
    return { slug, title, markdown };
  });
}

function extractRelationshipTerms(title, markdown) {
  const text = `${title || ''}\n${markdown || ''}`
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ');
  const terms = text
    .split(/[^a-z0-9]+/g)
    .map((term) => term.trim())
    .filter((term) => term.length >= 4 && !RELATIONSHIP_STOP_WORDS.has(term));
  return new Set(terms);
}

function buildRelationshipGraph(pageRecords) {
  const graph = new Map();
  const records = pageRecords.map((page) => ({
    ...page,
    terms: extractRelationshipTerms(page.title, page.markdown),
  }));

  for (const page of records) {
    graph.set(page.slug, []);
  }

  for (let i = 0; i < records.length; i += 1) {
    for (let j = i + 1; j < records.length; j += 1) {
      const a = records[i];
      const b = records[j];
      if (a.terms.size === 0 || b.terms.size === 0) continue;
      const smaller = a.terms.size < b.terms.size ? a.terms : b.terms;
      const larger = smaller === a.terms ? b.terms : a.terms;
      let shared = 0;
      for (const term of smaller) {
        if (larger.has(term)) shared += 1;
      }
      if (shared === 0) continue;
      const score = shared / Math.sqrt(a.terms.size * b.terms.size);
      graph.get(a.slug).push({ slug: b.slug, title: b.title, score });
      graph.get(b.slug).push({ slug: a.slug, title: a.title, score });
    }
  }

  for (const related of graph.values()) {
    related.sort((left, right) => right.score - left.score);
  }

  return graph;
}

function pickTangentialRelatedPage(relatedPages, excludedSlugs) {
  const available = relatedPages.filter((page) => !excludedSlugs.has(page.slug));
  if (available.length === 0) return null;
  if (available.length === 1) return available[0];
  const start = Math.floor(available.length * TANGENTIAL_SELECTION_START);
  const end = Math.max(start + 1, Math.floor(available.length * TANGENTIAL_SELECTION_END));
  const tangentialPool = available.slice(start, end);
  const pool = tangentialPool.length > 0 ? tangentialPool : available;
  return pool[Math.floor(Math.random() * pool.length)];
}

function sanitizeCommaSeparatedSlugs(value) {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((slug) => slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, ''))
    .filter(Boolean)
    .slice(0, MAX_SANITIZED_SLUGS);
}

function sanitizeStoredArticleSlugList(value) {
  if (typeof value === 'string') {
    return sanitizeCommaSeparatedSlugs(value);
  }
  if (!Array.isArray(value)) return [];
  const unique = new Set(
    value
      .map((slug) => String(slug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, ''))
      .filter(Boolean)
  );
  return Array.from(unique).slice(0, MAX_STORED_ARTICLE_ACTIONS);
}

function ensureArticleActionsState(userRecord) {
  let changed = false;
  const liked = sanitizeStoredArticleSlugList(userRecord.likedArticles);
  const saved = sanitizeStoredArticleSlugList(userRecord.savedArticles);
  if (!Array.isArray(userRecord.likedArticles) || liked.join('|') !== userRecord.likedArticles.join('|')) {
    userRecord.likedArticles = liked;
    changed = true;
  }
  if (!Array.isArray(userRecord.savedArticles) || saved.join('|') !== userRecord.savedArticles.join('|')) {
    userRecord.savedArticles = saved;
    changed = true;
  }
  if (changed) saveAuthState();
}

function getArticleActionsForUser(userRecord) {
  ensureArticleActionsState(userRecord);
  return {
    likedSlugs: userRecord.likedArticles,
    savedSlugs: userRecord.savedArticles,
  };
}

function updateArticleAction(userRecord, slug, actionKey, enabled) {
  ensureArticleActionsState(userRecord);
  const list = actionKey === 'liked' ? userRecord.likedArticles : userRecord.savedArticles;
  const index = list.indexOf(slug);
  if (enabled && index === -1) {
    list.push(slug);
    saveAuthState();
  } else if (!enabled && index !== -1) {
    list.splice(index, 1);
    saveAuthState();
  }
}

function getWikiRelationshipData() {
  const files = fs.readdirSync(WIKI_DIR).filter((file) => file.endsWith('.md')).sort();
  const signature = files.map((file) => {
    const stat = fs.statSync(path.join(WIKI_DIR, file));
    return `${file}:${stat.size}:${stat.mtimeMs}`;
  }).join('|');

  if (wikiRelationshipCache.signature === signature) {
    return wikiRelationshipCache;
  }

  const records = readWikiPageRecords();
  const graph = buildRelationshipGraph(records);
  wikiRelationshipCache = { signature, records, graph };
  return wikiRelationshipCache;
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

function userCanUseInfiniteScroll(user) {
  if (!user || typeof user !== 'object') return false;
  if (user.role === 'admin') return true;
  return !!(user.plan && user.plan.isPro);
}

function requireProInfiniteScroll(req, res, next) {
  if (userCanUseInfiniteScroll(req.user)) {
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(403).json({ error: 'Infinite discovery is available for Pro users only.' });
  }
  return res.status(403).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Pro required — Infinitely Wiki</title>
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <header class="site-header">
    <a href="/" class="site-logo">🌐 Infinitely Wiki</a>
    <a href="https://discord.gg/HmKesPxYqY" class="header-discord-link" target="_blank" rel="noopener noreferrer">Discord</a>
  </header>
  <main class="profile-page">
    <section class="profile-card">
      <h1>Infinite Discovery is Pro-only</h1>
      <p>Upgrade to Pro on your account settings page to unlock infinite scroll discovery.</p>
      <p><a class="wiki-stream-link" href="/settings">Go to account settings</a></p>
    </section>
  </main>
</body>
</html>`);
}

function buildAuthPayload(userId, userRecord) {
  const stats = ensureUserProgress(userRecord);
  return {
    userId,
    username: userRecord.username || userId,
    profilePictureUrl: sanitizeProfilePictureUrl(userRecord.profilePictureUrl),
    role: userRecord.role,
    plan: getPlanForUser(userRecord),
    generation: getGenerationStatus(userRecord.role, userRecord),
    stats,
    badges: getUserBadges(userRecord).filter((badge) => badge.earned),
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

app.get('/profile', readLimiter, requireAuth(), (req, res) => {
  return res.redirect(`/u/${encodeURIComponent(req.user.userId)}`);
});

app.get('/settings', readLimiter, requireAuth(), (req, res) => {
  return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Account settings — Infinitely Wiki</title>
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <header class="site-header">
    <a href="/" class="site-logo">🌐 Infinitely Wiki</a>
    <a href="https://discord.gg/HmKesPxYqY" class="header-discord-link" target="_blank" rel="noopener noreferrer">Discord</a>
  </header>
  <main class="profile-page">
    <section class="profile-card">
      <h1>Account settings</h1>
      <p class="profile-meta">Manage your Pro access and profile picture.</p>
      <form id="settings-pro-form" class="auth-form">
        <label for="settings-pro-key">Redeem Pro key</label>
        <input id="settings-pro-key" class="search-input" type="text" maxlength="64" placeholder="Enter Pro key" />
        <button class="search-btn" type="submit">Redeem key</button>
      </form>
      <p id="settings-pro-message" class="error-msg hidden" role="status"></p>
      <form id="settings-avatar-form" class="auth-form">
        <label for="settings-avatar-url">Profile picture URL</label>
        <input id="settings-avatar-url" class="search-input" type="url" maxlength="${MAX_PROFILE_PICTURE_URL_LENGTH}" placeholder="https://example.com/avatar.png" />
        <button class="search-btn" type="submit">Save profile picture</button>
      </form>
      <p id="settings-avatar-message" class="error-msg hidden" role="status"></p>
      <p><a class="wiki-stream-link" href="/profile">View my profile</a></p>
    </section>
  </main>
  <script>
    (() => {
      const proForm = document.getElementById('settings-pro-form');
      const proInput = document.getElementById('settings-pro-key');
      const proMessage = document.getElementById('settings-pro-message');
      const avatarForm = document.getElementById('settings-avatar-form');
      const avatarInput = document.getElementById('settings-avatar-url');
      const avatarMessage = document.getElementById('settings-avatar-message');

      function showMessage(el, text, isError) {
        el.textContent = text;
        el.classList.remove('hidden');
        el.classList.toggle('error-msg', !!isError);
        el.classList.toggle('success-msg', !isError);
      }

      async function loadSettings() {
        try {
          const res = await fetch('/api/auth/me');
          if (!res.ok) return;
          const data = await res.json();
          avatarInput.value = data.profilePictureUrl || '';
        } catch {
          // Ignore load failures.
        }
      }

      proForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const key = proInput.value.trim();
        if (!key) return;
        try {
          const res = await fetch('/api/pro/redeem', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key }),
          });
          const data = await res.json();
          if (!res.ok) {
            showMessage(proMessage, data.error || 'Could not redeem Pro key.', true);
            return;
          }
          proInput.value = '';
          showMessage(proMessage, 'Pro key redeemed successfully.', false);
        } catch {
          showMessage(proMessage, 'Network error while redeeming key.', true);
        }
      });

      avatarForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
          const res = await fetch('/api/account/profile-picture', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ profilePictureUrl: avatarInput.value.trim() }),
          });
          const data = await res.json();
          if (!res.ok) {
            showMessage(avatarMessage, data.error || 'Could not save profile picture.', true);
            return;
          }
          avatarInput.value = data.profilePictureUrl || '';
          showMessage(avatarMessage, 'Profile picture saved.', false);
        } catch {
          showMessage(avatarMessage, 'Network error while saving profile picture.', true);
        }
      });

      loadSettings();
    })();
  </script>
</body>
</html>`);
});

app.get('/u/:userId', readLimiter, requireAuth(), (req, res) => {
  const profileUserId = normalizeUserId(req.params.userId);
  if (!profileUserId) {
    return res.status(400).send('Invalid profile user.');
  }
  const profileRecord = getUserRecord(profileUserId);
  if (!profileRecord) {
    return res.status(404).send('Profile not found.');
  }

  const stats = ensureUserProgress(profileRecord);
  const badges = getUserBadges(profileRecord);
  ensureArticleActionsState(profileRecord);
  const displayName = profileRecord.username || profileUserId;
  const isCurrentUser = req.user.userId === profileUserId;
  const role = profileRecord.role || 'user';
  const createdAt = profileRecord.createdAt ? new Date(profileRecord.createdAt).toISOString().slice(0, 10) : 'Unknown';
  const profilePictureUrl = sanitizeProfilePictureUrl(profileRecord.profilePictureUrl);
  const likedItemsHtml = profileRecord.likedArticles.length > 0
    ? profileRecord.likedArticles
      .map((slug) => `<li><a class="wiki-stream-link" href="/wiki/${encodeURIComponent(slug)}">${escapeHtml(slug)}</a></li>`)
      .join('')
    : '<li class="profile-badge locked">No liked articles yet.</li>';
  const savedItemsHtml = profileRecord.savedArticles.length > 0
    ? profileRecord.savedArticles
      .map((slug) => `<li><a class="wiki-stream-link" href="/wiki/${encodeURIComponent(slug)}">${escapeHtml(slug)}</a></li>`)
      .join('')
    : '<li class="profile-badge locked">No saved articles yet.</li>';
  const badgeItemsHtml = badges.map((badge) => `
      <li class="profile-badge ${badge.earned ? 'earned' : 'locked'}">
        <strong>${escapeHtml(badge.name)}</strong>
        <span>${escapeHtml(badge.description)}</span>
        <small>${badge.progress}/${badge.threshold}</small>
      </li>
    `).join('');

  return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(displayName)} — Profile — Infinitely Wiki</title>
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <header class="site-header">
    <a href="/" class="site-logo">🌐 Infinitely Wiki</a>
    <a href="https://discord.gg/HmKesPxYqY" class="header-discord-link" target="_blank" rel="noopener noreferrer">Discord</a>
  </header>
  <main class="profile-page">
    <section class="profile-card">
      <div class="profile-header">
        ${profilePictureUrl ? `<img src="${escapeHtml(profilePictureUrl)}" alt="${escapeHtml(displayName)} profile picture" class="profile-avatar" loading="lazy" referrerpolicy="no-referrer" />` : '<div class="profile-avatar profile-avatar-fallback" aria-hidden="true">👤</div>'}
        <div>
      <h1>${escapeHtml(displayName)} ${isCurrentUser ? '(You)' : ''}</h1>
      <p class="profile-meta">Role: ${escapeHtml(role)} · Joined: ${escapeHtml(createdAt)}</p>
      ${isCurrentUser ? '<p><a class="wiki-stream-link" href="/settings">Account settings</a></p>' : ''}
        </div>
      </div>
      <div class="profile-stats">
        <div class="profile-stat"><strong>${stats.generatedArticles}</strong><span>Generated articles</span></div>
        <div class="profile-stat"><strong>${stats.infiniteScrollDiscoveries}</strong><span>Infinite-scroll discoveries</span></div>
        <div class="profile-stat"><strong>${profileRecord.likedArticles.length}</strong><span>Liked articles</span></div>
        <div class="profile-stat"><strong>${profileRecord.savedArticles.length}</strong><span>Saved articles</span></div>
      </div>
    </section>
    <section class="profile-card">
      <h2>Liked articles</h2>
      <ul class="profile-badge-list">${likedItemsHtml}</ul>
    </section>
    <section class="profile-card">
      <h2>Saved articles</h2>
      <ul class="profile-badge-list">${savedItemsHtml}</ul>
    </section>
    <section class="profile-card">
      <h2>Badges</h2>
      <ul class="profile-badge-list">
        ${badgeItemsHtml || '<li class="profile-badge locked"><strong>No badges yet</strong><span>Generate or discover articles to earn badges.</span></li>'}
      </ul>
    </section>
  </main>
  <footer class="site-footer">
    <p><a href="/">← Back to home</a></p>
  </footer>
</body>
</html>`);
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

app.post('/api/account/profile-picture', writeLimiter, requireAuth(), (req, res) => {
  const result = validateProfilePictureInput(req.body && req.body.profilePictureUrl);
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }
  req.userRecord.profilePictureUrl = result.profilePictureUrl;
  saveAuthState();
  return res.json({ success: true, profilePictureUrl: req.userRecord.profilePictureUrl });
});

// List all saved wiki pages
app.get('/api/pages', readLimiter, requireAuth(), (req, res) => {
  try {
    const pages = readWikiPageRecords().map(({ slug, title }) => {
      return { slug, title };
    });
    res.json(pages);
  } catch (err) {
    res.status(500).json({ error: 'Failed to list pages.' });
  }
});

app.get('/api/wiki/:slug/article', readLimiter, requireAuth(), (req, res) => {
  const safe = safeWikiPath(req.params.slug);
  if (!safe) {
    return res.status(400).json({ error: 'Invalid page slug.' });
  }
  if (!fs.existsSync(safe.resolved)) {
    return res.status(404).json({ error: 'Page not found.' });
  }
  const markdown = fs.readFileSync(safe.resolved, 'utf8');
  const title = extractTitle(markdown, safe.sanitized);
  const htmlContent = marked(markdown);
  const generatedBy = getArticleGeneratorInfo(safe.sanitized);
  return res.json({ slug: safe.sanitized, title, htmlContent, generatedBy });
});

app.get('/api/wiki/:slug/comments', readLimiter, requireAuth(), (req, res) => {
  const safe = safeWikiPath(req.params.slug);
  if (!safe) {
    return res.status(400).json({ error: 'Invalid page slug.' });
  }
  if (!fs.existsSync(safe.resolved)) {
    return res.status(404).json({ error: 'Page not found.' });
  }
  return res.json({ comments: listArticleComments(safe.sanitized) });
});

app.post('/api/wiki/:slug/comments', writeLimiter, requireAuth(), (req, res) => {
  const safe = safeWikiPath(req.params.slug);
  if (!safe) {
    return res.status(400).json({ error: 'Invalid page slug.' });
  }
  if (!fs.existsSync(safe.resolved)) {
    return res.status(404).json({ error: 'Page not found.' });
  }
  const result = addArticleComment(safe.sanitized, req.user.userId, req.body && req.body.body);
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }
  return res.status(201).json({ comment: listArticleComments(safe.sanitized).at(-1) || null });
});

app.get('/api/wiki/actions', readLimiter, requireAuth(), (req, res) => {
  return res.json(getArticleActionsForUser(req.userRecord));
});

app.get('/api/wiki/:slug/actions', readLimiter, requireAuth(), (req, res) => {
  const safe = safeWikiPath(req.params.slug);
  if (!safe) {
    return res.status(400).json({ error: 'Invalid page slug.' });
  }
  if (!fs.existsSync(safe.resolved)) {
    return res.status(404).json({ error: 'Page not found.' });
  }
  const actions = getArticleActionsForUser(req.userRecord);
  return res.json({
    slug: safe.sanitized,
    liked: actions.likedSlugs.includes(safe.sanitized),
    saved: actions.savedSlugs.includes(safe.sanitized),
  });
});

app.post('/api/wiki/:slug/actions', writeLimiter, requireAuth(), (req, res) => {
  const safe = safeWikiPath(req.params.slug);
  if (!safe) {
    return res.status(400).json({ error: 'Invalid page slug.' });
  }
  if (!fs.existsSync(safe.resolved)) {
    return res.status(404).json({ error: 'Page not found.' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const hasLiked = Object.hasOwn(body, 'liked');
  const hasSaved = Object.hasOwn(body, 'saved');
  if (!hasLiked && !hasSaved) {
    return res.status(400).json({ error: 'No action updates provided.' });
  }
  if (hasLiked && typeof body.liked !== 'boolean') {
    return res.status(400).json({ error: 'Invalid liked value.' });
  }
  if (hasSaved && typeof body.saved !== 'boolean') {
    return res.status(400).json({ error: 'Invalid saved value.' });
  }

  if (hasLiked) {
    updateArticleAction(req.userRecord, safe.sanitized, 'liked', body.liked);
  }
  if (hasSaved) {
    updateArticleAction(req.userRecord, safe.sanitized, 'saved', body.saved);
  }

  const actions = getArticleActionsForUser(req.userRecord);
  return res.json({
    slug: safe.sanitized,
    liked: actions.likedSlugs.includes(safe.sanitized),
    saved: actions.savedSlugs.includes(safe.sanitized),
  });
});

app.get('/api/wiki/:slug/next', readLimiter, requireAuth(), requireProInfiniteScroll, (req, res) => {
  const safe = safeWikiPath(req.params.slug);
  if (!safe) {
    return res.status(400).json({ error: 'Invalid page slug.' });
  }
  if (!fs.existsSync(safe.resolved)) {
    return res.status(404).json({ error: 'Page not found.' });
  }

  try {
    const relationshipData = getWikiRelationshipData();
    const pageRecords = relationshipData.records;
    const excludedSlugs = new Set(sanitizeCommaSeparatedSlugs(req.query.exclude));
    excludedSlugs.add(safe.sanitized);

    const relatedPages = relationshipData.graph.get(safe.sanitized) || [];
    let nextPage = pickTangentialRelatedPage(relatedPages, excludedSlugs);

    if (!nextPage) {
      const fallbackPool = pageRecords.filter((page) => !excludedSlugs.has(page.slug));
      if (fallbackPool.length > 0) {
        const fallback = fallbackPool[Math.floor(Math.random() * fallbackPool.length)];
        nextPage = { slug: fallback.slug, title: fallback.title, score: 0 };
      }
    }

    if (nextPage) {
      incrementUserProgress(req.userRecord, 'infiniteScrollDiscoveries', 1);
    }

    return res.json({
      next: nextPage
        ? { slug: nextPage.slug, title: nextPage.title, score: Math.round(nextPage.score * 10000) / 10000 }
        : null,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to pick a related page.' });
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
    recordArticleGenerator(safe.sanitized, req.user.userId);
    incrementUserProgress(req.userRecord, 'generatedArticles', 1);
    return res.json({ slug: safe.sanitized, cached: false, modelUsed, generation: quota.status });
  } catch (err) {
    console.error('Gemini API error:', err);
    return res.status(500).json({ error: 'Failed to generate article. ' + (err.message || '') });
  }
});

app.get('/discover', readLimiter, requireAuth(), requireProInfiniteScroll, (req, res) => {
  try {
    const files = fs.readdirSync(WIKI_DIR).filter((file) => file.endsWith('.md'));
    if (files.length === 0) {
      return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Discover — Infinitely Wiki</title>
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <header class="site-header">
    <a href="/" class="site-logo">🌐 Infinitely Wiki</a>
    <a href="https://discord.gg/HmKesPxYqY" class="header-discord-link" target="_blank" rel="noopener noreferrer">Discord</a>
  </header>
  <main class="profile-page">
    <section class="profile-card">
      <h1>No articles to explore yet</h1>
      <p>Generate your first article from the home page, then return here to use infinite discovery.</p>
      <p><a class="wiki-stream-link" href="/">Go to home</a></p>
    </section>
  </main>
</body>
</html>`);
    }

    const latestFile = files
      .map((file) => ({ file, mtime: fs.statSync(path.join(WIKI_DIR, file)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0].file;
    const slug = path.basename(latestFile, '.md');
    return res.redirect(`/discover/${encodeURIComponent(slug)}`);
  } catch (err) {
    return res.status(500).send('Could not load discovery page.');
  }
});

// Serve an infinite discovery page rendered as HTML
app.get('/discover/:slug', readLimiter, requireAuth(), requireProInfiniteScroll, (req, res) => {
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
  const initialGeneratedByJson = safeJsonForScript(getArticleGeneratorInfo(safe.sanitized));

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
    <a href="https://discord.gg/HmKesPxYqY" class="header-discord-link" target="_blank" rel="noopener noreferrer">Discord</a>
  </header>
  <main class="wiki-stream" id="wiki-stream">
    <div class="wiki-virtual-spacer" id="wiki-virtual-top-spacer" aria-hidden="true"></div>
    <section class="wiki-cards-container" id="wiki-cards-container" aria-live="polite"></section>
    <div class="wiki-virtual-spacer" id="wiki-virtual-bottom-spacer" aria-hidden="true"></div>
    <div class="wiki-scroll-status" id="wiki-scroll-status" aria-live="polite">Scroll down to discover a tangentially related article from your existing pages.</div>
    <div class="wiki-scroll-sentinel" id="wiki-scroll-sentinel" aria-hidden="true"></div>
  </main>
  <div
    id="discover-config"
    data-initial-slug="${escapeHtml(safe.sanitized)}"
    data-initial-title="${escapeHtml(title)}"
    data-root-margin="${escapeHtml(INFINITE_SCROLL_ROOT_MARGIN)}"
    data-comment-max-length="${MAX_COMMENT_LENGTH}"
    class="hidden"
  ></div>
  <script type="application/json" id="discover-initial-generated-by">${initialGeneratedByJson}</script>
  <template id="discover-initial-html">${htmlContent}</template>
  <footer class="site-footer">
    <p>Generated by <strong>Gemma AI</strong> via Google Gemini API. Content may be inaccurate.</p>
    <p><a href="/">← Back to search</a></p>
    <p><a href="https://discord.gg/HmKesPxYqY" target="_blank" rel="noopener noreferrer">Join our Discord</a></p>
  </footer>
  <script>
    (() => {
      const cardsContainer = document.getElementById('wiki-cards-container');
      const topSpacer = document.getElementById('wiki-virtual-top-spacer');
      const bottomSpacer = document.getElementById('wiki-virtual-bottom-spacer');
      const status = document.getElementById('wiki-scroll-status');
      const sentinel = document.getElementById('wiki-scroll-sentinel');
      const config = document.getElementById('discover-config');
      const initialHtmlTemplate = document.getElementById('discover-initial-html');
      const generatedByScript = document.getElementById('discover-initial-generated-by');
      const initialSlug = (config && config.dataset.initialSlug) || '';
      const streamTitle = (config && config.dataset.initialTitle) || initialSlug;
      const initialHtml = initialHtmlTemplate ? initialHtmlTemplate.innerHTML : '';
      const ROOT_MARGIN = (config && config.dataset.rootMargin) || '600px 0px 600px 0px';
      const COMMENT_MAX_LENGTH = Number.parseInt((config && config.dataset.commentMaxLength) || '', 10) || ${MAX_COMMENT_LENGTH};
      const initialGeneratedBy = generatedByScript ? JSON.parse(generatedByScript.textContent || 'null') : null;
      const loadedSlugs = new Set(initialSlug ? [initialSlug] : []);
      const likedSlugs = new Set();
      const savedSlugs = new Set();
      const pendingActions = new Set();
      const commentsBySlug = new Map();
      const commentsLoading = new Set();
      const commentsLoaded = new Set();
      const commentSavePending = new Set();
      const MAX_WINDOWED_CARDS = 6;
      const ESTIMATED_CARD_HEIGHT = 900;
      let currentRelationTitle = streamTitle;
      let loading = false;
      let done = false;
      const cards = [{ slug: initialSlug, title: streamTitle, htmlContent: initialHtml, label: '', showLink: false, generatedBy: initialGeneratedBy }];
      const cardHeights = [ESTIMATED_CARD_HEIGHT];

      function setStatus(text) {
        status.textContent = text;
      }

      function escapeHtml(text) {
        const div = document.createElement('div');
        div.appendChild(document.createTextNode(String(text || '')));
        return div.innerHTML;
      }

      function getActionState(action, slug) {
        return action === 'like' ? likedSlugs.has(slug) : savedSlugs.has(slug);
      }

      function setActionState(action, slug, enabled) {
        const target = action === 'like' ? likedSlugs : savedSlugs;
        if (enabled) {
          target.add(slug);
        } else {
          target.delete(slug);
        }
      }

      function getActionPendingKey(action, slug) {
        return action + ':' + slug;
      }

      function renderActionButtons(slug) {
        const liked = likedSlugs.has(slug);
        const saved = savedSlugs.has(slug);
        return '' +
          '<div class="wiki-article-actions">' +
          '<button type="button" class="wiki-action-btn' + (liked ? ' is-active' : '') + '" data-action="like" data-slug="' + escapeHtml(slug) + '" aria-pressed="' + String(liked) + '">' + (liked ? '♥ Liked' : '♡ Like') + '</button>' +
          '<button type="button" class="wiki-action-btn' + (saved ? ' is-active' : '') + '" data-action="save" data-slug="' + escapeHtml(slug) + '" aria-pressed="' + String(saved) + '">' + (saved ? '💾 Saved' : '💾 Save') + '</button>' +
          '</div>';
      }

      function renderGeneratorLine(generator) {
        if (!generator || !generator.userId) {
          return '<p class="wiki-generator-line">Generated by <span>Unknown user</span></p>';
        }
        const avatar = generator.profilePictureUrl
          ? '<img class="inline-avatar" loading="lazy" referrerpolicy="no-referrer" src="' + escapeHtml(generator.profilePictureUrl) + '" alt="">'
          : '<span class="inline-avatar inline-avatar-fallback" aria-hidden="true">👤</span>';
        return '<p class="wiki-generator-line">' + avatar + ' Generated by <a class="wiki-stream-link" href="/u/' +
          encodeURIComponent(generator.userId) + '">' + escapeHtml(generator.username || generator.userId) + '</a></p>';
      }

      function formatCommentBody(text) {
        return escapeHtml(String(text || '')).replace(/\n/g, '<br>');
      }

      function renderCommentsMarkup(slug) {
        const comments = commentsBySlug.get(slug) || [];
        if (comments.length === 0) {
          return '<p class="wiki-comments-empty">No comments yet. Start the discussion.</p>';
        }
        return comments.map((comment) => {
          const author = comment.author && comment.author.userId
            ? ((comment.author.profilePictureUrl
              ? '<img class="inline-avatar" loading="lazy" referrerpolicy="no-referrer" src="' + escapeHtml(comment.author.profilePictureUrl) + '" alt="">'
              : '<span class="inline-avatar inline-avatar-fallback" aria-hidden="true">👤</span>') +
              '<a class="wiki-stream-link" href="/u/' + encodeURIComponent(comment.author.userId) + '">' + escapeHtml(comment.author.username || comment.author.userId) + '</a>')
            : 'Unknown user';
          return '<article class="wiki-comment-item">' +
            '<p class="wiki-comment-meta">' + author + ' · ' + escapeHtml(comment.createdAt || '') + '</p>' +
            '<p class="wiki-comment-body">' + formatCommentBody(comment.body) + '</p>' +
            '</article>';
        }).join('');
      }

      function syncCommentsForSlug(slug) {
        const lists = cardsContainer.querySelectorAll('.wiki-comments-list[data-slug]');
        for (const list of lists) {
          if (list.getAttribute('data-slug') !== slug) continue;
          list.innerHTML = renderCommentsMarkup(slug);
        }
      }

      async function loadCommentsForSlug(slug) {
        if (commentsLoading.has(slug) || commentsLoaded.has(slug)) return;
        commentsLoading.add(slug);
        try {
          const res = await fetch('/api/wiki/' + encodeURIComponent(slug) + '/comments');
          if (!res.ok) return;
          const data = await res.json();
          commentsBySlug.set(slug, Array.isArray(data.comments) ? data.comments : []);
          commentsLoaded.add(slug);
          syncCommentsForSlug(slug);
        } catch (err) {
          // Ignore comment load errors and keep browsing.
        } finally {
          commentsLoading.delete(slug);
        }
      }

      async function submitComment(slug, body, textarea, button) {
        const pendingKey = 'comment:' + slug;
        if (commentSavePending.has(pendingKey)) return;
        commentSavePending.add(pendingKey);
        textarea.disabled = true;
        button.disabled = true;
        try {
          const res = await fetch('/api/wiki/' + encodeURIComponent(slug) + '/comments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body }),
          });
          const data = await res.json();
          if (!res.ok || !data.comment) {
            setStatus((data && data.error) || 'Could not post comment right now.');
            return;
          }
          const comments = commentsBySlug.get(slug) || [];
          comments.push(data.comment);
          commentsBySlug.set(slug, comments);
          commentsLoaded.add(slug);
          textarea.value = '';
          syncCommentsForSlug(slug);
        } catch (err) {
          setStatus('Could not post comment right now.');
        } finally {
          commentSavePending.delete(pendingKey);
          textarea.disabled = false;
          button.disabled = false;
        }
      }

      function syncActionButtonsForSlug(slug) {
        const buttons = cardsContainer.querySelectorAll('.wiki-action-btn[data-slug]');
        for (const button of buttons) {
          const buttonSlug = button.getAttribute('data-slug');
          if (buttonSlug !== slug) continue;
          const action = button.getAttribute('data-action');
          const active = getActionState(action, slug);
          const pending = pendingActions.has(getActionPendingKey(action, slug));
          button.classList.toggle('is-active', active);
          button.setAttribute('aria-pressed', active ? 'true' : 'false');
          button.textContent = action === 'like'
            ? (active ? '♥ Liked' : '♡ Like')
            : (active ? '💾 Saved' : '💾 Save');
          button.disabled = pending;
        }
      }

      function syncAllActionButtons() {
        const slugs = new Set();
        const buttons = cardsContainer.querySelectorAll('.wiki-action-btn[data-slug]');
        for (const button of buttons) {
          slugs.add(button.getAttribute('data-slug'));
        }
        for (const slug of slugs) {
          syncActionButtonsForSlug(slug);
        }
      }

      async function loadInitialActionState() {
        try {
          const res = await fetch('/api/wiki/actions');
          if (!res.ok) return;
          const data = await res.json();
          const liked = Array.isArray(data.likedSlugs) ? data.likedSlugs : [];
          const saved = Array.isArray(data.savedSlugs) ? data.savedSlugs : [];
          for (const slug of liked) likedSlugs.add(slug);
          for (const slug of saved) savedSlugs.add(slug);
          syncAllActionButtons();
        } catch (err) {
          // Ignore action state load failures and continue browsing.
        }
      }

      function sumCardHeights(endIndexExclusive) {
        let total = 0;
        for (let i = 0; i < endIndexExclusive; i += 1) {
          total += cardHeights[i] || ESTIMATED_CARD_HEIGHT;
        }
        return total;
      }

      function renderCardMarkup(card, index) {
        const parts = [];
        if (card.label) {
          parts.push('<p class="wiki-stream-label">' + escapeHtml(card.label) + '</p>');
        }
        if (card.showLink) {
          parts.push(
            '<p class="wiki-stream-link-wrap"><a class="wiki-stream-link" href="/wiki/' +
              encodeURIComponent(card.slug) +
              '">Open ' + escapeHtml(card.title || card.slug) + ' as a standalone page</a></p>'
          );
        }
        parts.push(renderGeneratorLine(card.generatedBy));
        parts.push(renderActionButtons(card.slug));
        parts.push(
          '<section class="wiki-talk-section">' +
            '<h2 class="wiki-talk-heading">Talk</h2>' +
            '<div class="wiki-comments-list" data-slug="' + escapeHtml(card.slug) + '">' + renderCommentsMarkup(card.slug) + '</div>' +
            '<form class="wiki-comment-form" data-slug="' + escapeHtml(card.slug) + '">' +
              '<textarea class="wiki-comment-input" name="body" maxlength="' + COMMENT_MAX_LENGTH + '" placeholder="Add a comment…" required></textarea>' +
              '<button type="submit" class="search-btn wiki-comment-submit">Post comment</button>' +
            '</form>' +
          '</section>'
        );
        parts.push(card.htmlContent || '');
        return '<article class="wiki-article wiki-article-card" data-index="' + index + '" data-slug="' + escapeHtml(card.slug) + '">' + parts.join('') + '</article>';
      }

      function renderVirtualWindow() {
        const startIndex = Math.max(0, cards.length - MAX_WINDOWED_CARDS);
        const visibleCards = cards.slice(startIndex);
        topSpacer.style.height = sumCardHeights(startIndex) + 'px';
        bottomSpacer.style.height = '0px';
        cardsContainer.innerHTML = visibleCards
          .map((card, offset) => renderCardMarkup(card, startIndex + offset))
          .join('');
        syncAllActionButtons();
        for (const card of visibleCards) {
          loadCommentsForSlug(card.slug);
        }
        requestAnimationFrame(() => {
          const rendered = cardsContainer.querySelectorAll('.wiki-article-card[data-index]');
          for (const cardElement of rendered) {
            const index = Number(cardElement.getAttribute('data-index'));
            if (!Number.isFinite(index)) continue;
            cardHeights[index] = Math.max(cardElement.offsetHeight, 1);
          }
          topSpacer.style.height = sumCardHeights(startIndex) + 'px';
        });
      }

      async function toggleAction(slug, action, nextValue) {
        const pendingKey = getActionPendingKey(action, slug);
        pendingActions.add(pendingKey);
        syncActionButtonsForSlug(slug);
        try {
          const payload = action === 'like' ? { liked: nextValue } : { saved: nextValue };
          const res = await fetch('/api/wiki/' + encodeURIComponent(slug) + '/actions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          if (!res.ok) {
            setStatus('Could not update article actions right now.');
            return;
          }
          const data = await res.json();
          if (typeof data.liked === 'boolean') {
            setActionState('like', slug, data.liked);
          }
          if (typeof data.saved === 'boolean') {
            setActionState('save', slug, data.saved);
          }
          syncActionButtonsForSlug(slug);
        } catch (err) {
          setStatus('Could not update article actions right now.');
        } finally {
          pendingActions.delete(pendingKey);
          syncActionButtonsForSlug(slug);
        }
      }

      async function loadNextTangentialPage() {
        if (loading || done) return;
        loading = true;
        setStatus('Finding a tangentially related article…');
        try {
          const exclude = Array.from(loadedSlugs).join(',');
          const currentSlug = Array.from(loadedSlugs).at(-1);
          const nextRes = await fetch('/api/wiki/' + encodeURIComponent(currentSlug) + '/next?exclude=' + encodeURIComponent(exclude));
          if (!nextRes.ok) {
            setStatus('Could not load more articles right now.');
            loading = false;
            return;
          }
          const nextData = await nextRes.json();
          const next = nextData && nextData.next;
          if (!next || !next.slug || loadedSlugs.has(next.slug)) {
            done = true;
            setStatus('No more existing related articles to show.');
            loading = false;
            return;
          }

          const articleRes = await fetch('/api/wiki/' + encodeURIComponent(next.slug) + '/article');
          if (!articleRes.ok) {
            setStatus('Could not load more articles right now.');
            loading = false;
            return;
          }
          const articleData = await articleRes.json();
          if (!articleData || !articleData.slug || !articleData.htmlContent) {
            setStatus('Could not load more articles right now.');
            loading = false;
            return;
          }

          loadedSlugs.add(articleData.slug);
          const label = 'Tangentially related to ' + currentRelationTitle;
          cards.push({
            slug: articleData.slug,
            title: articleData.title || articleData.slug,
            htmlContent: articleData.htmlContent,
            label,
            showLink: true,
            generatedBy: articleData.generatedBy || null,
          });
          cardHeights.push(ESTIMATED_CARD_HEIGHT);
          currentRelationTitle = articleData.title || articleData.slug;
          renderVirtualWindow();
          setStatus('Scroll for another related article.');
        } catch (err) {
          setStatus('Could not load more articles right now.');
        } finally {
          loading = false;
        }
      }

      const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            loadNextTangentialPage();
          }
        }
      }, { rootMargin: ROOT_MARGIN });

      cardsContainer.addEventListener('click', (event) => {
        const button = event.target.closest('.wiki-action-btn');
        if (!button) return;
        const slug = button.getAttribute('data-slug');
        const action = button.getAttribute('data-action');
        if (!slug || (action !== 'like' && action !== 'save')) return;
        const nextValue = !getActionState(action, slug);
        toggleAction(slug, action, nextValue);
      });

      cardsContainer.addEventListener('submit', (event) => {
        const form = event.target.closest('.wiki-comment-form');
        if (!form) return;
        event.preventDefault();
        const slug = form.getAttribute('data-slug');
        const textarea = form.querySelector('.wiki-comment-input');
        const button = form.querySelector('.wiki-comment-submit');
        if (!slug || !textarea || !button) return;
        const body = textarea.value.trim();
        if (!body) return;
        submitComment(slug, body, textarea, button);
      });

      renderVirtualWindow();
      loadInitialActionState();
      observer.observe(sentinel);
    })();
  </script>
</body>
</html>`);
});

// Serve a single wiki article page (without infinite discovery)
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
  const generator = getArticleGeneratorInfo(safe.sanitized);
  const generatorJson = safeJsonForScript(generator);
  const commentMaxLengthAttr = String(MAX_COMMENT_LENGTH);
  const canUseInfiniteScroll = userCanUseInfiniteScroll(req.user);

  return res.send(`<!DOCTYPE html>
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
    <a href="https://discord.gg/HmKesPxYqY" class="header-discord-link" target="_blank" rel="noopener noreferrer">Discord</a>
  </header>
  <main class="wiki-article">
    <p class="wiki-generator-line" id="wiki-generator-line"></p>
    <div class="wiki-article-actions">
      <button type="button" class="wiki-action-btn" id="wiki-like-btn" aria-pressed="false">♡ Like</button>
      <button type="button" class="wiki-action-btn" id="wiki-save-btn" aria-pressed="false">💾 Save</button>
      ${canUseInfiniteScroll
    ? `<a class="wiki-stream-link" href="/discover/${encodeURIComponent(safe.sanitized)}">Open in Infinite Discovery</a>`
    : '<a class="wiki-stream-link" href="/settings">Infinite Discovery is Pro-only</a>'}
    </div>
    <section class="wiki-talk-section">
      <h2 class="wiki-talk-heading">Talk</h2>
      <div class="wiki-comments-list" id="wiki-comments-list"></div>
      <form class="wiki-comment-form" id="wiki-comment-form">
        <textarea class="wiki-comment-input" id="wiki-comment-input" maxlength="${commentMaxLengthAttr}" placeholder="Add a comment…" required></textarea>
        <button type="submit" class="search-btn wiki-comment-submit" id="wiki-comment-submit">Post comment</button>
      </form>
    </section>
    ${htmlContent}
  </main>
  <div id="wiki-page-config" data-slug="${escapeHtml(safe.sanitized)}" class="hidden"></div>
  <script type="application/json" id="wiki-generator-json">${generatorJson}</script>
  <footer class="site-footer">
    <p>Generated by <strong>Gemma AI</strong> via Google Gemini API. Content may be inaccurate.</p>
    <p><a href="/">← Back to search</a></p>
    ${canUseInfiniteScroll
    ? `<p><a href="/discover/${encodeURIComponent(safe.sanitized)}">Start infinite discovery from this article</a></p>`
    : '<p><a href="/settings">Upgrade to Pro to start infinite discovery</a></p>'}
  </footer>
  <script>
    (() => {
      const config = document.getElementById('wiki-page-config');
      const slug = (config && config.dataset.slug) || '';
      const generatorScript = document.getElementById('wiki-generator-json');
      const generator = generatorScript ? JSON.parse(generatorScript.textContent || 'null') : null;
      const generatorLine = document.getElementById('wiki-generator-line');
      const likeBtn = document.getElementById('wiki-like-btn');
      const saveBtn = document.getElementById('wiki-save-btn');
      const commentsList = document.getElementById('wiki-comments-list');
      const commentForm = document.getElementById('wiki-comment-form');
      const commentInput = document.getElementById('wiki-comment-input');
      const commentSubmit = document.getElementById('wiki-comment-submit');

      let liked = false;
      let saved = false;

      function escapeHtml(text) {
        const div = document.createElement('div');
        div.appendChild(document.createTextNode(String(text || '')));
        return div.innerHTML;
      }

      function syncButtons() {
        likeBtn.classList.toggle('is-active', liked);
        saveBtn.classList.toggle('is-active', saved);
        likeBtn.setAttribute('aria-pressed', liked ? 'true' : 'false');
        saveBtn.setAttribute('aria-pressed', saved ? 'true' : 'false');
        likeBtn.textContent = liked ? '♥ Liked' : '♡ Like';
        saveBtn.textContent = saved ? '💾 Saved' : '💾 Save';
      }

      function renderGenerator() {
        if (!generator || !generator.userId) {
          generatorLine.textContent = 'Generated by Unknown user';
          return;
        }
        const avatar = generator.profilePictureUrl
          ? '<img class="inline-avatar" loading="lazy" referrerpolicy="no-referrer" src="' + escapeHtml(generator.profilePictureUrl) + '" alt="">'
          : '<span class="inline-avatar inline-avatar-fallback" aria-hidden="true">👤</span>';
        generatorLine.innerHTML = avatar + ' Generated by <a class="wiki-stream-link" href="/u/' +
          encodeURIComponent(generator.userId) + '">' + escapeHtml(generator.username || generator.userId) + '</a>';
      }

      function formatCommentBody(text) {
        return escapeHtml(text).replace(/\n/g, '<br>');
      }

      function renderComments(comments) {
        if (!Array.isArray(comments) || comments.length === 0) {
          commentsList.innerHTML = '<p class="wiki-comments-empty">No comments yet. Start the discussion.</p>';
          return;
        }
        commentsList.innerHTML = comments.map((comment) => {
          const author = comment.author && comment.author.userId
            ? ((comment.author.profilePictureUrl
              ? '<img class="inline-avatar" loading="lazy" referrerpolicy="no-referrer" src="' + escapeHtml(comment.author.profilePictureUrl) + '" alt="">'
              : '<span class="inline-avatar inline-avatar-fallback" aria-hidden="true">👤</span>') +
              '<a class="wiki-stream-link" href="/u/' + encodeURIComponent(comment.author.userId) + '">' + escapeHtml(comment.author.username || comment.author.userId) + '</a>')
            : 'Unknown user';
          return '<article class="wiki-comment-item">' +
            '<p class="wiki-comment-meta">' + author + ' · ' + escapeHtml(comment.createdAt || '') + '</p>' +
            '<p class="wiki-comment-body">' + formatCommentBody(comment.body || '') + '</p>' +
            '</article>';
        }).join('');
      }

      async function refreshActions() {
        const res = await fetch('/api/wiki/' + encodeURIComponent(slug) + '/actions');
        if (!res.ok) return;
        const data = await res.json();
        liked = !!data.liked;
        saved = !!data.saved;
        syncButtons();
      }

      async function refreshComments() {
        const res = await fetch('/api/wiki/' + encodeURIComponent(slug) + '/comments');
        if (!res.ok) return;
        const data = await res.json();
        renderComments(data.comments || []);
      }

      async function updateAction(payload) {
        const res = await fetch('/api/wiki/' + encodeURIComponent(slug) + '/actions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) return;
        const data = await res.json();
        liked = !!data.liked;
        saved = !!data.saved;
        syncButtons();
      }

      likeBtn.addEventListener('click', () => updateAction({ liked: !liked }));
      saveBtn.addEventListener('click', () => updateAction({ saved: !saved }));
      commentForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const body = commentInput.value.trim();
        if (!body) return;
        commentInput.disabled = true;
        commentSubmit.disabled = true;
        try {
          const res = await fetch('/api/wiki/' + encodeURIComponent(slug) + '/comments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body }),
          });
          if (res.ok) {
            commentInput.value = '';
            await refreshComments();
          }
        } finally {
          commentInput.disabled = false;
          commentSubmit.disabled = false;
        }
      });

      renderGenerator();
      refreshActions();
      refreshComments();
    })();
  </script>
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

function safeJsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

app.listen(PORT, HOST, () => {
  const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`Infinitely Wiki server running at http://${displayHost}:${PORT}`);
});

module.exports = app;
