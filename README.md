# local-audit-mcp

An MCP server that audits a local business's public web presence and returns a sales-ready score and offer. Point any MCP-capable agent (Claude Code, Cursor, opencode, ...) at a business's website and get a structured audit you can send as a pitch.

## Tools

| Tool | What it does |
|---|---|
| `fetch_page` | Fetch a public page, return readable text (scripts/styles stripped) |
| `extract_signals` | Pull signals from a business site: mobile readiness, phones, emails, WhatsApp, booking system, socials, chat widgets, price hints, FAQ schema |
| `score_presence` | Score 0–10 across 10 audit checkpoints, list gaps ranked by revenue impact, recommend the offer to pitch |
| `extract_faqs` | Pull FAQ Q&As for chatbot demos: structured FAQ schema first, then question headings, then question-like lines |

## Install & run

```bash
npm install
npm start        # runs the stdio server
npm test         # 25 checks against a local fixture site (deterministic)
```

## Use in opencode

```json
"mcp": {
  "local-audit": {
    "type": "local",
    "command": ["node", "/absolute/path/to/local-audit-server/index.js"],
    "enabled": true
  }
}
```

For other agents (Claude Code, Cursor, etc.), point their MCP config at `node /path/to/index.js` (stdio transport).

## Example flow

```
extract_signals(url: "https://salon-example.com")
  → score_presence(signals: {...}, google_claimed: false)
    → score 4/10, gap #1: no online booking
      → recommended: AI assistant $300 setup + $50/mo
  → extract_faqs(url) → seed demo-widget.html → send demo to owner
```

## Honest limitations

- Regex-based HTML parsing, not a DOM — fine for typical small-business sites, not SPAs (JS-rendered pages return little text). Next version: optional Playwright mode.
- 4 of the 10 checkpoints (Google profile, review replies, social activity, response time) can't be verified from a website alone — they come back as `manual` checks for a human to verify in ~2 minutes.
- Only public pages. No logins, no scraping behind auth.
- Never invent audit facts — if a tool says `manual`, a human confirms before anything goes to a prospect.

## Why it exists

- Automates ~80% of a local-business audit: score a prospect in seconds, then focus human effort on the pitch
- Produces reproducible, evidence-based audits — no invented facts (manual checkpoints stay manual for a human to verify)
- A template for custom MCP builds for businesses (agent integrations, internal tools)
