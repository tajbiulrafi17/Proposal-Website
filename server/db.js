const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Most managed Postgres providers (Render, Heroku, Supabase, RDS) need SSL.
  // Set PGSSL=false in .env to disable for local development.
  ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false }
});

pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL client error:", err);
});

module.exports = pool;
