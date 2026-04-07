'use strict';

const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { clerkMiddleware, getAuth } = require('@clerk/express');
const { marked } = require('marked');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const WIKI_DIR = path.join(__dirname, 'wiki-pages');
const DATA_DIR = path.join(__dirname, 'data');
const AUTH_STATE_FILE = path.join(DATA_DIR, 'auth-state.json');
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const PRIMARY_MODEL = process.env.GEMMA_PRIMARY_MODEL || 'gemma-4-27b-it';
const FALLBACK_MODEL = process.env.GEMMA_FALLBACK_MODEL || 'gemma-3-27b-it';
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY || '';
const CLERK_PUBLISHABLE_KEY = process.env.CLERK_PUBLISHABLE_KEY || '';
const ADMIN_USER_IDS = new Set(
  (process.env.ADMIN_USER_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
);
const ADMIN_GENERATE_LIMIT = Number(process.env.ADMIN_GENERATE_LIMIT || 50);
const PRO_GENERATE_MONTHLY_LIMIT = Number(process.env.PRO_GENERATE_MONTHLY_LIMIT || 100);
const USER_GENERATE_MONTHLY_LIMIT = Number(process.env.USER_GENERATE_MONTHLY_LIMIT || 10);

// Ensure wiki-pages directory exists
if (!fs.existsSync(WIKI_DIR)) {
  fs.mkdirSync(WIKI_DIR, { recursive: true });
}
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!CLERK_SECRET_KEY) {
  throw new Error('CLERK_SECRET_KEY environment variable is required.');
}

app.use(express.json());
app.use(clerkMiddleware());
app.use(express.static(path.join(__dirname, 'public')));

function loadAuthState() {
  if (!fs.existsSync(AUTH_STATE_FILE)) {
    return { users: {}, proKeys: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(AUTH_STATE_FILE, 'utf8'));
    return {
      users: parsed.users && typeof parsed.users === 'object' ? parsed.users : {},
      proKeys: parsed.proKeys && typeof parsed.proKeys === 'object' ? parsed.proKeys : {},
    };
  } catch {
    return { users: {}, proKeys: {} };
  }
}

let authState = loadAuthState();

function saveAuthState() {
  fs.writeFileSync(AUTH_STATE_FILE, JSON.stringify(authState, null, 2), 'utf8');
}

function getCurrentMonthKey() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function isFutureIso(value) {
  if (!value) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time > Date.now();
}

function getPlanForUser(record) {
  if (record.proPermanent) {
    return {
      name: 'pro',
      isPro: true,
      isPermanent: true,
      expiresAt: null,
    };
  }
  if (isFutureIso(record.proExpiresAt)) {
    return {
      name: 'pro',
      isPro: true,
      isPermanent: false,
      expiresAt: record.proExpiresAt,
    };
  }
  if (record.proExpiresAt) {
    record.proExpiresAt = null;
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
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 128);
}

function hasAdmin() {
  return Object.values(authState.users).some((user) => user.role === 'admin');
}

function ensureUserRecord(userId) {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) return null;

  if (!authState.users[normalizedUserId]) {
    authState.users[normalizedUserId] = {
      role: 'user',
      proExpiresAt: null,
      proPermanent: false,
      generationUsage: { month: getCurrentMonthKey(), count: 0 },
      createdAt: new Date().toISOString(),
    };
  }

  const userRecord = authState.users[normalizedUserId];
  if (ADMIN_USER_IDS.has(normalizedUserId) && userRecord.role !== 'admin') {
    userRecord.role = 'admin';
  } else if (!hasAdmin()) {
    userRecord.role = 'admin';
  }

  saveAuthState();
  return userRecord;
}

function getMonthlyGenerationLimit(user) {
  if (user.role === 'admin') return null;
  return user.plan?.isPro ? PRO_GENERATE_MONTHLY_LIMIT : USER_GENERATE_MONTHLY_LIMIT;
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

function getGenerationStatus(user, record) {
  const monthlyLimit = getMonthlyGenerationLimit(user);
  const usage = normalizeGenerationUsage(record);
  return {
    monthlyLimit,
    monthlyUsed: usage.count,
    monthlyRemaining: monthlyLimit === null ? null : Math.max(0, monthlyLimit - usage.count),
    month: usage.month,
  };
}

function consumeGenerationQuota(user, record) {
  const monthlyLimit = getMonthlyGenerationLimit(user);
  if (monthlyLimit === null) {
    return { allowed: true, status: getGenerationStatus(user, record) };
  }
  const usage = normalizeGenerationUsage(record);
  if (usage.count >= monthlyLimit) {
    return { allowed: false, status: getGenerationStatus(user, record) };
  }
  usage.count += 1;
  record.generationUsage = usage;
  saveAuthState();
  return { allowed: true, status: getGenerationStatus(user, record) };
}

function makeProKey() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const randomChunk = () =>
    Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  let key = `PRO-${randomChunk()}-${randomChunk()}-${randomChunk()}`;
  while (authState.proKeys[key]) {
    key = `PRO-${randomChunk()}-${randomChunk()}-${randomChunk()}`;
  }
  return key;
}

