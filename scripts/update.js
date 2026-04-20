/**
 * Main pipeline: scrape → diff → summarize → write → commit.
 * Called by GitHub Actions weekly.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { parse } from 'node-html-parser';
import crypto from 'node:crypto';

const ROOT = path.resolve(process.cwd());
const SOURCES_PATH = path.join(ROOT, 'scripts', 'sources.json');
const HASH_PATH = path.join(ROOT, 'state', 'hashes.json');
const DOCS_DIR = path.join(ROOT, 'docs');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------- scrape ----------

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AnthropicCheatSheetBot/1.0)',
    },
  });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  const html = await res.text();
  return extractText(html);
}

function extractText(html) {
  const root = parse(html);
  // Strip things that add noise and change frequently.
  root.querySelectorAll('script, style, nav, footer, header, svg, noscript').forEach(n => n.remove());
  // Prefer main content containers when present.
  const main = root.querySelector('main') || root.querySelector('article') || root.querySelector('[role="main"]') || root;
  const text = main.text.replace(/\s+/g, ' ').trim();
  return text.slice(0, 20000); // cap per-page token usage
}

function hash(str) {
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

// ---------- summarize ----------

const TEMPLATE_PROMPT = `You are writing a single-page cheat sheet entry about an Anthropic product, feature, or tool for Caiden, a 10th-grade developer building two apps: Verdict (AI-powered argument judge, iOS) and True Transparency (school review platform, web).

Write a concise markdown file following this EXACT template. Do not add, remove, or reorder sections. Do not use emojis. Do not add preamble or explanation outside the template.

# <Feature Name>

**Last updated:** <today's date in YYYY-MM-DD format>
**Status:** <GA | Beta | Preview | Deprecated>
**Category:** <one line, e.g. "Developer platform — API feature">

## What it is

2-3 sentences, plain English. No marketing language. What problem does it solve, for whom.

## How it works

Bullets on the actual mechanics. Be specific. If there's an API endpoint, name it. If it costs credits/tokens, say so. If it requires a specific plan, say so.

## Availability and pricing

Who can access it (Free / Pro / Max / Team / Enterprise / API-only). Concrete numbers where they exist.

## Official docs

- [Source page](<the URL passed to you>)

## Verdict application

One of these two:
(a) 2-4 specific ways this could be used in Verdict or True Transparency development. Be concrete — reference actual components (fact-checking trigger system, RevenueCat integration, SwiftData persistence, school review moderation, etc.).
(b) If there is no honest application, write exactly: "No direct application to Verdict or True Transparency. This feature is aimed at <who it's actually for>."

Do not invent hollow use cases. If it doesn't fit, say so.

## Recent changes

If this is a brand-new page, write "Initial entry." If the page changed since last week, write 1-3 bullets on what seems different (based on the content). If unclear, write "Content updated — specific changes unclear from diff."

---

You will be given:
1. The feature name
2. The source URL
3. The scraped page content
4. Whether this is a NEW entry or an UPDATE
5. If UPDATE, a note about the change

Respond with ONLY the markdown content. No code fences, no "Here's your cheat sheet" preamble.`;

async function summarize({ name, url, content, isNew, category }) {
  // Use Haiku for cheaper simple summaries. Sonnet gets called for the news index.
  const model = category === '_news' ? 'claude-sonnet-4-5' : 'claude-haiku-4-5';

  const userMsg = `Feature name: ${name}
Source URL: ${url}
Status: ${isNew ? 'NEW entry' : 'UPDATE — content changed since last week'}
Today's date: ${new Date().toISOString().slice(0, 10)}

---

Scraped content:

${content}`;

  const res = await client.messages.create({
    model,
    max_tokens: 2000,
    system: TEMPLATE_PROMPT,
    messages: [{ role: 'user', content: userMsg }],
  });

  const text = res.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();

  return text;
}

// ---------- news digest ----------

async function summarizeNewsIndex(content) {
  const res = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1500,
    system: `You are writing the "What's new" section of an Anthropic cheat sheet for a teenage indie developer building iOS apps. Extract the 5-10 most significant recent announcements from the Anthropic news page content below. For each, write: title, approximate date if visible, one-sentence summary, and (if relevant) a quick note on whether it matters for an indie iOS developer. Output as markdown. No preamble.`,
    messages: [{ role: 'user', content }],
  });
  return res.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

// ---------- main ----------

async function main() {
  console.log('Loading sources and prior hashes...');
  const sources = JSON.parse(await readFile(SOURCES_PATH, 'utf8')).sources;
  const prior = existsSync(HASH_PATH)
    ? JSON.parse(await readFile(HASH_PATH, 'utf8'))
    : {};
  const newHashes = {};

  let changed = 0, unchanged = 0, errors = 0;
  const changelog = [];

  for (const src of sources) {
    console.log(`\n[${src.slug}] ${src.url}`);
    try {
      const content = await fetchPage(src.url);
      const h = hash(content);
      newHashes[src.slug] = h;

      const isNew = !(src.slug in prior);
      const isChanged = !isNew && prior[src.slug] !== h;

      if (!isNew && !isChanged) {
        console.log('  unchanged, skipping');
        unchanged++;
        continue;
      }

      console.log(isNew ? '  NEW — summarizing' : '  CHANGED — resummarizing');

      let markdown;
      if (src.category === '_news') {
        markdown = '# What\'s new from Anthropic\n\n**Last updated:** '
          + new Date().toISOString().slice(0, 10) + '\n\n'
          + await summarizeNewsIndex(content);
      } else {
        markdown = await summarize({
          name: src.name,
          url: src.url,
          content,
          isNew,
          category: src.category,
        });
      }

      const categoryDir = src.category === '_news' ? '' : src.category;
      const filename = src.category === '_news' ? 'whats-new.md' : `${src.slug}.md`;
      const outPath = path.join(DOCS_DIR, categoryDir, filename);
      await mkdir(path.dirname(outPath), { recursive: true });
      await writeFile(outPath, markdown + '\n');

      changelog.push(`- ${isNew ? 'NEW' : 'UPDATED'}: ${src.name}`);
      changed++;

      // Be polite to Anthropic's servers.
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error(`  ERROR: ${e.message}`);
      errors++;
      // Preserve prior hash so we retry next run
      if (prior[src.slug]) newHashes[src.slug] = prior[src.slug];
    }
  }

  await mkdir(path.dirname(HASH_PATH), { recursive: true });
  await writeFile(HASH_PATH, JSON.stringify(newHashes, null, 2) + '\n');

  // Write the index page
  await writeIndex(sources, changelog);

  console.log(`\nDone. Changed: ${changed}, Unchanged: ${unchanged}, Errors: ${errors}`);
}

async function writeIndex(sources, changelog) {
  const today = new Date().toISOString().slice(0, 10);
  const byCategory = {};
  for (const s of sources) {
    if (s.category === '_news') continue;
    if (!byCategory[s.category]) byCategory[s.category] = [];
    byCategory[s.category].push(s);
  }

  const categoryNames = {
    products: 'Products and interfaces',
    'developer-platform': 'Developer platform',
    models: 'Models and pricing',
    features: 'Features',
    safety: 'Safety and policy',
  };

  let md = `# Anthropic Cheat Sheet\n\n`;
  md += `A living reference to every Anthropic product, feature, and tool. Auto-updated weekly.\n\n`;
  md += `**Last run:** ${today}\n\n`;
  md += `[What's new from Anthropic](whats-new.md)\n\n`;

  if (changelog.length > 0) {
    md += `## Changes in this run\n\n${changelog.join('\n')}\n\n`;
  }

  for (const [cat, items] of Object.entries(byCategory)) {
    md += `## ${categoryNames[cat] || cat}\n\n`;
    for (const s of items) {
      md += `- [${s.name}](${cat}/${s.slug}.md)\n`;
    }
    md += '\n';
  }

  await writeFile(path.join(DOCS_DIR, 'index.md'), md);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
