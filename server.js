'use strict';

const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { marked } = require('marked');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const WIKI_DIR = path.join(__dirname, 'wiki-pages');
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const PRIMARY_MODEL = process.env.GEMMA_PRIMARY_MODEL || 'gemma-4-27b-it';
const FALLBACK_MODEL = process.env.GEMMA_FALLBACK_MODEL || 'gemma-3-27b-it';
const SESSION_COOKIE = 'wiki_auth';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const USER_USERNAME = process.env.USER_USERNAME || 'user';
const USER_PASSWORD = process.env.USER_PASSWORD || 'user123';

// Ensure wiki-pages directory exists
if (!fs.existsSync(WIKI_DIR)) {
  fs.mkdirSync(WIKI_DIR, { recursive: true });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiters
const readLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

const generateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many generation requests. Please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication requests. Please try again later.' },
});

const accountRecords = [
  createAccountRecord('admin', ADMIN_USERNAME, ADMIN_PASSWORD),
  createAccountRecord('user', USER_USERNAME, USER_PASSWORD),
];

const sessions = new Map();

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

function createAccountRecord(role, username, password) {
  const salt = crypto.randomBytes(16);
  return {
    role,
    username,
    salt,
    hash: crypto.scryptSync(password, salt, 64),
  };
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return header.split(';').reduce((acc, chunk) => {
    const idx = chunk.indexOf('=');
    if (idx === -1) return acc;
    const key = chunk.slice(0, idx).trim();
    const value = chunk.slice(idx + 1).trim();
    if (key) acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
}

function authenticateUser(username, password) {
  for (const account of accountRecords) {
    if (account.username !== username) continue;
    const attempted = crypto.scryptSync(password, account.salt, 64);
    if (crypto.timingSafeEqual(attempted, account.hash)) {
      return { username: account.username, role: account.role };
    }
    return null;
  }
  return null;
}

function issueSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, { ...user, expiresAt });
  return token;
}

function getSessionFromRequest(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { token, user: { username: session.username, role: session.role } };
}

function requireAuth(allowedRoles = []) {
  return (req, res, next) => {
    const session = getSessionFromRequest(req);
    if (!session) {
      if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Authentication required.' });
      }
      return res.redirect('/');
    }

    if (allowedRoles.length > 0 && !allowedRoles.includes(session.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions.' });
    }

    req.user = session.user;
    req.sessionToken = session.token;
    return next();
  };
}

async function generateArticleWithFallback(genAI, prompt) {
  const primary = genAI.getGenerativeModel({ model: PRIMARY_MODEL });

  try {
    const result = await primary.generateContent(prompt);
    return { text: result.response.text(), modelUsed: PRIMARY_MODEL };
  } catch (primaryErr) {
    if (FALLBACK_MODEL === PRIMARY_MODEL) throw primaryErr;

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

app.post('/api/auth/login', authLimiter, (req, res) => {
  const username = req.body && req.body.username ? String(req.body.username).trim() : '';
  const password = req.body && req.body.password ? String(req.body.password) : '';

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  if (username.length > 100 || password.length > 200) {
    return res.status(400).json({ error: 'Invalid username or password length.' });
  }

  const user = authenticateUser(username, password);
  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  const token = issueSession(user);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const cookieParts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) cookieParts.push('Secure');
  res.setHeader('Set-Cookie', cookieParts.join('; '));

  return res.json({
    username: user.username,
    role: user.role,
  });
});

app.post('/api/auth/logout', requireAuth(), (req, res) => {
  if (req.sessionToken) sessions.delete(req.sessionToken);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
  return res.status(204).send();
});

app.get('/api/auth/me', requireAuth(), (req, res) => {
  return res.json(req.user);
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
app.post('/api/generate', generateLimiter, requireAuth(['admin']), async (req, res) => {
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
    return res.json({ slug: safe.sanitized, cached: true });
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

    // Prepend the AI warning banner
    const banner = `> ⚠️ **AI-Generated Content** — This article was created by an AI (Gemma). It may contain inaccuracies. Do not rely on it as a factual reference.\n\n`;
    const fullContent = banner + text;

    fs.writeFileSync(safe.resolved, fullContent, 'utf8');
    return res.json({ slug: safe.sanitized, cached: false, modelUsed });
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
