# infinitely-wiki

An AI-powered encyclopedia that generates Wikipedia-style articles on any topic using **Gemma** via the Google Gemini API.

## Features

- 🔍 Search bar on the landing page — type any topic to generate an article
- 📄 Articles are written in Markdown and rendered as HTML
- ⚠️ Every article displays an AI-generated content warning banner at the top
- 💾 Generated articles are saved to disk and served on subsequent visits without re-generating
- 🗂️ Landing page lists all previously generated articles
- 🛡️ First authenticated user is auto-assigned Admin
- 🧰 Admin Panel for promoting users to admin and generating Pro keys
- 🔑 Pro plan keys can be generated as monthly, annual, or permanent and redeemed by users
- 📊 Monthly generation quotas by plan (Free vs Pro), plus higher admin request throughput

## Prerequisites

- Node.js 18+
- A Google Gemini API key ([get one here](https://aistudio.google.com/app/apikey))

## Setup

```bash
# Install dependencies
npm install

# Copy the environment template and fill in your keys
cp .env.example .env
# Edit .env with your Gemini API key, Clerk keys, and any optional settings

# Start the server
npm start
```

The server starts at **http://localhost:3000** (override with `PORT` env var).

## Usage

1. Open http://localhost:3000
2. Type any topic in the search bar and click **Generate**
3. The server calls the Gemma AI model and saves the article as a Markdown file in `wiki-pages/`
4. You are redirected to the rendered article page with an AI warning banner
5. Previously generated articles appear in the "Recently Generated Articles" list

### Accounts and Permissions

- Authentication is handled by **Clerk** (sign up and sign in)
- **Admin account**:
  - The first authenticated user is automatically assigned admin
  - Existing admins can promote other users to admin in `/admin`
  - Any Clerk user in `ADMIN_USER_IDS` is always treated as admin
- **Pro plan**:
  - Admins generate keys in `/admin`
  - Key types: `monthly` (default), `annual`, `permanent`
  - Users redeem keys from the home page
- Generation limits:
  - Admin: `50` requests/minute by default
  - Free users: `10` generations/month
  - Pro users: `100` generations/month

## Environment Variables

This app loads environment variables from `.env` using `dotenv`.

| Variable | Description |
|---|---|
| `GEMINI_API_KEY` | Google Gemini API key (required) |
| `GOOGLE_API_KEY` | Alternative name for the API key |
| `CLERK_SECRET_KEY` | Clerk backend secret key (required for auth verification) |
| `CLERK_PUBLISHABLE_KEY` | Clerk frontend publishable key (required for browser auth) |
| `ADMIN_USER_IDS` | Comma-separated Clerk user IDs treated as Admin accounts |
| `GEMMA_PRIMARY_MODEL` | Primary generation model (default: `gemma-4-27b-it`) |
| `GEMMA_FALLBACK_MODEL` | Fallback model if primary fails (default: `gemma-3-27b-it`) |
| `ADMIN_GENERATE_LIMIT` | Admin generation requests per minute (default: `50`) |
| `USER_GENERATE_MONTHLY_LIMIT` | Free user generations per month (default: `10`) |
| `PRO_GENERATE_MONTHLY_LIMIT` | Pro user generations per month (default: `100`) |
| `PORT` | Port to listen on (default: `3000`) |
| `HOST` | Host address to bind to (default: `0.0.0.0`) |

## Project Structure

```
infinitely-wiki/
├── server.js          # Express server
├── public/
│   ├── index.html     # Landing page with search bar
│   └── style.css      # Wikipedia-inspired styles
├── wiki-pages/        # Saved Markdown articles
└── package.json
```
