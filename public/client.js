// Packet Loss browser client (vanilla JS, no framework).
// Flow: login (HTTP) -> lobby (WebSocket) -> match.
// The server owns the game state; this client sends input, runs mouse challenges,
// reports their results, and draws snapshots.
// Short keys in messages (such as `t`, `mx`, and `my`) are shared with game/game.js.

const $ = (id) => document.getElementById(id);
const cv = $("cv");
const ctx = cv.getContext("2d");
const fog = document.createElement("canvas");
const fx = fog.getContext("2d");
const music = $("backgroundMusic");
const musicVolume = $("musicVolume");
musicVolume.value = "5";
music.volume = Number(musicVolume.value) / 100;
$("musicVolumeValue").textContent = musicVolume.value + "%";

// The most recent server messages are kept here and used by input and rendering.
let ws = null;
let myName = "";
let myTeam = "";
let map = null;
let cfg = null;
let snap = null;
let lobby = null;
let hackMode = false;
let minigame = null;
let respawnStarting = false;
let respawnRequest = 0;
let respawnSpawn = null;
let cam = { s: 1, ox: 0, oy: 0 }; // world-to-screen scale and x/y offsets
let redRadar = false;
let radarView = null; // zoom/pan state of the detailed radar: { s0, s, ox, oy }
let panDrag = null;
let lastBluePosition = null;
let disposalLine = null;
let lastAim = 0; // last shooter-view aim angle (kept while a radar is open)
const keys = {};
const mouse = { x: 0, y: 0, down: false };
const disp = {}; // smoothed display positions, keyed by entity

// ---------- helpers ----------
const show = (id) => {
  for (const s of ["auth", "lobby", "game"]) {
    $(s).classList.toggle("hidden", s !== id);
  }
  $("musicControls").classList.toggle("hidden", id === "auth");
  if (id === "auth") {
    musicRequest++;
    music.pause();
    $("settingsPanel").classList.add("hidden");
    $("settingsToggle").setAttribute("aria-expanded", "false");
  }
};
let musicEnabled = true;
let musicRequest = 0;
$("settingsToggle").onclick = () => {
  const open = $("settingsPanel").classList.toggle("hidden") === false;
  $("settingsToggle").setAttribute("aria-expanded", String(open));
};
function applyMusicVolume() {
  const value = Number(musicVolume.value);
  music.volume = value / 100;
  $("musicVolumeValue").textContent = value + "%";
}
musicVolume.oninput = applyMusicVolume;
function playMusic() {
  const request = ++musicRequest;
  $("musicToggle").textContent = "Pause music";
  $("musicStatus").textContent = "";
  if (music.error) music.load();
  applyMusicVolume();
  music.play().catch((error) => {
    if (request !== musicRequest || !musicEnabled) return;
    $("musicToggle").textContent = "Play music";
    $("musicStatus").textContent = error.name === "NotAllowedError"
      ? "Open Settings and click Play music to allow audio."
      : "Music could not play. Check the audio file in Settings.";
    console.error("Music playback failed:", error);
  });
}
$("musicToggle").onclick = () => {
  if (musicEnabled && !music.paused) {
    musicEnabled = false;
    musicRequest++;
    music.pause();
    $("musicToggle").textContent = "Play music";
    $("musicStatus").textContent = "";
  } else {
    musicEnabled = true;
    playMusic();
  }
};
music.addEventListener("error", () => {
  $("musicToggle").textContent = "Play music";
  $("musicStatus").textContent = "Music could not load. Check the audio file.";
  console.error("Music could not load:", music.error);
});
async function api(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}
const send = (obj) => {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(obj));
  }
};
const act = (a, extra) => send({ t: "act", a, ...extra });
function toast(text) {
  const d = document.createElement("div");
  d.textContent = text;
  $("log").appendChild(d);
  while ($("log").children.length > 6) {
    $("log").firstChild.remove();
  }
  setTimeout(() => d.remove(), 7000);
}
// Interpolate display positions between snapshots; large jumps are treated as teleports.
function smoothPosition(key, x, y) {
  let position = disp[key];
  if (!position || Math.hypot(position.x - x, position.y - y) > 150) {
    position = disp[key] = { x, y };
  } else {
    position.x += (x - position.x) * 0.45;
    position.y += (y - position.y) * 0.45;
  }
  return position;
}

// ---------- auth + connection ----------
async function submitAuth(kind) {
  $("authError").textContent = "";
  try {
    const r = await api("/api/" + kind, {
      username: $("user").value.trim(),
      password: $("pass").value,
    });
    myName = r.username;
    $("me").textContent = myName;
    $("pass").value = "";
    connect();
  } catch (e) {
    $("authError").textContent = e.message;
  }
}
$("btnLogin").onclick = () => submitAuth("login");
$("btnRegister").onclick = () => submitAuth("register");
$("pass").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    submitAuth("login");
  }
});
$("btnLogout").onclick = async () => {
  await api("/api/logout").catch(() => {});
  location.reload();
};
$("joinRed").onclick = () => send({ t: "team", team: "red" });
$("joinBlue").onclick = () => send({ t: "team", team: "blue" });
$("btnStart").onclick = () => send({ t: "start" });
$("btnBack").onclick = () => send({ t: "lobby" });
$("btnHost").onclick = () => send({ t: "host_lobby" });
$("btnRandom").onclick = () => send({ t: "join_random" });
$("btnJoinCode").onclick = () => send({ t: "join_code", code: $("lobbyCodeInput").value });
$("lobbyCodeInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("btnJoinCode").onclick();
});
$("btnPrivacy").onclick = () => send({ t: "lobby_privacy", private: !lobby.private });
$("btnLeaveLobby").onclick = () => send({ t: "leave_lobby" });
$("btnLeaveGame").onclick = () => send({ t: "leave_lobby" });
$("btnLeaveEnd").onclick = () => send({ t: "leave_lobby" });

