# infinitely-wiki

An AI-powered encyclopedia that generates Wikipedia-style articles on any topic using **Gemma** via the Google Gemini API.

## Features

- 🔍 Search bar on the landing page — type any topic to generate an article
- 📄 Articles are written in Markdown and rendered as HTML
- ⚠️ Every article displays an AI-generated content warning banner at the top
- 💾 Generated articles are saved to disk and served on subsequent visits without re-generating
- 🗂️ Landing page lists all previously generated articles

## Prerequisites

- Node.js 18+
- A Google Gemini API key ([get one here](https://aistudio.google.com/app/apikey))

## Setup

```bash
# Install dependencies
npm install

# Set your Gemini API key
export GEMINI_API_KEY=your_api_key_here

# Configure Clerk auth
export CLERK_SECRET_KEY=your_clerk_secret_key
export CLERK_PUBLISHABLE_KEY=your_clerk_publishable_key

# Comma-separated Clerk user IDs that should be Admins
export ADMIN_USER_IDS=user_abc123,user_def456

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
- **Admin account**: any Clerk user whose ID appears in `ADMIN_USER_IDS`
- **User account**: any other signed-in Clerk user (must sign up before first use)
- Generation rate limits are role-based:
  - Admin: `20` requests/minute by default
  - User: `5` requests/minute by default

## Environment Variables

| Variable | Description |
|---|---|
| `GEMINI_API_KEY` | Google Gemini API key (required) |
| `GOOGLE_API_KEY` | Alternative name for the API key |
| `CLERK_SECRET_KEY` | Clerk backend secret key (required for auth verification) |
| `CLERK_PUBLISHABLE_KEY` | Clerk frontend publishable key (required for browser auth) |
| `ADMIN_USER_IDS` | Comma-separated Clerk user IDs treated as Admin accounts |
| `GEMMA_PRIMARY_MODEL` | Primary generation model (default: `gemma-4-27b-it`) |
| `GEMMA_FALLBACK_MODEL` | Fallback model if primary fails (default: `gemma-3-27b-it`) |
| `ADMIN_GENERATE_LIMIT` | Admin generation requests per minute (default: `20`) |
| `USER_GENERATE_LIMIT` | User generation requests per minute (default: `5`) |
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
