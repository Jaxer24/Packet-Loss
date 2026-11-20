const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { Pool } = require("pg");
const WebSocket = require("ws");

const connectionString = process.env.TEST_DATABASE_URL;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
      env: {
        ...process.env,
        NODE_ENV: "test",
        PORT: String(port),
        DATABASE_URL: connectionString,
        SESSION_SECRET: "integration-test-secret-not-for-production",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Server startup timed out: " + output));
    }, 15000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("Packet Loss running")) {
        clearTimeout(timeout);
        resolve(child);
      }
    });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error("Server exited during startup (" + code + "): " + output));
    });
  });
}

function stopServer(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill();
  });
}

test("PostgreSQL persists accounts and sessions across server restarts", { skip: !connectionString, timeout: 60000 }, async () => {
  const port = await freePort();
  const pool = new Pool({ connectionString });
  const username = "Test" + randomBytes(6).toString("hex");
  const base = `http://127.0.0.1:${port}`;
  let child;
  const post = (url, body, cookie) => fetch(base + url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  try {
    child = await startServer(port);
    const [first, second] = await Promise.all([
      post("/api/register", { username, password: "example-password" }),
      post("/api/register", { username: username.toUpperCase(), password: "example-password" }),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [201, 409]);
    const registered = first.status === 201 ? first : second;
    const registeredName = (await registered.json()).username;
    const cookie = registered.headers.get("set-cookie").split(";")[0];
    assert.equal((await fetch(base + "/api/me", { headers: { Cookie: cookie } })).status, 200);

    await stopServer(child);
    child = await startServer(port);
    const me = await fetch(base + "/api/me", { headers: { Cookie: cookie } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).username, registeredName);
    const denied = await post("/api/login", { username, password: "wrong-password" });
    assert.equal(denied.status, 401);
    const login = await post("/api/login", { username: username.toLowerCase(), password: "example-password" });
    assert.equal(login.status, 200);
    assert.equal((await login.json()).username, registeredName);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } });
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const closed = new Promise((resolve) => ws.once("close", resolve));
    assert.equal((await post("/api/logout", {}, cookie)).status, 200);
    await closed;
    assert.equal((await fetch(base + "/api/me", { headers: { Cookie: cookie } })).status, 401);
  } finally {
    await stopServer(child);
    await pool.query("DELETE FROM session WHERE sess->>'username' = $1", [username]);
    await pool.query("DELETE FROM session WHERE sess->>'username' = $1", [username.toUpperCase()]);
    await pool.query("DELETE FROM users WHERE username_key = $1", [username.toLowerCase()]);
    await pool.end();
  }
});