function connect() {
  if (ws) {
    ws.close();
  }
  ws = new WebSocket(
    (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws",
  );
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = () => {
    closeMinigame();
    respawnStarting = false;
    respawnSpawn = null;
    show("auth");
    snap = null;
  };
  show("lobby");
  if (musicEnabled) playMusic();
}

function onMessage(m) {
  if (m.t === "lobby_select") {
    lobby = null;
    snap = null;
    mouse.down = false;
    for (const key in keys) keys[key] = false;
    closeMinigame();
    $("lobbySelect").classList.remove("hidden");
    $("lobbyRoom").classList.add("hidden");
    $("lobbyError").textContent = "";
    $("endOverlay").classList.add("hidden");
    show("lobby");
  } else if (m.t === "lobby_error") {
    $("lobbyError").textContent = m.text;
    if (lobby) toast(m.text);
  } else if (m.t === "lobby") {
    lobby = m;
    $("gameLobbyCode").textContent = m.code || "";
    $("lobbySelect").classList.add("hidden");
    $("lobbyRoom").classList.remove("hidden");
    $("lobbyError").textContent = "";
    if (m.phase === "lobby") {
      closeMinigame();
      respawnStarting = false;
      respawnSpawn = null;
      snap = null;
      show("lobby");
      $("endOverlay").classList.add("hidden");
      renderLobby();
    } else {
      if (m.phase === "ended") {
        closeMinigame();
        respawnStarting = false;
        respawnSpawn = null;
      }
      show("game");
      $("endOverlay").classList.toggle("hidden", m.phase !== "ended");
      $("btnBack").classList.toggle("hidden", m.host !== myName);
      if (m.result) {
        $("endTitle").textContent =
          m.result.winner === "draw"
            ? "DRAW"
            : m.result.winner.toUpperCase() + " TEAM WINS";
        $("endReason").textContent = m.result.reason;
      }
    }
  } else if (m.t === "init") {
    applyMusicVolume();
    music.currentTime = 0;
    if (musicEnabled && music.paused) playMusic();
    map = m.map;
    cfg = m.cfg;
    myTeam = m.team;
    myName = m.name;
    hackMode = false;
    mouse.down = false;
    for (const key in keys) keys[key] = false;
    redRadar = false;
    radarView = null;
    panDrag = null;
    lastBluePosition = null;
    disposalLine = null;
    closeMinigame();
    respawnStarting = false;
    respawnSpawn = null;
    show("game");
  } else if (m.t === "snap") {
    const wasRadar = isRadar();
    const wasAlive = snap && myTeam === "red" ? snap.me.alive : null;
    snap = m;
    if (myTeam === "red" && wasAlive !== null && wasAlive !== m.me.alive) {
      redRadar = false;
      radarView = null;
      panDrag = null;
      mouse.down = false;
      for (const key in keys) keys[key] = false;
    }
    if (myTeam === "red" && m.me.alive) {
      if (minigame && minigame.purpose === "respawn") {
        closeMinigame();
        toast("Automatic respawn completed.");
      }
      respawnStarting = false;
      respawnSpawn = null;
    }
    if (myTeam === "blue" && m.me.guard) {
      lastBluePosition = { x: m.me.guard.x, y: m.me.guard.y };
    }
    if (myTeam === "blue" && wasRadar !== isRadar()) {
      radarView = null;
      panDrag = null;
    }
  } else if (m.t === "event") {
    toast(m.text);
  } else if (m.t === "minigame") {
    startMinigame(m);
  } else if (m.t === "minigame_cancel") {
    if (minigame && minigame.id === m.id) {
      if (minigame.purpose === "respawn") {
        respawnStarting = false;
        respawnSpawn = null;
      }
      closeMinigame();
    }
    if (m.text) toast(m.text);
  } else if (m.t === "minigame_rejected") {
    if (m.request !== undefined && m.request !== respawnRequest) return;
    respawnStarting = false;
    respawnSpawn = null;
    toast(m.text);
  }
}

function renderLobby() {
  $("me").textContent = myName;
  $("lobbyCode").textContent = lobby.code || "";
  $("lobbyPrivacy").textContent = lobby.private
    ? "Private: join by code only."
    : "Open: players can join randomly or by code.";
  const spectators = lobby.players.filter((player) => player.team === "spectator");
  $("spectatorList").textContent = spectators.length
    ? "Spectators: " + spectators.map((player) => player.name + (player.name === lobby.host ? " (host)" : "")).join(", ")
    : "";
  for (const [team, el] of [
    ["red", "redList"],
    ["blue", "blueList"],
  ]) {
    $(el).innerHTML = "";
    for (const p of lobby.players.filter((p) => p.team === team)) {
      const li = document.createElement("li");
      li.textContent =
        p.name +
        (p.name === lobby.host ? " (host)" : "") +
        (p.connected ? "" : " (offline)");
      $(el).appendChild(li);
    }
  }
  const iAmHost = lobby.host === myName;
  $("btnPrivacy").classList.toggle("hidden", !iAmHost);
  $("btnPrivacy").textContent = lobby.private ? "Make open to random joining" : "Make private (code only)";
  $("btnStart").classList.toggle("hidden", !iAmHost);
  $("lobbyMsg").textContent = iAmHost
    ? "You are the host. Start whenever teams look right (solo is allowed)."
    : "Waiting for the host to start...";
}

// On page load: a valid session cookie means we skip the login screen (session survives refresh)
fetch("/api/me").then(async (r) => {
  if (r.ok) {
    myName = (await r.json()).username;
    $("me").textContent = myName;
    connect();
  } else {
    show("auth");
  }
});

// ---------- input ----------
addEventListener("keydown", (e) => {
  if (e.target && $("musicControls").contains(e.target)) return;
  if (minigame) {
    if (e.code === "Escape") {
      finishMinigame(false, "You gave up the challenge.");
    } else if (minigame.purpose === "extraction" &&
        ["KeyW", "KeyA", "KeyS", "KeyD"].includes(e.code)) {
      keys[e.code] = true;
    }
    e.preventDefault();
    return;
  }
  if (snap && ["Tab", "Space"].includes(e.code)) {
    e.preventDefault();
  }
  if (e.repeat) {
    keys[e.code] = true;
    return;
  }
  if (e.code === "KeyX" && !keys.KeyX && snap && myTeam === "red") {
    disposalLine = DISPOSAL_MESSAGES[Math.floor(Math.random() * DISPOSAL_MESSAGES.length)];
  }
  keys[e.code] = true;
  if (!snap) {
    return;
  }
  const canControlCharacter = myTeam === "red" ? snap.me.alive : snap.me.possessed;
  if (canControlCharacter && e.code === "Space") {
    act("pad");
    return;
  }
  if (canControlCharacter && !isRadar() && (e.code === "KeyQ" || e.code === "KeyE")) {
    act(e.code === "KeyQ" ? "knife" : "weapon_cycle");
    return;
  }
  if (myTeam === "red") {
    if (!snap.me.alive) return;
    if (e.code === "KeyZ") {
      act("steal");
    } else if (e.code === "KeyF") {
      hackMode = !hackMode;
      toast(hackMode ? "Hack mode ON: click a server, door, camera, or laser" : "Hack mode off");
    } else if (e.code === "Tab") {
      redRadar = !redRadar;
      radarView = null;
      panDrag = null;
    } else if (e.code === "Escape") {
      redRadar = false;
      radarView = null;
      panDrag = null;
    }
  } else if (myTeam === "spectator") {
    if (e.code === "Tab" || e.code === "Escape") {
      redRadar = e.code === "Tab" ? !redRadar : false;
      radarView = null;
      panDrag = null;
    }
  } else if (myTeam === "blue") {
    if (e.code === "Tab") {
      act("view");
    } else if (e.code === "Escape" && snap.me.possessed) {
      act("exit");
    } else if (e.code === "KeyF") {
      act("dark");
    } else if (e.code === "KeyZ" || e.code === "KeyX") {
      if (isRadar() && !radarView) {
        toast("Radar is still opening. Try again.");
        return;
      }
      const view = isRadar() ? radarView : cam;
      act(e.code === "KeyZ" ? "alert" : "emp", {
        x: (mouse.x - view.ox) / view.s,
        y: (mouse.y - view.oy) / view.s,
      });
    }
  }
});
addEventListener("keyup", (e) => {
  keys[e.code] = false;
});
addEventListener("blur", () => {
  for (const k in keys) {
    keys[k] = false;
  }
  mouse.down = false;
  panDrag = null;
  if (minigame) finishMinigame(false, "The game window lost focus.");
});
cv.addEventListener("mousemove", (e) => {
  mouse.x = e.clientX;
  mouse.y = e.clientY;
  if (panDrag && radarView) {
    if (Math.hypot(e.clientX - panDrag.startX, e.clientY - panDrag.startY) >= 5) {
      panDrag.moved = true;
    }
    if (panDrag.moved) {
      radarView.follow = false;
      radarView.ox = panDrag.ox + (e.clientX - panDrag.x);
      radarView.oy = panDrag.oy + (e.clientY - panDrag.y);
    }
  }
});
addEventListener("mouseup", (e) => {
  if (e.button === 0) {
    mouse.down = false;
    const gesture = panDrag;
    panDrag = null;
    if (gesture && !gesture.moved && !gesture.zoomed && e.target === cv && isRadar()) {
      if (myTeam === "red") {
        if (!snap.me.alive) respawnClick(gesture.world);
        else hackClick(gesture.world);
      } else if (myTeam === "blue") {
        radarClick(gesture.world);
      }
    }
  }
});
cv.addEventListener("contextmenu", (e) => e.preventDefault());
cv.addEventListener("mousedown", (e) => {
  mouse.x = e.clientX;
  mouse.y = e.clientY;
  if (!snap) {
    return;
  }
  if (minigame && minigame.purpose !== "extraction") return;
  if (e.button !== 0) {
    return;
  }
  if (isRadar() && radarView) {
    panDrag = {
      x: e.clientX,
      y: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      ox: radarView.ox,
      oy: radarView.oy,
      world: {
        x: (e.clientX - radarView.ox) / radarView.s,
        y: (e.clientY - radarView.oy) / radarView.s,
      },
      moved: false,
      zoomed: false,
    };
    return;
  }
  const w = toWorld(mouse.x, mouse.y);
  if (myTeam === "red" && isRadar()) {
    return hackClick(w);
  }
  if (myTeam === "red" && hackMode && hackClick(w)) {
    mouse.down = false;
    return;
  }
  if (myTeam === "blue" && isRadar()) {
    return radarClick(w);
  }
  if (myTeam !== "spectator") mouse.down = true;
});
// Follow mode zooms around the player; manual mode zooms around the pointer.
cv.addEventListener(
  "wheel",
  (e) => {
    if (!isRadar() || !radarView) {
      return;
    }
    e.preventDefault();
    const v = radarView;
    const s = Math.max(v.s0, Math.min(v.s0 * 8, v.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    const focus = (myTeam === "red" && snap.me.alive) || myTeam === "spectator" ? snap.me
      : myTeam === "blue" && snap.me.possessed ? snap.me.guard : null;
    const followPlayer = v.follow && focus;
    const wx = followPlayer ? focus.x : (e.clientX - v.ox) / v.s;
    const wy = followPlayer ? focus.y : (e.clientY - v.oy) / v.s;
    const anchorX = followPlayer ? cv.width / 2 : e.clientX;
    const anchorY = followPlayer ? cv.height / 2 : e.clientY;
    v.s = s;
    v.ox = anchorX - wx * s;
    v.oy = anchorY - wy * s;
    if (followPlayer) {
      v.followX = focus.x;
      v.followY = focus.y;
    }
    if (panDrag) {
      panDrag.zoomed = true;
      panDrag.x = e.clientX;
      panDrag.y = e.clientY;
      panDrag.ox = v.ox;
      panDrag.oy = v.oy;
    }
  },
  { passive: false },
);
const toWorld = (sx, sy) => ({ x: (sx - cam.ox) / cam.s, y: (sy - cam.oy) / cam.s });
// Radar is always available to Blue and toggled with Tab by Red.
const isRadar = () =>
  !!snap &&
  ((myTeam === "blue" && !(snap.me.possessed && snap.me.view === "shooter")) ||
    (myTeam === "red" && (redRadar || !snap.me.alive)) ||
    (myTeam === "spectator" && redRadar));

// Send our input 30 times per second
setInterval(() => {
  if (!snap || !map) {
    return;
  }
  if (minigame) {
    const moving = minigame.purpose === "extraction";
    const self = myTeam === "red" || myTeam === "spectator" ? snap.me : snap.me.guard;
    send({
      t: "input",
      mx: moving ? (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0) : 0,
      my: moving ? (keys.KeyS ? 1 : 0) - (keys.KeyW ? 1 : 0) : 0,
      ax: self ? self.x + Math.cos(lastAim) * 100 : 0,
      ay: self ? self.y + Math.sin(lastAim) * 100 : 0,
      fire: false, use: false, dispose: false,
    });
    return;
  }
  const w = toWorld(mouse.x, mouse.y);
  const canShoot =
    ((myTeam === "red" && snap.me.alive) || myTeam === "blue") && !isRadar();
  let ax = w.x,
    ay = w.y;
  const self = myTeam === "red" ? snap.me : snap.me.guard;
  if (isRadar() && self) {
    ax = self.x + Math.cos(lastAim) * 100;
    ay = self.y + Math.sin(lastAim) * 100;
  } // don't turn the character while on the radar
  send({
    t: "input",
    mx: (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0),
    my: (keys.KeyS ? 1 : 0) - (keys.KeyW ? 1 : 0),
    ax,
    ay,
    fire: mouse.down && canShoot,
    use: false,
    dispose: myTeam === "red" && !!keys.KeyX,
  });
}, 33);

function hackClick(w) {
  const radar = isRadar();
  let best = null,
    bd = radar ? Math.max(80, 26 / cam.s) : Infinity;
  const consider = (kind, id, x, y) => {
    const d = Math.hypot(w.x - x, w.y - y);
    if (d < bd) {
      bd = d;
      best = { kind, id };
    }
  };
  const inside = (object) =>
    w.x >= object.x && w.x <= object.x + object.w &&
    w.y >= object.y && w.y <= object.y + object.h;
  map.doors.forEach((d) => {
    if (radar || inside(d)) consider("hack", d.id, d.x + d.w / 2, d.y + d.h / 2);
  });
  map.cameras.forEach((c) => {
    if (radar || Math.hypot(w.x - c.x, w.y - c.y) <= 8) consider("hack", c.id, c.x, c.y);
  });
  map.lasers.forEach((l) => {
    if (radar || inside(l)) consider("hack", l.id, l.x + l.w / 2, l.y + l.h / 2);
  });
  map.servers.forEach((server) => {
    if (radar || (Math.abs(w.x - server.x) <= 22 && Math.abs(w.y - server.y) <= 22)) {
      consider("server_start", server.id, server.x, server.y);
    }
  });
  if (best) {
    act(best.kind, { id: best.id });
    return true;
  }
  return false;
}

function radarClick(w) {
  let best = null,
    bd = Math.max(80, 26 / cam.s);
  const consider = (kind, id, x, y, max) => {
    const d = Math.hypot(w.x - x, w.y - y);
    if (d < Math.min(bd, max || 80)) {
      bd = d;
      best = { kind, id };
    }
  };
  snap.markers.forEach((m) => consider("possess", m.id, m.x, m.y, 70));
  snap.servers.forEach((s, i) =>
    consider("counter", s.id, map.servers[i].x, map.servers[i].y, 70),
  );
  map.doors.forEach((d) =>
    consider("door", d.id, d.x + d.w / 2, d.y + d.h / 2, Math.max(d.w, d.h) / 2 + 20),
  );
  map.lasers.forEach((l) => consider("laser", l.id, l.x + l.w / 2, l.y + l.h / 2, 100));
  map.cameras.forEach((camera, i) => {
    if (snap.cams[i] && snap.cams[i].h) {
      consider("camera", camera.id, camera.x, camera.y);
    }
  });
  if (best) {
    act(best.kind, { id: best.id });
  }
}

// ---------- minigames ----------
function respawnClick(point) {
  let selected = -1;
  let distance = 20 / radarView.s;
  map.redSpawns.forEach((spawn, index) => {
    const d = Math.hypot(point.x - spawn.x, point.y - spawn.y);
    if (d <= distance) {
      selected = index;
      distance = d;
    }
  });
  if (selected < 0) return;
  startRespawn(selected);
}

function startRespawn(spawn) {
  if (respawnStarting || minigame) return;
  if (!ws || ws.readyState !== 1) {
    toast("Not connected. Reconnect before starting a reboot.");
    return;
  }
  respawnStarting = true;
  respawnSpawn = spawn;
  const request = ++respawnRequest;
  act("respawn_start", { request });
  setTimeout(() => {
    if (respawnStarting && !minigame && request === respawnRequest) {
      respawnStarting = false;
      respawnSpawn = null;
      toast("Reboot request timed out. Try again.");
    }
  }, 3000);
}

function startMinigame(message) {
  if (message.purpose === "respawn" &&
      (!respawnStarting || respawnSpawn === null || message.request !== respawnRequest)) {
    act("respawn_result", { id: message.id, ok: false });
    return;
  }
  if (!["flappy", "maze", "meteors"].includes(message.game)) {
    toast("Unknown minigame received.");
    if (message.purpose === "respawn") act("respawn_result", { id: message.id, ok: false });
    respawnStarting = false;
    respawnSpawn = null;
    return;
  }
  closeMinigame();
  if (message.purpose !== "extraction") {
    for (const key in keys) keys[key] = false;
  }
  mouse.down = false;
  const instructions = {
    flappy: "Click inside the box to start. Move UP or DOWN through the blue gates until the action finishes. Keep the mouse inside the box.",
    maze: "Click to start at your mouse. Follow the path from GREEN to YELLOW, staying ahead of the RED trail. A new path starts at the finish. Keep going until the action finishes.",
    meteors: "Click inside the box to start. Move your mouse to dodge the falling meteors until the action finishes. Keep the mouse inside the box.",
  };
  $("minigameTitle").textContent = message.purpose === "respawn" ? "REBOOT"
    : message.purpose === "extraction" ? "EXTRACT " + message.server : "COUNTERHACK";
  $("minigameTitle").textContent += " - " + {
    flappy: "GATES", maze: "MAZE", meteors: "METEORS",
  }[message.game];
  $("minigameInstructions").textContent = instructions[message.game];
  if (message.purpose === "extraction") {
    $("minigameInstructions").textContent += " Move with WASD while playing.";
  } else if (message.purpose === "respawn") {
    $("minigameInstructions").textContent += " Auto-respawn may end this challenge.";
  }
  minigame = { purpose: message.purpose, id: message.id, server: message.server, spawn: respawnSpawn, started: performance.now(), seconds: message.seconds };
  const spawn = minigame.spawn;
  minigame.game = new MouseMinigame(
    $("minigameCanvas"), message.game, message.seconds, finishMinigame,
    () => {
      const action = message.purpose === "extraction" ? "server_ready"
        : message.purpose === "respawn" ? "respawn_ready" : "cm_ready";
      const details = { id: message.id };
      if (message.purpose === "respawn") details.spawn = spawn;
      act(action, details);
    },
    message.entrySeconds,
  );
  $("minigameProgress").classList.toggle("hidden", message.purpose !== "extraction");
  $("cmTimer").classList.remove("hidden");
  $("counter").classList.toggle("extraction-overlay", message.purpose === "extraction");
  $("game").classList.toggle("extraction-active", message.purpose === "extraction");
  $("counter").classList.remove("hidden");
}

function closeMinigame() {
  if (minigame && minigame.game && !minigame.game.ended) {
    minigame.game.ended = true;
    minigame.game.canvas.removeEventListener("pointerdown", minigame.game.onDown);
    minigame.game.canvas.removeEventListener("pointerenter", minigame.game.onMove);
    minigame.game.canvas.removeEventListener("pointermove", minigame.game.onMove);
    minigame.game.canvas.removeEventListener("pointerleave", minigame.game.onLeave);
  }
  minigame = null;
  $("game").classList.remove("extraction-active");
  $("counter").classList.remove("extraction-overlay");
  $("counter").classList.add("hidden");
}

function finishMinigame(ok, reason = "") {
  if (!minigame) return;
  const attempt = minigame;
  closeMinigame();
  if (!ok && reason) toast("Challenge failed: " + reason);
  if (attempt.purpose === "respawn") {
    respawnStarting = false;
    respawnSpawn = null;
    act("respawn_result", { id: attempt.id, ok });
  } else if (attempt.purpose === "extraction") {
    act("server_result", { id: attempt.id, ok });
  } else {
    act("cm_result", { id: attempt.id, ok });
  }
}
$("minigameCancel").onclick = () => finishMinigame(false, "You gave up the challenge.");

// ---------- drawing ----------
function resize() {
  cv.width = fog.width = innerWidth;
  cv.height = fog.height = innerHeight;
}
addEventListener("resize", resize);
resize();

function circle(x, y, r, fill, stroke, lw) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 7);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw || 2;
    ctx.stroke();
  }
}
function body(x, y, a, fill, ring) {
  circle(x, y, cfg.playerRadius, fill, ring, 3);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(
    x + Math.cos(a) * cfg.playerRadius * 1.5,
    y + Math.sin(a) * cfg.playerRadius * 1.5,
  );
  ctx.stroke();
}
function healthBar(x, y, hp, maximum) {
  const fraction = Math.max(0, Math.min(1, hp / maximum));
  ctx.fillStyle = "#000";
  ctx.fillRect(x - 14, y - 26, 28, 4);
  ctx.fillStyle = "#6f6";
  ctx.fillRect(x - 14, y - 26, 28 * fraction, 4);
}

