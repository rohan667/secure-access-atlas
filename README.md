# Secure Access Atlas

A privacy-first web app for reporting barriers people meet when signing in to, or recovering, accounts on important websites (universities, libraries, health and public services), and for reviewing and publishing those reports.

It runs on Node.js with **no third-party dependencies**: install Node 20 or newer and nothing else.

## Run it

```bash
REVIEWER_PASSWORD="a-long-passphrase" npm start
# then open http://127.0.0.1:3000
```

If you do not set `REVIEWER_PASSWORD`, a temporary one is printed in the console. See `.env.example` for the other settings. On first run the app creates `data/` with sample data (set `SEED_SAMPLE_DATA=0` for an empty database).

Run the tests with `npm test`.

## What works

- Anonymous report form (no passwords, codes, recovery answers or accounts), with an optional private-security flag
- Reviewer sign-in, dashboard, status changes, redaction helper, duplicate merge (submissions preserved), private notes, manual publishing, and deletion for removal requests
- Public directory of reviewed reports only, with status shown in text and symbols
- Local keyword-based category and duplicate suggestions (no external AI service; reviewers decide)
- Counts-only impact metrics with bar charts (by status and journey) and median hours to review
- Live updates: the reviewer page checks every 30 seconds and offers a refresh banner when new reports arrive (it never replaces your edits on its own); the public directory refreshes itself every 60 seconds
- Search, filter and sort on both the public directory and the reviewer list; collapsible report cards
- Gentle animations (counters, bars, card fade-in) that switch off when the device asks for reduced motion

## Security design

- The server enforces every rule: publishing requires verified or resolved status, a reviewed summary and no security flag
- Constant-time password check; HttpOnly, SameSite=Strict session cookie; CSRF header on every reviewer change
- Rate limits on sign-in and report submission; 20 KB request limit; strict input validation
- Content Security Policy with no inline scripts; all text rendered as text, never as HTML
- Contact details stored in a separate file and never sent to public pages
- No scanning or testing of any third-party site

## Known limits

- One shared reviewer password, not per-person accounts or audit logs
- Data lives in local JSON files with atomic writes: fine for a pilot, move to a database for scale
- Screenshots are not collected yet (they need scanning, metadata stripping and private storage first)
- Rate limiting is per process and held in memory
- No automatic retention job; use the delete action for removal requests
- Serve over HTTPS in production and set `COOKIE_SECURE=1`

## Next steps

Per-reviewer accounts with audit logging, database storage, safe screenshot handling, a retention schedule, a written threat model, and a pilot with one service team.
