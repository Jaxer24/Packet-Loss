// Packet Loss server: Express (HTTP + auth + sessions) + ws (real-time game) + the Game simulation.
//
//   Browser --HTTP--> /api/register /api/login /api/me /api/logout   (bcrypt + express-session)
//   Browser --WebSocket /ws--> only accepted if the session cookie belongs to a logged-in user
//   Game (game/game.js) runs a 30 Hz loop and pushes per-player snapshots through the sockets.

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const fs = require("fs/promises");
const http = require("http");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcrypt");
const { WebSocketServer } = require("ws");
const { Lobbies } = require("./game/lobbies");
const C = require("./game/config");

const PORT = Number(process.env.PORT) || 3100;
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  console.error("Set SESSION_SECRET (32+ characters) in .env - see .env.example");
  process.exit(1);
}

const usersFile = path.join(__dirname, "users.json");
const users = new Map(); // lowercase username -> { username, passwordHash }

const app = express();
app.set("trust proxy", 1); // hosts like Render terminate HTTPS at a proxy
app.use(express.json({ limit: "2kb" }));
const sessionMiddleware = session({
  name: "packetloss.sid",
  secret: SESSION_SECRET,
  proxy: true,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 3600 * 1000,
  },
});
app.use(sessionMiddleware);
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders(res, filePath) {
      if (filePath.endsWith(".html") || filePath.endsWith(".js")) {
        res.setHeader("Cache-Control", "no-store");
      }
    },
  }),
);

const validUsername = (v) => typeof v === "string" && /^[a-zA-Z0-9_]{3,24}$/.test(v);
const validPassword = (v) =>
  typeof v === "string" &&
  Buffer.byteLength(v, "utf8") >= 8 &&
  Buffer.byteLength(v, "utf8") <= 72;
const saveSession = (req) =>
  new Promise((ok, no) => req.session.save((e) => (e ? no(e) : ok())));
const regenerateSession = (req) =>
  new Promise((ok, no) => req.session.regenerate((e) => (e ? no(e) : ok())));

// ---------- Authentication ----------
app.post("/api/register", async (req, res, next) => {
  const { username, password } = req.body || {};
  if (!validUsername(username)) {
    return res
      .status(400)
      .json({ error: "Username must be 3-24 letters, numbers, or underscores." });
  }
  if (!validPassword(password)) {
    return res.status(400).json({ error: "Password must be 8-72 bytes long." });
  }
  const key = username.toLowerCase();
  if (users.has(key)) {
    return res.status(409).json({ error: "That username is already registered." });
  }
  try {
    const user = { username, passwordHash: await bcrypt.hash(password, 12) };
    if (users.has(key)) {
      return res.status(409).json({ error: "That username is already registered." });
    }
    await fs.writeFile(
      usersFile,
      JSON.stringify([...users.values(), user], null, 2),
      "utf8",
    );
    users.set(key, user);
    await regenerateSession(req);
    req.session.username = user.username;
    await saveSession(req);
    res.status(201).json({ username: user.username });
  } catch (e) {
    next(e);
  }
});

app.post("/api/login", async (req, res, next) => {
  const { username, password } = req.body || {};
  if (typeof username !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "Enter a username and password." });
  }
  try {
    const user = users.get(username.toLowerCase());
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: "Incorrect username or password." });
    }
    await regenerateSession(req); // new session id on login
    req.session.username = user.username;
    await saveSession(req);
    res.json({ username: user.username });
  } catch (e) {
    next(e);
  }
});

app.get("/api/me", (req, res) => {
  if (!req.session.username) {
    return res.status(401).json({ error: "Not logged in." });
  }
  res.json({ username: req.session.username });
});

app.post("/api/logout", (req, res, next) => {
  const name = req.session.username;
  req.session.destroy((err) => {
    if (err) {
      return next(err);
    }
    res.clearCookie("packetloss.sid");
    if (name) {
      for (const ws of sockets.get(name) || []) {
        ws.close(4001, "logged out");
      }
    }
    res.json({ ok: true });
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Server error." });
});

// ---------- WebSocket (only for logged-in sessions) ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 2048 });
const sockets = new Map(); // username -> Set of sockets (a user may have several tabs)

server.on("upgrade", (req, socket, head) => {
  const reject = (line) => {
    socket.write(`HTTP/1.1 ${line}\r\n\r\n`);
    socket.destroy();
  };
  if (req.url !== "/ws") {
    return reject("404 Not Found");
  }
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) {
        return reject("403 Forbidden");
      }
    } catch {
      return reject("403 Forbidden");
    }
  }
  sessionMiddleware(req, {}, (error) => {
    if (error) {
      return reject("500 Internal Server Error");
    }
    if (!req.session || !req.session.username) {
      return reject("401 Unauthorized");
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.username = req.session.username;
      wss.emit("connection", ws);
    });
  });
});

const lobbies = new Lobbies((username, msg) => {
  const set = sockets.get(username);
  if (!set) {
    return;
  }
  const text = JSON.stringify(msg);
  for (const ws of set) {
    if (ws.readyState === 1) {
      ws.send(text);
    }
  }
});

wss.on("connection", (ws) => {
  const name = ws.username;
  if (!sockets.has(name)) {
    sockets.set(name, new Set());
  }
  sockets.get(name).add(ws);
  lobbies.connect(name);

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    lobbies.handle(name, msg);
  });
  ws.on("close", () => {
    const set = sockets.get(name);
    if (set) {
      set.delete(ws);
      if (set.size === 0) {
        sockets.delete(name);
        lobbies.disconnect(name);
      }
    }
  });
});

setInterval(() => lobbies.tick(), 1000 / C.tickRate);

// ---------- Start ----------
async function start() {
  try {
    for (const u of JSON.parse(await fs.readFile(usersFile, "utf8"))) {
      users.set(u.username.toLowerCase(), u);
    }
  } catch (e) {
    if (e.code !== "ENOENT") {
      throw e;
    }
    await fs.writeFile(usersFile, "[]", "utf8");
  }
  server.on("error", (e) => {
    console.error(
      e.code === "EADDRINUSE" ? `Port ${PORT} is in use. Change PORT in .env.` : e,
    );
    process.exit(1);
  });
  server.listen(PORT, () =>
    console.log(`Packet Loss running at http://localhost:${PORT}`),
  );
}
start();
