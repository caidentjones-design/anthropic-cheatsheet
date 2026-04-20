# Anthropic Cheat Sheet

An auto-updating reference guide to every Anthropic product, feature, and tool. Runs weekly, detects what changed, summarizes it, and publishes to a docs site.

Built by Caiden Jones. Maintained by Claude.

## What it does

1. Every Monday at 9am PT, a GitHub Action fires.
2. It scrapes a list of Anthropic pages (docs, news, product pages).
3. It hashes each page and compares against the last run to see what changed.
4. For changed or new pages, it calls the Claude API to write a summary following a strict template.
5. Each summary includes a "Verdict application" section with ideas for how to use that feature in the Verdict app.
6. The results are committed to `/docs/` and deployed as a static site via GitHub Pages.

## Setup

### 1. Create the repo

```bash
cd anthropic-cheatsheet
git init
git add .
git commit -m "Initial commit"
gh repo create anthropic-cheatsheet --public --source=. --push
```

### 2. Add secrets

In GitHub repo settings → Secrets and variables → Actions, add:

- `ANTHROPIC_API_KEY` — from console.anthropic.com

### 3. Enable GitHub Pages

Settings → Pages → Source: `GitHub Actions`

### 4. First run

Actions tab → "Update cheat sheet" → Run workflow. This seeds the initial summaries. Takes ~5-10 minutes.

### 5. Install locally (optional, for testing)

```bash
npm install
npm run update          # Run the update pipeline locally
npm run serve           # Serve docs site locally (requires Python + mkdocs)
```

## Cost

- GitHub Actions: free (well under the 2000 min/mo limit)
- GitHub Pages: free (public repo)
- Claude API: ~$2–5/month depending on how much Anthropic ships

## Files

- `scripts/scrape.js` — fetches each source URL
- `scripts/diff.js` — detects what changed since last run
- `scripts/summarize.js` — calls Claude API, writes markdown
- `scripts/sources.json` — the list of URLs to watch
- `state/hashes.json` — snapshot of last known content (committed)
- `docs/` — the cheat sheet itself
- `.github/workflows/update.yml` — the weekly cron

## Adding a new source

Edit `scripts/sources.json`, add the URL + category, commit. Next run will pick it up.
