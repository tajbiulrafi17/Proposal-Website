require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const cookieParser = require("cookie-parser");
const cookie = require("cookie");
const signature = require("cookie-signature");
const { Server } = require("socket.io");
const pool = require("./db");

const PORT = process.env.PORT || 3000;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "";
const NOTIFY_WEBHOOK_URL = process.env.NOTIFY_WEBHOOK_URL || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const ADMIN_COOKIE = "admin_session";
const ADMIN_COOKIE_MAX_AGE = 12 * 60 * 60 * 1000; // 12 hours

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: false })); // for the /admin login form
app.use(cookieParser(SESSION_SECRET));

// Serve the proposal page itself — lives in server/static so it's part of
// the same build context (Railway's "Root Directory: server" setting only
// includes this folder, not sibling folders like the old ../frontend).
app.use(express.static(path.join(__dirname, "static")));

/* =========================================================
   POST /api/events
   Accepts { events: [...] } batches from the tracker module.
   Creates the session row on that session's first event
   (normally session_start), otherwise just bumps last_seen_at.
   ========================================================= */
app.post("/api/events", async (req, res) => {
  try {
    const events = Array.isArray(req.body && req.body.events)
      ? req.body.events
      : [];
    if (events.length === 0) return res.status(204).end();

    // Basic shape validation — drop anything malformed rather than 500ing,
    // since a bad event from the client should never break the batch.
    const clean = events.filter(isValidEvent).slice(0, 50);
    if (clean.length === 0)
      return res.status(400).json({ error: "no valid events" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      for (const evt of clean) {
        await client.query(
          `INSERT INTO sessions (id, user_agent, viewport, last_seen_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (id) DO UPDATE SET last_seen_at = now()`,
          [
            evt.sessionId,
            evt.userAgent || null,
            evt.viewport ? JSON.stringify(evt.viewport) : null,
          ],
        );

        await client.query(
          `INSERT INTO events (session_id, seq, event, screen, label, meta, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            evt.sessionId,
            evt.seq,
            evt.event,
            evt.screen || null,
            evt.label || null,
            evt.meta ? JSON.stringify(evt.meta) : null,
            evt.t ? new Date(evt.t) : new Date(),
          ],
        );

        io.to("dashboard").emit("event", {
          sessionId: evt.sessionId,
          seq: evt.seq,
          event: evt.event,
          screen: evt.screen,
          label: evt.label,
          t: evt.t,
          msSinceStart: evt.msSinceStart,
        });

        if (evt.event === "session_start") {
          notifyWebhook(evt).catch((err) => {
            console.error("Webhook notify failed:", err.message);
          });
        }
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    res.status(202).json({ accepted: clean.length });
  } catch (err) {
    console.error("POST /api/events failed:", err);
    // Tracker fails silently client-side either way; still return a code
    // so it knows to retry the batch.
    res.status(500).json({ error: "internal error" });
  }
});

function isValidEvent(evt) {
  return (
    evt &&
    typeof evt.sessionId === "string" &&
    typeof evt.seq === "number" &&
    typeof evt.event === "string" &&
    evt.event.length < 64
  );
}

async function notifyWebhook(evt) {
  if (!NOTIFY_WEBHOOK_URL) return;
  await fetch(NOTIFY_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: "New proposal session started",
      sessionId: evt.sessionId,
      startedAt: evt.t,
      userAgent: evt.userAgent,
    }),
  });
}

/* =========================================================
   GET /api/sessions
   Hydrates the dashboard with recent sessions + their events
   on first load; live updates then come over the socket.
   Requires the same login as the /admin page (see auth below).
   ========================================================= */
app.get("/api/sessions", requireAdminAuth, async (req, res) => {
  try {
    const { rows: sessions } = await pool.query(
      `SELECT id, started_at, last_seen_at, user_agent, viewport, ended_at
       FROM sessions
       ORDER BY last_seen_at DESC
       LIMIT 50`,
    );

    const { rows: events } = await pool.query(
      `SELECT session_id, seq, event, screen, label, meta, created_at
       FROM events
       WHERE session_id = ANY($1::uuid[])
       ORDER BY session_id, seq ASC`,
      [sessions.map((s) => s.id)],
    );

    const bySession = {};
    for (const s of sessions) bySession[s.id] = { ...s, events: [] };
    for (const e of events) {
      if (bySession[e.session_id]) bySession[e.session_id].events.push(e);
    }

    res.json({ sessions: Object.values(bySession) });
  } catch (err) {
    console.error("GET /api/sessions failed:", err);
    res.status(500).json({ error: "internal error" });
  }
});

/* =========================================================
   /admin — login page + the live session view, both at one URL.
   GET  /admin        shows the login form, or the dashboard if
                       you already have a valid session cookie.
   POST /admin        checks the password from the form and,
                       if correct, sets the session cookie.
   GET  /admin/logout  clears the cookie.
   ========================================================= */
app.get("/admin", (req, res) => {
  if (!DASHBOARD_PASSWORD) {
    return res
      .status(503)
      .send("Set DASHBOARD_PASSWORD in your .env to enable /admin.");
  }
  if (isAdminAuthed(req)) {
    return res.sendFile(path.join(__dirname, "public", "dashboard.html"));
  }
  res.sendFile(path.join(__dirname, "public", "admin-login.html"));
});

app.post("/admin", (req, res) => {
  if (!DASHBOARD_PASSWORD) {
    return res
      .status(503)
      .send("Set DASHBOARD_PASSWORD in your .env to enable /admin.");
  }

  const submitted = (req.body && req.body.password) || "";
  const a = Buffer.from(submitted);
  const b = Buffer.from(DASHBOARD_PASSWORD);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!ok) {
    return res.redirect("/admin?error=1");
  }

  res.cookie(ADMIN_COOKIE, "ok", {
    httpOnly: true,
    signed: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: ADMIN_COOKIE_MAX_AGE,
  });
  res.redirect("/admin");
});

app.get("/admin/logout", (req, res) => {
  res.clearCookie(ADMIN_COOKIE);
  res.redirect("/admin");
});

function isAdminAuthed(req) {
  return (
    !!SESSION_SECRET &&
    req.signedCookies &&
    req.signedCookies[ADMIN_COOKIE] === "ok"
  );
}

function requireAdminAuth(req, res, next) {
  if (isAdminAuthed(req)) return next();
  res.status(401).json({ error: "log in at /admin first" });
}

/* =========================================================
   Socket.IO — dashboard room, gated by the same admin cookie
   ========================================================= */
io.use((socket, next) => {
  try {
    const header = socket.handshake.headers.cookie || "";
    const parsed = cookie.parse(header);
    const raw = parsed[ADMIN_COOKIE];
    const unsigned =
      raw && raw.startsWith("s:")
        ? signature.unsign(raw.slice(2), SESSION_SECRET)
        : false;
    if (unsigned === "ok") return next();
  } catch (e) {
    /* falls through to error below */
  }
  next(new Error("unauthorized"));
});

io.on("connection", (socket) => {
  socket.join("dashboard");
});

server.listen(PORT, () => {
  console.log(`Proposal server listening on port ${PORT}`);
});