function drawGpsDirection(marker) {
  if (!Number.isFinite(marker.a)) return;
  const halfAngle = cfg.guardFovDegrees * Math.PI / 360;
  ctx.beginPath();
  ctx.arc(marker.x, marker.y, 75, marker.a - halfAngle, marker.a + halfAngle);
  ctx.arc(marker.x, marker.y, 55, marker.a + halfAngle, marker.a - halfAngle, true);
  ctx.closePath();
  ctx.fillStyle = "rgba(74,163,255,.22)";
  ctx.fill();
}

function drawGuardGps(marker) {
  drawGpsDirection(marker);
  circle(marker.x, marker.y, 55, "rgba(74,163,255,.22)",
    marker.taken ? "rgba(150,150,150,.7)" : "#4aa3ff", 3);
  circle(marker.x, marker.y, 7, "#4aa3ff");
}
function text(t, x, y, color, size) {
  ctx.fillStyle = color || "#fff";
  ctx.font = (size || 14) + "px Consolas, monospace";
  ctx.textAlign = "center";
  ctx.fillText(t, x, y);
}

function drawEmpFields() {
  for (const emp of snap.emps || []) {
    circle(emp.x, emp.y, emp.radius, "rgba(90,180,255,.18)", "#5ab0ff", 4);
    text("EMP " + emp.seconds + "s", emp.x, emp.y, "#bde8ff", 18);
  }
}

