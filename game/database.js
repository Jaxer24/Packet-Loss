const { Pool } = require("pg");

function createDatabase(connectionString) {
  const pool = new Pool({ connectionString });
  pool.on("error", (error) => console.error("Idle database connection error:", error));

  return {
    pool,
    async initialize() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          username_key text PRIMARY KEY,
          username text NOT NULL,
          password_hash text NOT NULL
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS session (
          sid varchar PRIMARY KEY,
          sess json NOT NULL,
          expire timestamp(6) NOT NULL
        )
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON session (expire)');
    },
    async createUser(username, passwordHash) {
      const result = await pool.query(
        `INSERT INTO users (username_key, username, password_hash)
         VALUES ($1, $2, $3) ON CONFLICT (username_key) DO NOTHING
         RETURNING username`,
        [username.toLowerCase(), username, passwordHash],
      );
      return result.rows[0] || null;
    },
    async findUser(username) {
      const result = await pool.query(
        "SELECT username, password_hash FROM users WHERE username_key = $1",
        [username.toLowerCase()],
      );
      return result.rows[0] || null;
    },
  };
}

module.exports = { createDatabase };