// Rate limiters
const readLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

app.get('/clerk.browser.js', readLimiter, (req, res) => {
  return res.sendFile(path.join(__dirname, 'node_modules', '@clerk', 'clerk-js', 'dist', 'clerk.browser.js'));
});

const adminGenerateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: ADMIN_GENERATE_LIMIT,
  keyGenerator: (req) => getAuth(req).userId || ipKeyGenerator(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Admin generation limit reached. Please try again later.' },
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
    const auth = getAuth(req);
    if (!auth?.userId) {
      if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Authentication required.' });
      }
      return res.redirect('/');
    }

    const userRecord = ensureUserRecord(auth.userId);
    if (!userRecord) {
      return res.status(400).json({ error: 'Invalid user.' });
    }

    const role = userRecord.role;
    if (allowedRoles.length > 0 && !allowedRoles.includes(role)) {
      return res.status(403).json({ error: 'Insufficient permissions.' });
    }

    req.user = {
      userId: auth.userId,
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

app.get('/api/auth/config', (req, res) => {
  if (!CLERK_PUBLISHABLE_KEY) {
    return res.status(500).json({ error: 'CLERK_PUBLISHABLE_KEY environment variable is not set.' });
  }
  return res.json({ publishableKey: CLERK_PUBLISHABLE_KEY });
});

app.get('/api/auth/me', requireAuth(), (req, res) => {
  return res.json({
    userId: req.user.userId,
    role: req.user.role,
    plan: req.user.plan,
    generation: getGenerationStatus(req.user, req.userRecord),
  });
});

app.get('/admin', requireAuth(['admin']), (req, res) => {
  return res.sendFile(path.join(__dirname, 'admin-panel.html'));
});

app.get('/api/admin/overview', requireAuth(['admin']), (req, res) => {
  const users = Object.entries(authState.users).map(([userId, user]) => ({
    userId,
    role: user.role,
    plan: getPlanForUser(user),
    generation: getGenerationStatus(
      { role: user.role, plan: getPlanForUser(user) },
      user
    ),
    createdAt: user.createdAt || null,
  }));
  const proKeys = Object.values(authState.proKeys).sort((a, b) => {
    const aTime = Date.parse(a.createdAt || '') || 0;
    const bTime = Date.parse(b.createdAt || '') || 0;
    return bTime - aTime;
  });
  return res.json({ users, proKeys });
});

app.post('/api/admin/users/promote', requireAuth(['admin']), (req, res) => {
  const targetUserId = normalizeUserId(req.body && req.body.userId);
  if (!targetUserId) {
    return res.status(400).json({ error: 'Valid userId is required.' });
  }
  const target = ensureUserRecord(targetUserId);
  target.role = 'admin';
  saveAuthState();
  return res.json({ userId: targetUserId, role: target.role });
});

app.post('/api/admin/pro-keys', requireAuth(['admin']), (req, res) => {
  const requestedDuration = String((req.body && req.body.duration) || 'monthly').toLowerCase();
  const duration = ['monthly', 'annual', 'permanent'].includes(requestedDuration)
    ? requestedDuration
    : null;
  if (!duration) {
    return res.status(400).json({ error: 'Duration must be monthly, annual, or permanent.' });
  }

  const key = makeProKey();
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

app.post('/api/pro/redeem', requireAuth(), (req, res) => {
  const key = String((req.body && req.body.key) || '').trim().toUpperCase();
  if (!key) {
    return res.status(400).json({ error: 'Key is required.' });
  }
  const keyRecord = authState.proKeys[key];
  if (!keyRecord) {
    return res.status(404).json({ error: 'Invalid key.' });
  }
  if (keyRecord.redeemedBy) {
    return res.status(409).json({ error: 'This key has already been redeemed.' });
  }

  const userRecord = req.userRecord;
  if (userRecord.proPermanent) {
    return res.status(409).json({ error: 'You already have a permanent Pro plan.' });
  }

  if (keyRecord.duration === 'permanent') {
    userRecord.proPermanent = true;
    userRecord.proExpiresAt = null;
  } else {
    const now = Date.now();
    const current = Date.parse(userRecord.proExpiresAt || '');
    const base = Number.isFinite(current) && current > now ? new Date(current) : new Date();
    if (keyRecord.duration === 'annual') {
      base.setMonth(base.getMonth() + 12);
    } else {
      base.setMonth(base.getMonth() + 1);
    }
    userRecord.proExpiresAt = base.toISOString();
  }

  keyRecord.redeemedBy = req.user.userId;
  keyRecord.redeemedAt = new Date().toISOString();
  saveAuthState();

  return res.json({
    success: true,
    plan: getPlanForUser(userRecord),
    generation: getGenerationStatus(
      { role: userRecord.role, plan: getPlanForUser(userRecord) },
      userRecord
    ),
    redeemedKey: {
      key: keyRecord.key,
      duration: keyRecord.duration,
      redeemedAt: keyRecord.redeemedAt,
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
    return res.json({ slug: safe.sanitized, cached: true, generation: getGenerationStatus(req.user, req.userRecord) });
  }

  const quota = consumeGenerationQuota(req.user, req.userRecord);
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