function drawTeleportPads() {
  for (const pad of snap.pads || []) {
    circle(pad.x, pad.y, 6, "#4aa3ff", "#d9efff", 2);
  }
}

const mapImg = new Image();
mapImg.src = "/facility.png";

// Clip each ray against the same wall and closed-door rectangles used by server sight.
function cameraRayDistance(x, y, angle, range, obstacles) {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let nearest = range;
  for (const rect of obstacles) {
    let enter = 0;
    let exit = nearest;
    if (Math.abs(dx) < 1e-12) {
      if (x < rect.x || x > rect.x + rect.w) continue;
    } else {
      const first = (rect.x - x) / dx;
      const second = (rect.x + rect.w - x) / dx;
      enter = Math.max(enter, Math.min(first, second));
      exit = Math.min(exit, Math.max(first, second));
    }
    if (Math.abs(dy) < 1e-12) {
      if (y < rect.y || y > rect.y + rect.h) continue;
    } else {
      const first = (rect.y - y) / dy;
      const second = (rect.y + rect.h - y) / dy;
      enter = Math.max(enter, Math.min(first, second));
      exit = Math.min(exit, Math.max(first, second));
    }
    if (enter <= exit) nearest = enter;
  }
  return nearest;
}

function cameraVisibilityPoints(camera, angle, obstacles) {
  const range = 380;
  const halfAngle = 0.6;
  const nearby = obstacles.filter((rect) =>
    rect.x <= camera.x + range && rect.x + rect.w >= camera.x - range &&
    rect.y <= camera.y + range && rect.y + rect.h >= camera.y - range);
  const angles = [];
  for (let i = 0; i <= 48; i++) {
    angles.push(-halfAngle + 2 * halfAngle * i / 48);
  }
  for (const rect of nearby) {
    for (const x of [rect.x, rect.x + rect.w]) {
      for (const y of [rect.y, rect.y + rect.h]) {
        const difference = Math.atan2(y - camera.y, x - camera.x) - angle;
        const offset = Math.atan2(Math.sin(difference), Math.cos(difference));
        for (const delta of [-0.00001, 0, 0.00001]) {
          if (offset + delta > -halfAngle && offset + delta < halfAngle) {
            angles.push(offset + delta);
          }
        }
      }
    }
  }
  angles.sort((a, b) => a - b);
  return angles.map((offset) => {
    const rayAngle = angle + offset;
    const distance = cameraRayDistance(camera.x, camera.y, rayAngle, range, nearby);
    return { x: camera.x + Math.cos(rayAngle) * distance, y: camera.y + Math.sin(rayAngle) * distance };
  });
}

let cameraVisibilityCache = new Map();
let cameraVisibilityMap = null;
function cachedCameraVisibility(camera, state, obstacles, doorStates, wallRevision) {
  if (cameraVisibilityMap !== map) {
    cameraVisibilityMap = map;
    cameraVisibilityCache = new Map();
  }
  const cached = cameraVisibilityCache.get(state.id);
  if (cached && cached.angle === state.a && cached.doors === doorStates &&
      cached.walls === wallRevision) return cached.points;
  const points = cameraVisibilityPoints(camera, state.a, obstacles);
  cameraVisibilityCache.set(state.id, { angle: state.a, doors: doorStates, walls: wallRevision, points });
  return points;
}

