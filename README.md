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

# Configure accounts (recommended)
export ADMIN_USERNAME=admin
export ADMIN_PASSWORD=change_me_admin
export USER_USERNAME=user
export USER_PASSWORD=change_me_user

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

- **Admin account**: can generate new articles and view existing pages
- **User account**: can view existing pages
- Sign in is required before using the app
- If env vars are not set, local defaults are used:
  - Admin: `admin` / `admin123`
  - User: `user` / `user123`

## Environment Variables

| Variable | Description |
|---|---|
| `GEMINI_API_KEY` | Google Gemini API key (required) |
| `GOOGLE_API_KEY` | Alternative name for the API key |
| `GEMMA_PRIMARY_MODEL` | Primary generation model (default: `gemma-4-27b-it`) |
| `GEMMA_FALLBACK_MODEL` | Fallback model if primary fails (default: `gemma-3-27b-it`) |
| `ADMIN_USERNAME` | Admin username |
| `ADMIN_PASSWORD` | Admin password |
| `USER_USERNAME` | User username |
| `USER_PASSWORD` | User password |
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
