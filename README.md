# Proposal Website

A single-page romantic proposal flow (welcome → question → convince →
dodging "no" button → celebration), with an Express + PostgreSQL +
Socket.IO backend that tracks sessions in real time on a password-protected
dashboard.

## Structure

```
frontend/index.html      Self-contained page (no build step) — the thing she'll actually see
server/index.js           Express app: /api/events, /api/sessions, /dashboard
server/db.js               PostgreSQL connection pool
server/schema.sql          sessions + events tables
server/public/admin-login.html Login form for /admin
server/public/dashboard.html   Live session viewer, shown at /admin once logged in
server/package.json
server/.env.example
```

## Before you send it to anyone

1. **Swap the placeholders** in `frontend/index.html`:
   - `CONFIG.herName`, `CONFIG.quotes`, `CONFIG.reasons`, `CONFIG.pleadingMessages`,
     `CONFIG.finalMessage`, `CONFIG.celebrateMessage` — all at the top of the
     `<script>` block.
   - Replace `./her.jpg` (photo) and `./song.mp3` (optional background song) —
     either put real files next to `index.html` with those names, or change
     `CONFIG.photoSrc` / the `<audio><source>` path.
2. Everything else (animations, the dodge logic, tracking) works as-is.

## Running the backend

```bash
cd server
cp .env.example .env      # fill in DATABASE_URL, DASHBOARD_PASSWORD, and SESSION_SECRET
npm install
psql "$DATABASE_URL" -f schema.sql
npm start
```

The server serves `frontend/index.html` itself at `/`, so for local testing
you can just open `http://localhost:3000`. In production you can instead host
`frontend/index.html` anywhere (Netlify, Vercel, S3, GitHub Pages) as long as
`/api/events` on that same origin points at your running server — either
deploy them together, or edit the `fetch("/api/events", ...)` call in
`index.html` to a full URL if the frontend and backend live on different
domains (and enable CORS on the server for that origin).

- **Admin login:** visit `/admin`, enter the `DASHBOARD_PASSWORD` you set.
  You'll land on the live session list, which updates in real time as events
  come in; "Log out" clears the session. The login is cookie-based, so you
  stay signed in for 12 hours — you'll need `SESSION_SECRET` set in `.env`
  for it to work (see `.env.example` for how to generate one).
- **Webhook:** set `NOTIFY_WEBHOOK_URL` to any incoming-webhook URL (Slack,
  Discord, etc.) to get pinged the moment someone opens the page.

## Notes on choices made beyond the brief

- The dashboard is plain HTML/JS rather than a React build, so there's
  nothing to compile — it's served straight from `server/public/`. Point it at
  a React setup instead if you'd rather.
- `/api/sessions` isn't in the original spec but hydrates the dashboard with
  existing sessions on load, before the socket starts streaming new events.
- The dashboard's Basic Auth password check is a single shared secret — good
  enough for a private link you send yourself, not meant for anything more
  sensitive.
- Requires Node 18+ (uses the built-in `fetch` for the webhook call).