let wallDisplayMap = null;
let displayWalls = [];
let removedWallAreas = [];
let displayedBlasts = 0;
function updateDisplayWalls() {
  const blasts = snap.wallBlasts || [];
  if (wallDisplayMap !== map || blasts.length < displayedBlasts) {
    wallDisplayMap = map;
    displayWalls = map.walls;
    removedWallAreas = [];
    displayedBlasts = 0;
  }
  while (displayedBlasts < blasts.length) {
    const result = WallDestruction.carve(displayWalls, blasts[displayedBlasts]);
    displayWalls = result.walls;
    removedWallAreas.push(...result.removed);
    displayedBlasts++;
  }
}

function drawWorld(radar) {
  updateDisplayWalls();
  const W = map.WORLD.w,
    H = map.WORLD.h;
  ctx.fillStyle = "#0b0f14";
  ctx.fillRect(0, 0, W, H);
  if (radar) {
    // Radar views use the detailed artwork (with a green tactical tint)
    if (mapImg.complete && mapImg.naturalWidth) {
      ctx.drawImage(mapImg, 0, 0, W, H);
    }
    ctx.fillStyle = "#18222c";
    removedWallAreas.forEach((rect) => ctx.fillRect(rect.x, rect.y, rect.w, rect.h));
    ctx.fillStyle = "rgba(2,22,14,.62)";
    ctx.fillRect(0, 0, W, H);
  } else {
    // Shooter views use the simplified map: floor + the exact collidable wall rectangles
    ctx.fillStyle = "#18222c";
    ctx.fillRect(0, 0, W, H);
    ctx.beginPath();
    displayWalls.forEach((r) => ctx.rect(r.x, r.y, r.w, r.h));
    ctx.fillStyle = "#56677a";
    ctx.fill();
  }
  snap.lockers.forEach((l, i) => {
    const k = map.lockers[i];
    ctx.fillStyle = l.r ? "#2fd17a" : "#3b4b44";
    ctx.fillRect(k.x - 16, k.y - 16, 32, 32);
    text("L", k.x, k.y + 5, "#042", 14);
  });

  snap.servers.forEach((s, i) => {
    const m = map.servers[i];
    ctx.fillStyle = s.done ? "#2fd17a" : s.ex ? "#ffb84d" : "#5b7394";
    ctx.fillRect(m.x - 22, m.y - 22, 44, 44);
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 2;
    ctx.strokeRect(m.x - 22, m.y - 22, 44, 44);
    text(s.id, m.x, m.y + 5, "#000", 16);
    ctx.fillStyle = "#000";
    ctx.fillRect(m.x - 30, m.y + 28, 60, 8);
    ctx.fillStyle = "#6ff2a8";
    ctx.fillRect(m.x - 30, m.y + 28, 60 * s.p, 8);
    if (radar && myTeam === "blue" && s.ex && !s.cu) {
      circle(m.x, m.y, 62, null, "#ff4d6d", 3);
      text("COUNTERHACK", m.x, m.y - 70, "#ff4d6d", 16);
    }
  });

  snap.doors.forEach((d, i) => {
    const m = map.doors[i];
    ctx.fillStyle = d.c ? "rgba(220,60,60,.9)" : "rgba(60,220,140,.25)";
    ctx.fillRect(m.x, m.y, m.w, m.h);
    if (radar || hackMode) {
      text(
        d.id + (d.c ? " CLOSED" : " OPEN") + (d.e && d.h ? " (EMP)" : ""),
        m.x + m.w / 2,
        m.y + m.h / 2 + 5,
        "#fff",
        12,
      );
    }
  });

  snap.lasers.forEach((l, i) => {
    const m = map.lasers[i];
    const disabledByHack = l.h && !l.on;
    if (radar) {
      ctx.fillStyle = disabledByHack ? "rgba(60,220,140,.22)" : "rgba(255,60,60,.22)";
      ctx.fillRect(m.x, m.y, m.w, m.h);
      ctx.strokeStyle = disabledByHack ? "#3cdc8c" : "#ff6666";
      ctx.lineWidth = Math.max(3, 2 / cam.s);
      ctx.setLineDash([]);
    } else {
      ctx.strokeStyle = disabledByHack ? "rgba(60,220,140,.7)" : "rgba(255,60,60,.35)";
      ctx.setLineDash([6, 6]);
    }
    ctx.strokeRect(m.x, m.y, m.w, m.h);
    ctx.setLineDash([]);
    if (l.on) {
      ctx.strokeStyle = "#ff2a2a";
      ctx.lineWidth = radar ? Math.max(5, 3 / cam.s) : 5;
      ctx.beginPath();
      if (m.axis === "x") {
        ctx.moveTo(l.b, m.y);
        ctx.lineTo(l.b, m.y + m.h);
      } else {
        ctx.moveTo(m.x, l.b);
        ctx.lineTo(m.x + m.w, l.b);
      }
      ctx.stroke();
    }
    if ((radar || hackMode) && (!l.on || (l.h && l.e))) {
      text(
        l.id + (l.on ? " ON (EMP)" : l.h ? " HACKED" : " OFF"),
        m.x + m.w / 2,
        m.y - (radar ? Math.max(6, 5 / cam.s) : 6),
        disabledByHack ? "#6ff2a8" : radar ? "#ffaaaa" : "#ff8a8a",
        radar ? Math.max(12, 12 / cam.s) : 12,
      );
    }
  });

  const cameraObstacles = displayWalls.concat(
    map.doors.filter((door, i) => snap.doors[i] && snap.doors[i].c),
  );
  const doorStates = snap.doors.map((door) => door.c ? "1" : "0").join("");
  snap.cams.forEach((c, i) => {
    const m = map.cameras[i];
    if (c.on) {
      ctx.fillStyle = "rgba(255,211,77,.10)";
      ctx.beginPath();
      ctx.moveTo(m.x, m.y);
      cachedCameraVisibility(m, c, cameraObstacles, doorStates, displayedBlasts).forEach((point) => {
        ctx.lineTo(point.x, point.y);
      });
      ctx.closePath();
      ctx.fill();
    }
    circle(m.x, m.y, 8, c.on ? "#ffd34d" : "#555");
    if (radar || hackMode) {
      text(c.id + (c.h ? (c.e ? " ON (EMP)" : " HACKED") : ""), m.x, m.y - 12, "#ffd34d", 12);
    }
  });
}

// F2 toggles a debug overlay: red = collision walls, plus world coordinates under the mouse
let debugWalls = false;
addEventListener("keydown", (e) => {
  if (e.code === "F2") {
    e.preventDefault();
    debugWalls = !debugWalls;
  }
});
function drawDebug() {
  if (!debugWalls) {
    return;
  }
  ctx.fillStyle = "rgba(255,0,0,.35)";
  ctx.strokeStyle = "rgba(255,120,120,.9)";
  ctx.lineWidth = 1;
  displayWalls.forEach((r) => {
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  });
  const w = toWorld(mouse.x, mouse.y);
  text(Math.round(w.x) + ", " + Math.round(w.y), w.x, w.y - 20, "#ff0", 18);
}

function drawEntities(selfGuardId) {
  drawKnifeSwings();
  (snap.corpses || []).forEach((c) => {
    ctx.globalAlpha = c.inv ? 0.3 : 0.9;
    circle(
      c.x,
      c.y,
      cfg.playerRadius * 0.875,
      c.k === "red" ? "#7a2a3a" : "#24476e",
      "#000",
      2,
    );
    text("x", c.x, c.y + 5, "#fff", 16);
    if (c.tag && !c.inv) {
      circle(c.x + 10, c.y - 10, 4, "#ffd34d");
    }
    ctx.globalAlpha = 1;
  });
  (snap.guards || []).forEach((g) => {
    if (g.id === selfGuardId) {
      return;
    }
    const d = smoothPosition(g.id, g.x, g.y);
    body(d.x, d.y, g.a, "#4aa3ff", g.c ? "#ff3b3b" : g.p ? "#3ff" : "#1b5a9c");
    healthBar(d.x, d.y, g.hp, cfg.guardHp);
  });
  (snap.reds || []).forEach((r) => {
    if (r.tracked || r.cameraDetected || r.extracting) {
      return;
    }
    const d = smoothPosition("r" + r.n, r.x, r.y);
    const disguised = r.dg && myTeam !== "spectator";
    body(d.x, d.y, r.a, disguised ? "#4aa3ff" : "#ff4d6d", disguised ? "#ffd34d" : "#a02040");
    healthBar(d.x, d.y, r.hp, cfg.redHp);
    text(r.n, d.x, d.y - 34, "#ff9bb0", 12);
  });
  (snap.bullets || []).forEach((b) => circle(b.x, b.y, 3.5, "#ffe066"));
  (snap.grenades || []).forEach((g) => circle(g.x, g.y, 6, "#7fe07f", "#000", 1));
  (snap.boom || []).forEach((b) =>
    circle(b.x, b.y, cfg.grenadeRadius, "rgba(255,150,40,.35)", "#ffb347", 3),
  );
}

function drawKnifeSwings() {
  ctx.fillStyle = "rgba(255, 35, 35, 0.35)";
  (snap.knifeSwings || []).forEach((swing) => {
    ctx.beginPath();
    ctx.moveTo(swing.x, swing.y);
    ctx.arc(swing.x, swing.y, swing.radius,
      swing.angle - swing.halfAngle, swing.angle + swing.halfAngle);
    ctx.closePath();
    ctx.fill();
  });
}

function drawVision(cx, cy, aim, nightVision) {
  const dark = snap.dark > 0 && !nightVision;
  fx.globalCompositeOperation = "source-over";
  fx.clearRect(0, 0, fog.width, fog.height);
  fx.fillStyle = dark ? "rgba(0,0,0,0.96)" : "rgba(0,0,0,0.6)";
  fx.fillRect(0, 0, fog.width, fog.height);
  fx.globalCompositeOperation = "destination-out";
  const hole = (r, cone) => {
    const g = fx.createRadialGradient(cx, cy, r * 0.5, cx, cy, r);
    g.addColorStop(0, "rgba(0,0,0,1)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    fx.fillStyle = g;
    fx.beginPath();
    if (cone) {
      const h = (cfg.coneDeg * Math.PI) / 360;
      fx.moveTo(cx, cy);
      fx.arc(cx, cy, r, aim - h, aim + h);
      fx.closePath();
    } else {
      fx.arc(cx, cy, r, 0, 7);
    }
    fx.fill();
  };
  if (dark) {
    hole(cfg.darkRadius, false);
    hole(cfg.coneRange, true);
  } else {
    hole(cfg.litRadius, false);
  }
  ctx.drawImage(fog, 0, 0);
}

function drawShooter() {
  const me = snap.me,
    cw = cv.width,
    ch = cv.height;
  const sp = myTeam === "blue" ? me.guard : me;
  const c = smoothPosition("self", sp.x, sp.y);
  cam = { s: 1, ox: cw / 2 - c.x, oy: ch / 2 - c.y };
  ctx.setTransform(1, 0, 0, 1, cam.ox, cam.oy);
  drawWorld(false);
  drawDebug();
  drawEntities(myTeam === "blue" ? me.guard.id : null);
  const aim = Math.atan2(mouse.y - ch / 2, mouse.x - cw / 2);
  if (myTeam === "red") {
    if (me.alive) {
      body(
        c.x,
        c.y,
        aim,
        me.disguised ? "#4aa3ff" : "#ff6f8a",
        me.disguised ? "#ffd34d" : "#fff",
      );
    }
  } else if (myTeam === "spectator") {
    circle(c.x, c.y, cfg.playerRadius, "#999", "#ddd", 2);
  } else {
    body(c.x, c.y, aim, "#3ff", "#fff");
  }
  lastAim = aim;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (myTeam !== "spectator") drawVision(cw / 2, ch / 2, aim, myTeam === "blue");
  ctx.setTransform(1, 0, 0, 1, cam.ox, cam.oy);
  drawEmpFields();
  drawTeleportPads();
  if (myTeam === "blue") {
    (snap.pings || []).filter((ping) => ping.k === "manual").forEach((ping) => {
      circle(ping.x, ping.y, 30, null, "#ffd34d", 3);
      text("INVESTIGATE", ping.x, ping.y - 40, "#ffd34d", 16);
    });
    (snap.markers || []).filter((marker) => !marker.mine).forEach(drawGuardGps);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (myTeam === "blue") {
    // Revealed players remain visible outside the guard's sight.
    ctx.setTransform(1, 0, 0, 1, cam.ox, cam.oy);
    (snap.reds || [])
      .filter((red) => red.tracked || red.cameraDetected || red.extracting)
      .forEach((red) => {
        const position = smoothPosition("r" + red.n, red.x, red.y);
        body(
          position.x,
          position.y,
          red.a,
          red.dg ? "#4aa3ff" : "#ff4d6d",
          red.dg ? "#ffd34d" : "#a02040",
        );
        healthBar(position.x, position.y, red.hp, cfg.redHp);
        text(red.n, position.x, position.y - 34, "#ff9bb0", 12);
      });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  if (myTeam === "red" && snap.gps) {
    // Hacked guard GPS: drawn on top of the fog so Red sees guards through walls
    ctx.setTransform(1, 0, 0, 1, cam.ox, cam.oy);
    snap.gps.forEach((marker) => {
      drawGuardGps(marker);
      if (marker.viewerName) text(marker.viewerName, marker.x, marker.y - 78, "#9cf", 14);
    });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  // crosshair
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(mouse.x, mouse.y, 8, 0, 7);
  ctx.stroke();
}

function drawRadar() {
  const cw = cv.width,
    ch = cv.height,
    W = map.WORLD.w,
    H = map.WORLD.h;
  const selectingSpawn = myTeam === "red" && !snap.me.alive;
  const s0 = selectingSpawn
    ? Math.min(Math.max(1, cw - 100) / W, Math.max(1, ch - 140) / H)
    : Math.min(cw / W, (ch - 70) / H);
  // Open near the player; Blue without a guard uses its last guard position or map center.
  if (!radarView) {
    const focus = selectingSpawn ? { x: W / 2, y: H / 2 }
      : myTeam === "red" || myTeam === "spectator" ? snap.me : lastBluePosition || { x: W / 2, y: H / 2 };
    const scale = selectingSpawn ? s0 : s0 * 3;
    radarView = {
      s0,
      s: scale,
      ox: cw / 2 - focus.x * scale,
      oy: ch / 2 - focus.y * scale,
      follow: !selectingSpawn,
      followX: focus.x,
      followY: focus.y,
    };
  }
  radarView.s0 = s0;
  if (radarView.s < s0) {
    radarView.s = s0;
  }
  const focus = (myTeam === "red" && snap.me.alive) || myTeam === "spectator" ? snap.me
    : myTeam === "blue" && snap.me.possessed ? snap.me.guard : null;
  if (radarView.follow && focus) {
    const dx = (focus.x - radarView.followX) * radarView.s;
    const dy = (focus.y - radarView.followY) * radarView.s;
    radarView.ox -= dx;
    radarView.oy -= dy;
    if (panDrag && !panDrag.moved) {
      panDrag.ox -= dx;
      panDrag.oy -= dy;
    }
    radarView.followX = focus.x;
    radarView.followY = focus.y;
  }
  cam = { s: radarView.s, ox: radarView.ox, oy: radarView.oy };
  ctx.setTransform(cam.s, 0, 0, cam.s, cam.ox, cam.oy);
  drawWorld(true);
  drawEmpFields();
  drawTeleportPads();
  drawDebug();
  if (myTeam === "spectator") {
    drawKnifeSwings();
    (snap.guards || []).forEach((guard) => {
      body(guard.x, guard.y, guard.a, "#4aa3ff", "#1b5a9c");
      healthBar(guard.x, guard.y, guard.hp, cfg.guardHp);
    });
    (snap.reds || []).forEach((red) => {
      body(red.x, red.y, red.a, "#ff4d6d", "#a02040");
      healthBar(red.x, red.y, red.hp, cfg.redHp);
      text(red.n, red.x, red.y - 34, "#ff9bb0", 14);
    });
    (snap.bullets || []).forEach((bullet) => circle(bullet.x, bullet.y, 5, "#ffe066"));
    circle(snap.me.x, snap.me.y, cfg.playerRadius, "#999", "#ddd", 2);
    text("YOU", snap.me.x, snap.me.y - 34, "#ddd", 14);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return;
  }
  if (myTeam === "red") {
    drawKnifeSwings();
    (snap.gps || []).forEach(drawGuardGps);
    (snap.reds || []).forEach((r) => {
      circle(r.x, r.y, cfg.playerRadius * 0.75, "#ff4d6d", "#fff", 2);
      healthBar(r.x, r.y, r.hp, cfg.redHp);
      text(r.n, r.x, r.y - 34, "#ff9bb0", 14);
    });
    (snap.bullets || []).forEach((bullet) => circle(bullet.x, bullet.y, 5, "#ffe066"));
    if (snap.me.alive) {
      circle(snap.me.x, snap.me.y, cfg.playerRadius * 0.875, "#ffd34d", "#fff", 3);
      text("YOU", snap.me.x, snap.me.y - 34, "#ffd34d", 16);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return;
  }
  snap.markers.forEach((m) => {
    if (!m.mine) drawGpsDirection(m);
    circle(
      m.x,
      m.y,
      55,
      m.taken ? "rgba(150,150,150,.2)" : "rgba(74,163,255,.22)",
      m.mine ? "#3ff" : "#4aa3ff",
      3,
    );
    circle(m.x, m.y, 7, m.mine ? "#3ff" : "#4aa3ff");
    if (m.mine) text("YOU", m.x, m.y - 62, "#9cf", 14);
  });
  snap.pings.forEach((p) => {
    const col = p.k === "shot" ? "#ff9f43" : p.k === "laser" ? "#ff3b3b" : "#ffd34d";
    circle(p.x, p.y, 24 + (Date.now() % 800) / 40, null, col, 3);
    text(
      p.k === "shot" ? "SHOT" : p.k === "laser" ? "LASER" : p.k === "manual" ? "INVESTIGATE" : "ALERT!",
      p.x,
      p.y - 40,
      col,
      14,
    );
  });
  // Use the shot-warning pulse, enlarged and red, for ongoing security alerts.
  const alertRadius = 72 + ((Date.now() % 800) / 800) * 60;
  const drawAlert = (x, y, label) => {
    circle(x, y, alertRadius, null, "#ff3b3b", 6);
    text(label, x, y - 50, "#ff3b3b", 18);
  };
  snap.doors.forEach((door, i) => {
    if (door.h) {
      const location = map.doors[i];
      drawAlert(
        location.x + location.w / 2,
        location.y + location.h / 2,
        door.id + " HACKED",
      );
    }
  });
  snap.lasers.forEach((laser, i) => {
    if (laser.h) {
      const location = map.lasers[i];
      drawAlert(
        location.x + location.w / 2,
        location.y + location.h / 2,
        laser.id + " HACKED",
      );
    }
  });
  snap.cams.forEach((camera, i) => {
    if (camera.h) {
      const location = map.cameras[i];
      drawAlert(location.x, location.y, camera.id + " HACKED");
    }
  });
  const extractingNames = new Set((snap.extractingReds || []).map((red) => red.n));
  snap.detectedReds.forEach((red) => {
    if (!extractingNames.has(red.name)) drawAlert(red.x, red.y, red.name);
  });
  (snap.extractingReds || []).forEach((red) => drawAlert(red.x, red.y, red.n + " EXTRACTING"));
  const drawnCameraPlayers = new Set();
  [...(snap.extractingReds || []), ...(snap.camSeen || [])].forEach((red) => {
    if (drawnCameraPlayers.has(red.n)) {
      return;
    }
    drawnCameraPlayers.add(red.n);
    body(red.x, red.y, red.a, "#ff4d6d", "#a02040");
    healthBar(red.x, red.y, red.hp, cfg.redHp);
    text(red.n, red.x, red.y - 34, "#ff9bb0", 14);
  });
  if (snap.me.guard) {
    circle(snap.me.guard.x, snap.me.guard.y, cfg.playerRadius * 0.75, "#3ff", "#fff", 3);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function drawRespawnMarkers() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  map.redSpawns.forEach((spawn, index) => {
    const x = cam.ox + spawn.x * cam.s;
    const y = cam.oy + spawn.y * cam.s;
    circle(x, y, 16, "#4b1824", "#ff8ba0", 3);
    text(String(index + 1), x, y + 5, "#fff", 14);
  });
}

// ---------- HUD ----------
function nearest(list, x, y, r) {
  return list.find((o) => Math.hypot(o.x - x, o.y - y) < r);
}
const DISPOSAL_MESSAGES = [
  "Placing rug over corpse...",
  "Telling corpse it's a houseplant now...",
  "Arranging tiny flowers around corpse...",
  "Placing 'nothing to see here' sticker...",
  "Eating corpse...",
  "Sacraficing corpse to the Devil...",
  "Feeding corpse to inter-dimensional space worms...",
  "Placing corpse in cardboard box",
  "Turning corpse face-down...",
  "Teaching corpse to play dead...",
  "Stuffing corpse into shoe...",
  "Teleporting corpse back to the future...",
  "Taking one last awkward selfie...",
  "Sprinkling evidence with glitter...",
  "Deleting corpse's browser history...",
  "Whispering, 'You saw nothing'...",
  "Waiting for awkwardness to pass...",
  "Negotiating with corpse's spirit...",
  "Checking if Hell accepts walk ins...",
  "Waiting for screaming to stop...",
  "Running `DELETE FROM corpses`...",
  "Committing corpse to Git...",
  "Sending corpse to garbage collection...",
  "Compressing corpse into a ZIP file...",
  "Deploying corpse to production...",
  "Checking for zombie processes...",
  "Adding corpse to ignore list...",
  "Deleting corpse recursively...",
  "Resolving fatal runtime error...",
  "Adding fake mustache...",
  "Updating corpse's relationship status...",
  "Adding googly eyes...",
  "Calling someone who knows a guy...",
  "Placing wet floor sign on corpse...",
  "Checking corpse for a return policy...",
  "Placing corpse in lost-and-found...",
  "Explaining the situation to a pigeon...",
  "Uploading corpse to the cloud...",
  "Giving corpse a non-disclosure agreement...",
  "Removing corpse before shareholders arrive...",
  "Charging corpse a disposal fee...",
  "Throwing corpse into haunted Uber...",
  "Stuffing corpse into piñata...",
  "Offering corpse to a passing magician...",
  "Checking if corpse has plot armor...",
  "Calling Deadpool for cleanup...",
  "Sending corpse to another dimension...",
  "Retconning corpse's birth...",
  "Giving one final monologue to corpse ...",
  "Liquidating corpse's assets...",
  "Writing corpse off as 'business expense'...",
  "Entering corpse into a pyramid scheme...",
  "Entering corpse into a ponzi scheme...",
  "Selling corpse on eBay as lightly-used...",
  "Explaining cryptocurrency to corpse...", 
  "Sending corpse to the Nether...",
  "Sending corpse to lobby...",
  "Setting corpse on fire...",
  "Realizing corpse is your long-lost father...",
  "Offering corpse to the neighborhood raccoon...",
  "Turning corpse into a cat tree...",
  "Calling the crows for pickup...",
  "Letting a pack of feral cats handle logistics...",
  "Convincing corpse this was his idea...",
  "Disguising corpse as an exceptionally lazy dog...",
 
];

function escapeHud(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function hudStat(label, value, state = "") {
  return `<span class="hud-stat ${state}">${escapeHud(label)} <strong>${escapeHud(value)}</strong></span>`;
}

function hudPanel(title, contents, extraClass = "") {
  return `<div class="hud-panel ${extraClass}"><div class="hud-heading">${escapeHud(title)}</div><div class="hud-values">${contents}</div></div>`;
}

function healthPanel(entity, maximum, title, teamClass) {
  const fraction = Math.max(0, Math.min(1, entity.hp / maximum));
  const armorFraction = Math.max(0, Math.min(1, entity.armor / cfg.maxArmor));
  const health = hudStat("HP", `${entity.hp}/${maximum}`, fraction <= 0.3 ? "danger" : "");
  const armor = hudStat("Armor", entity.armor);
  return `<div class="hud-panel ${teamClass}"><div class="hud-heading">${escapeHud(title)}</div><div class="hud-values">${health}${armor}</div><div class="hud-meter armor"><span style="width:${armorFraction * 100}%"></span></div><div class="hud-meter${fraction <= 0.3 ? " low" : ""}"><span style="width:${fraction * 100}%"></span></div></div>`;
}

function equipmentPanel(entity) {
  const items = Object.entries(entity.guns)
    .map(([gun, ammo]) => hudStat(gun, ammo, gun === entity.cur ? "ready" : ""))
    .join("");
  return hudPanel("Equipment",
    hudStat("Selected", entity.cur.toUpperCase(), "warning") + items +
    hudStat("Grenades", entity.grenades), "hud-equipment");
}

function cooldownStat(label, seconds) {
  return hudStat(label, seconds ? `${seconds}s` : "READY", seconds ? "warning" : "ready");
}

function updateHud() {
  const me = snap.me;
  const mm = Math.floor(snap.left / 60),
    ss = String(snap.left % 60).padStart(2, "0");
  const servers = snap.servers.map((s) =>
    hudStat(s.id, s.done ? "DONE" : Math.floor(s.p * 100) + "%", s.done ? "done" : ""))
    .join("");
  const respawnClock = myTeam === "red" && !me.alive
    ? `<div class="respawn-clock">AUTO RESPAWN ${escapeHud(me.respawnLeft)}s</div>` : "";
  const matchPanel = `<div class="hud-panel"><div class="hud-heading">Match time</div><div class="hud-clock">${mm}:${ss}</div>${respawnClock}</div>`;
  let panels = "";
  let hint = "";
  if (myTeam === "spectator") {
    panels = `<div class="hud-row">${hudPanel("Spectator", hudStat("Mode", "WATCHING"))}</div>`;
    hint = isRadar()
      ? "Spectator map: Tab closes | scroll zoom, drag pan | WASD move"
      : "Spectator: WASD move through walls | Tab opens map";
  } else if (myTeam === "red") {
    const charges = hudStat("Counter-Hacks", `${me.charges.a}/${me.charges.m}`) +
      (me.charges.n ? hudStat("Next", `${me.charges.n}s`, "warning") : "") +
      (hackMode ? hudStat("Hack mode", "ON", "warning") : "") +
      (me.disguised ? hudStat("Disguise", "ACTIVE", "ready") : "") +
      (me.hasPad ? hudStat("Pad", me.padSet ? "Space: teleport" : "Space: place", "ready") : "");
    panels = `<div class="hud-row">${healthPanel(me, cfg.redHp, "Red hacker", "hud-team-red") +
      equipmentPanel(me)}</div><div class="hud-row">${hudPanel("Hacking", charges)}</div>`;
    const sv = map.servers.find(
      (s, i) => !snap.servers[i].done && Math.hypot(s.x - me.x, s.y - me.y) < 95,
    );
    const corpse = (snap.corpses || []).find(
      (c) => c.k === "guard" && !c.inv && Math.hypot(c.x - me.x, c.y - me.y) < 60,
    );
    if (me.disposing != null) {
      hint = (disposalLine || "Disposing body...") + " " + Math.round(me.disposing * 100) + "%";
    } else if (sv) {
      hint = hackMode
        ? "Click " + sv.id + " to start extraction"
        : "Open radar or press F for hack mode, then click " + sv.id + " to start extraction";
    } else if (corpse) {
      hint = (corpse.tag ? "Z: steal nametag   " : "") + "Hold X: dispose body";
    }
    if (redRadar && me.alive) {
      hint =
        "RADAR (Tab/Esc to close). Click a nearby server to extract or a device to hack. Scroll to zoom, left-drag to pan";
    } else if (!hint) {
      hint = "Tab: open radar map";
    }
    if (!me.alive) {
      hint = respawnStarting
        ? "Reboot selected. Complete the challenge or wait for auto-respawn."
        : "CONNECTION LOST: click a numbered spawn to reboot | scroll zoom, drag pan";
    }
  } else {
    const charges = hudStat("Hacks", `${me.charges.a}/${me.charges.m}`) +
      (me.charges.n ? hudStat("Next", `${me.charges.n}s`, "warning") : "");
    const blackout = snap.dark
      ? hudStat("F Blackout", `ACTIVE ${snap.dark}s`, "warning")
      : me.darkCd
        ? hudStat("F Blackout", `COOLDOWN ${me.darkCd}s`, "warning")
        : hudStat("F Blackout", "READY", "ready");
    const abilities = cooldownStat("Z Alert", me.alertCd) +
      cooldownStat("X EMP", me.empCd) + blackout;
    const possession = me.possessed ? "ACTIVE (Esc exit, Tab view)"
      : me.possessCd ? `cooldown ${me.possessCd}s` : "READY";
    let equipment = "";
    let teleport = "";
    if (me.guard) {
      const guard = me.guard;
      equipment = `<div class="hud-row">${healthPanel(guard, cfg.guardHp, "Possessed guard", "hud-team-blue") +
        equipmentPanel(guard)}</div>`;
      if (guard.hasPad) {
        teleport = hudStat("Pad", guard.padSet ? "Space: teleport" : "Space: place", "ready");
      }
    }
    const security = charges + hudStat("Possession", possession,
      me.possessCd && !me.possessed ? "warning" : "ready") + abilities + teleport;
    panels = equipment + `<div class="hud-row">${hudPanel("Blue security", security, "hud-team-blue")}</div>`;
    hint = isRadar()
      ? "Radar: click objects | Z investigate at mouse | X EMP at mouse | scroll zoom, drag pan"
      : "Guard view: WASD move, click shoot, Q knife, E cycle weapons, Z investigate, X EMP at mouse";
  }
  const blackoutPanel = myTeam === "red" && snap.dark
    ? `<div class="hud-row">${hudPanel("Status", hudStat("BLACKOUT", snap.dark + "s", "warning"))}</div>`
    : "";
  const html = panels + blackoutPanel;
  if ($("hud").innerHTML !== html) $("hud").innerHTML = html;
  if ($("matchStatus").innerHTML !== matchPanel) $("matchStatus").innerHTML = matchPanel;
  const serverPanel = hudPanel("Servers", servers);
  if ($("serverStatus").innerHTML !== serverPanel) $("serverStatus").innerHTML = serverPanel;
  $("hint").textContent = hint;
}

function frame() {
  requestAnimationFrame(frame);
  if (!snap || !map || $("game").classList.contains("hidden")) {
    return;
  }
  if (minigame) {
    const remaining = minigame.game.remainingSeconds();
    $("cmTimer").classList.toggle("hidden",
      minigame.purpose === "extraction" && minigame.game.playStarted !== null);
    $("cmTime").textContent = Math.ceil(remaining);
    $("cmTimeLabel").textContent = minigame.game.playStarted === null
      ? "Click to start within"
      : remaining > 0 ? "Time left" : "Finishing";
    if (minigame.purpose === "extraction") {
      const server = snap.servers.find((item) => item.id === minigame.server);
      if (server) {
        $("minigameProgress").textContent = "Extraction: " + Math.floor(server.p * 100) +
          "% - reaches 100% while you play";
      }
    }
    if (remaining <= 0 && minigame.game.playStarted === null) {
      finishMinigame(false, minigame.game.timeoutReason());
    } else {
      minigame.game.draw();
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#05080c";
  ctx.fillRect(0, 0, cv.width, cv.height);
  if (isRadar()) {
    drawRadar();
  } else {
    drawShooter();
  }
  const selectingSpawn = myTeam === "red" && !snap.me.alive;
  const tint = selectingSpawn ? "rgba(100, 100, 100, 0.4)"
    : myTeam === "blue" && snap.dark > 0 ? "rgba(80, 255, 115, 0.12)"
    : myTeam === "red" && snap.me.alive && hackMode ? "rgba(255, 80, 80, 0.12)"
    : null;
  if (tint) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, cv.width, cv.height);
    if (!selectingSpawn) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.15)";
      ctx.fillRect(0, 0, cv.width, cv.height);
    }
    ctx.restore();
  }
  if (selectingSpawn) drawRespawnMarkers();
  updateHud();
}
requestAnimationFrame(frame);
