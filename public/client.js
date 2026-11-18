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
let bluePlacement = null;
let spaceCorpseAction = null;
let minigame = null;
let respawnStarting = false;
let respawnRequest = 0;
let respawnSpawn = null;
let cam = { s: 1, ox: 0, oy: 0 }; // world-to-screen scale and x/y offsets
let shooterLook = { x: 0, y: 0 };
let equipmentWheelUntil = 0;
let equipmentWheelSelection = null;
const equipmentSprites = Object.fromEntries([
  ["pistol", "/pistol.png"],
  ["smg", "/SMG.png"],
  ["grenade", "/grenade.png"],
  ["pad", "/TP.png"],
  ["knife", "/Knife.png"],
].map(([name, src]) => {
  const image = new Image();
  image.src = src;
  return [name, image];
}));
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
let musicEnabled = false;
let musicRequest = 0;
$("musicToggle").textContent = "Play music";
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
$("blueBlackout").onclick = () => act("dark");
$("blueEmp").onclick = () => {
  bluePlacement = bluePlacement === "emp" ? null : "emp";
  toast(bluePlacement ? "EMP armed. Click an open point on the radar to place it." : "EMP placement cancelled.");
};
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
$("btnRecoil").onclick = () => send({ t: "recoil_enabled", enabled: !lobby.recoilEnabled });
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
    renderTeamControls();
    bluePlacement = null;
    shooterLook = { x: 0, y: 0 };
    equipmentWheelUntil = 0;
    equipmentWheelSelection = null;
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

function renderTeamControls() {
  const controls = myTeam === "red"
    ? `<p><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> Move · Hold <kbd>Shift</kbd> Run</p>
       <p><span class="mouse-symbol">LMB</span> Fire/use · <span class="mouse-symbol">RMB</span> Hack nearby target</p>
       <p><kbd>R</kbd> Reload · <kbd>1</kbd>–<kbd>5</kbd> / <span class="mouse-symbol">Wheel</span> Equipment</p>
       <p><kbd>Space</kbd> Steal ID / dispose corpse · <kbd>Tab</kbd> Radar</p>`
    : myTeam === "blue"
      ? `<p><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> Move · Hold <kbd>Shift</kbd> Run</p>
         <p><span class="mouse-symbol">LMB</span> Fire/use · <kbd>R</kbd> Reload</p>
         <p><kbd>1</kbd>–<kbd>5</kbd> / <span class="mouse-symbol">Wheel</span> Equipment</p>
         <p><kbd>Tab</kbd> Radar / release guard</p>
         <p>Radar: <span class="mouse-symbol">LMB</span> Interact · <span class="mouse-symbol">RMB</span> Alert</p>`
      : "<p>Join or watch a match to view controls.</p>";
  $("teamControlsBody").innerHTML = controls;
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
  $("btnRecoil").classList.toggle("hidden", !iAmHost);
  $("btnRecoil").textContent = `Recoil: ${lobby.recoilEnabled === false ? "OFF" : "ON"}`;
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
    } else if (minigame.purpose === "extraction" && e.key === "Shift") {
      keys.Shift = true;
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
  if (e.code === "Space" && !keys.Space && snap && myTeam === "red") {
    disposalLine = DISPOSAL_MESSAGES[Math.floor(Math.random() * DISPOSAL_MESSAGES.length)];
    const corpse = nearest((snap.corpses || []).filter((item) => item.k === "guard" && !item.inv), snap.me.x, snap.me.y, 60);
    spaceCorpseAction = corpse && corpse.k === "guard" && !corpse.inv
      ? (corpse.tag ? "steal" : "dispose") : null;
    if (spaceCorpseAction === "steal") act("steal");
  }
  keys[e.code] = true;
  if (!snap) {
    return;
  }
  const canControlCharacter = myTeam === "red" ? snap.me.alive : snap.me.possessed;
  const weaponKeys = { Digit1: "pistol", Digit2: "smg", Digit3: "grenade", Digit4: "pad", Digit5: "knife" };
  if (canControlCharacter && !isRadar() && e.code === "KeyR") {
    act("reload");
    return;
  }
  if (canControlCharacter && !isRadar() && weaponKeys[e.code]) {
    equipmentWheelSelection = weaponKeys[e.code];
    equipmentWheelUntil = performance.now() + 450;
    act("weapon_select", { weapon: equipmentWheelSelection });
    return;
  }
  if (myTeam === "red") {
    if (!snap.me.alive) return;
    if (e.code === "Tab") {
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
      bluePlacement = null;
      act("view");
    }
  }
});
addEventListener("keyup", (e) => {
  keys[e.code] = false;
  if (e.key === "Shift") keys.Shift = false;
  if (e.code === "Space") spaceCorpseAction = null;
});
addEventListener("blur", () => {
  for (const k in keys) {
    keys[k] = false;
  }
  mouse.down = false;
  panDrag = null;
  spaceCorpseAction = null;
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
  if (e.button === 2) {
    const point = toWorld(e.clientX, e.clientY);
    if (myTeam === "red") {
      if (snap.me.alive) hackClick(point);
    } else if (myTeam === "blue" && isRadar() && radarView) {
      act("alert", { x: point.x, y: point.y });
    }
    return;
  }
  if (e.button !== 0) return;
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
  if (myTeam === "blue" && isRadar()) {
    return radarClick(w);
  }
  const controlled = myTeam === "red" ? snap.me : myTeam === "blue" ? snap.me.guard : null;
  if (controlled && controlled.cur === "pad") {
    act("use_equipped");
    mouse.down = false;
    return;
  }
  if (myTeam !== "spectator") mouse.down = true;
});
// Follow mode zooms around the player; manual mode zooms around the pointer.
cv.addEventListener(
  "wheel",
  (e) => {
    if (!isRadar()) {
      const canControlCharacter = myTeam === "red" ? snap.me.alive : myTeam === "blue" && snap.me.possessed;
      if (canControlCharacter) {
        e.preventDefault();
        const entity = myTeam === "red" ? snap.me : snap.me.guard;
        const items = heldEquipment(entity);
        if (items.length) {
          const current = items.indexOf(equipmentWheelSelection || entity.cur);
          const direction = e.deltaY < 0 ? -1 : 1;
          equipmentWheelSelection = items[(Math.max(0, current) + direction + items.length) % items.length];
          equipmentWheelUntil = performance.now() + 700;
          act("weapon_select", { weapon: equipmentWheelSelection });
        }
      }
      return;
    }
    if (!radarView) return;
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
      run: moving && !!(keys.ShiftLeft || keys.ShiftRight || keys.Shift),
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
    dispose: myTeam === "red" && spaceCorpseAction === "dispose",
    run: !!(keys.ShiftLeft || keys.ShiftRight || keys.Shift),
  });
}, 33);

function hackClick(w) {
  const radar = isRadar();
  if (!radar && snap.me.charges && snap.me.charges.a <= 0) return false;
  let best = null,
    bd = radar ? Math.max(80, 26 / cam.s) : Infinity;
  const consider = (kind, id, x, y) => {
    const d = Math.hypot(w.x - x, w.y - y);
    if (d < bd) {
      bd = d;
      best = { kind, id };
    }
  };
  const interactionPadding = radar ? 0 : 28;
  const inside = (object) =>
    w.x >= object.x - interactionPadding && w.x <= object.x + object.w + interactionPadding &&
    w.y >= object.y - interactionPadding && w.y <= object.y + object.h + interactionPadding;
  map.doors.forEach((d, i) => {
    const state = snap.doors[i];
    if ((!state || !state.h) && (radar || inside(d))) {
      consider("hack", d.id, d.x + d.w / 2, d.y + d.h / 2);
    }
  });
  map.cameras.forEach((c, i) => {
    const state = snap.cams[i];
    if ((!state || !state.h) && (radar || Math.hypot(w.x - c.x, w.y - c.y) <= 38)) {
      consider("hack", c.id, c.x, c.y);
    }
  });
  map.lasers.forEach((l, i) => {
    const state = snap.lasers[i];
    if ((!state || !state.h) && (radar || inside(l))) {
      consider("hack", l.id, l.x + l.w / 2, l.y + l.h / 2);
    }
  });
  map.servers.forEach((server) => {
    if (radar || (Math.abs(w.x - server.x) <= 48 && Math.abs(w.y - server.y) <= 48)) {
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
  if (myTeam === "blue" && bluePlacement === "emp") {
    act("emp", { x: w.x, y: w.y });
    bluePlacement = null;
    return true;
  }
  let best = null,
    bd = Math.max(140, 26 / cam.s);
  const consider = (kind, id, x, y, max) => {
    const d = Math.hypot(w.x - x, w.y - y);
    if (d < Math.min(bd, max || 80)) {
      bd = d;
      best = { kind, id };
    }
  };
  snap.markers.forEach((m) => consider("possess", m.id, m.x, m.y, 140));
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
    return true;
  }
  return false;
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
      toast("Respawn request timed out. Try again.");
    }
  }, 3000);
}

function startMinigame(message) {
  if (message.purpose === "respawn" &&
      (!respawnStarting || respawnSpawn === null || message.request !== respawnRequest)) {
    act("respawn_result", { id: message.id, ok: false });
    return;
  }
  if (!["flappy", "maze", "meteors", "pacman", "routing", "orbit", "scanner"].includes(message.game)) {
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
    flappy: "Fly through the blue gates.",
    maze: "Avoid the advancing lava trail.",
    meteors: "Avoid the falling meteors.",
    pacman: "Collect dots and avoid the moving ghosts.",
    routing: "Sweep through the numbered nodes in order.",
    orbit: "Keep the cursor inside the moving blue orbit ring.",
    scanner: "Stay inside the moving green scanner zone.",
  };
  $("minigameTitle").textContent = message.purpose === "respawn" ? "RESPAWN"
    : message.purpose === "extraction" ? "EXTRACT " + message.server : "COUNTERHACK";
  $("minigameTitle").textContent += " - " + {
    flappy: "FLAPPY", maze: "MAZE", meteors: "METEORS", pacman: "GHOST RUN",
    routing: "ROUTING", orbit: "ORBIT LOCK", scanner: "SCANNER",
  }[message.game];
  $("minigameInstructions").textContent = instructions[message.game];
  if (message.purpose === "extraction") {
    $("minigameInstructions").textContent += " Move with WASD while playing.";
  } else if (message.purpose === "respawn") {
    $("minigameInstructions").textContent += "";
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
    message.difficulty || 0,
  );
  $("minigameProgress").classList.toggle("hidden", message.purpose !== "extraction");
  $("cmTimer").classList.remove("hidden");
  $("counter").classList.toggle("extraction-overlay", message.purpose === "extraction");
  $("counter").classList.toggle("transparent-minigame", message.purpose !== "respawn");
  $("game").classList.toggle("extraction-active", message.purpose === "extraction");
  $("counter").classList.remove("hidden");
}

function closeMinigame() {
  if (minigame && minigame.game && !minigame.game.ended) {
    minigame.game.ended = true;
    minigame.game.canvas.removeEventListener("pointerdown", minigame.game.onDown);
    window.removeEventListener("pointermove", minigame.game.onMove);
  }
  minigame = null;
  $("game").classList.remove("extraction-active");
  $("counter").classList.remove("extraction-overlay", "transparent-minigame");
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
function healthBar(x, y, hp, maximum, armor = 0, reloadProgress = null) {
  const fraction = Math.max(0, Math.min(1, hp / maximum));
  ctx.fillStyle = "rgba(0,0,0,.82)";
  ctx.fillRect(x - 17, y - 31, 34, 5);
  ctx.fillStyle = "#ff657d";
  ctx.fillRect(x - 17, y - 31, 34 * fraction, 5);
  if (reloadProgress !== null) {
    ctx.fillStyle = "rgba(0,0,0,.82)";
    ctx.fillRect(x - 17, y - 38, 34, 4);
    ctx.fillStyle = "#ffd34d";
    ctx.fillRect(x - 17, y - 38, 34 * Math.max(0, Math.min(1, reloadProgress)), 4);
  }
  if (armor > 0) {
    ctx.fillStyle = "rgba(0,0,0,.82)";
    ctx.fillRect(x - 17, y - 24, 34, 3);
    ctx.fillStyle = "#5ab0ff";
    ctx.fillRect(x - 17, y - 24, 34 * Math.min(1, armor / cfg.maxArmor), 3);
  }
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
const lockerImg = new Image();
lockerImg.src = "/Locker.png";

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

function hackableHighlight(isHacked) {
  const favorable = myTeam === "red" ? isHacked : !isHacked;
  return favorable ? "#3cdc8c" : "#ff5c5c";
}

function hackableFill(isHacked) {
  return hackableHighlight(isHacked) === "#3cdc8c"
    ? "rgba(60,220,140,.25)" : "rgba(255,60,60,.25)";
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
    const size = 40;
    ctx.save();
    ctx.shadowColor = l.r ? "#2fd17a" : "transparent";
    ctx.shadowBlur = l.r ? 12 : 0;
    if (lockerImg.complete && lockerImg.naturalWidth) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(lockerImg, k.x - size / 2, k.y - size / 2, size, size);
    }
    ctx.restore();
    ctx.strokeStyle = l.r ? "#6ff2a8" : "#657180";
    ctx.lineWidth = radar ? Math.max(2, 1.5 / cam.s) : 2;
    ctx.strokeRect(k.x - size / 2 - 3, k.y - size / 2 - 3, size + 6, size + 6);
  });

  snap.servers.forEach((s, i) => {
    const m = map.servers[i];
    if (!s.done) {
      const pulse = 42 + ((performance.now() / 700) % 1) * 24;
      circle(m.x, m.y, pulse, null, s.ex ? "#ffd34d" : hackableHighlight(false), 3);
      ctx.fillStyle = "rgba(8,15,23,.92)";
      ctx.fillRect(m.x - 46, m.y - 61, 92, 21);
      text(s.ex ? "HACK IN PROGRESS" : "HACK TARGET", m.x, m.y - 45, "#fff", 12);
    }
    ctx.fillStyle = s.done ? "#2fd17a" : "#17283a";
    ctx.fillRect(m.x - 24, m.y - 24, 48, 48);
    ctx.strokeStyle = "#d8f3ff";
    ctx.lineWidth = 2;
    ctx.strokeRect(m.x - 24, m.y - 24, 48, 48);
    ctx.strokeStyle = s.done ? "#2a3a46" : hackableHighlight(!!s.ex);
    ctx.lineWidth = radar ? Math.max(1.5, 1 / cam.s) : 1.5;
    ctx.strokeRect(m.x - 27, m.y - 27, 54, 54);
    text("⚡", m.x, m.y + 8, s.done ? "#163b2a" : "#ffd34d", 24);
    text(s.id, m.x, m.y + 43, "#fff", 14);
    if (radar && myTeam === "blue" && s.ex && !s.cu) {
      circle(m.x, m.y, 62, null, "#ff4d6d", 3);
      text("COUNTERHACK", m.x, m.y - 70, "#ff4d6d", 16);
    }
  });

  snap.doors.forEach((d, i) => {
    const m = map.doors[i];
    ctx.fillStyle = hackableFill(!!d.h);
    ctx.fillRect(m.x, m.y, m.w, m.h);
    ctx.strokeStyle = hackableHighlight(!!d.h);
    ctx.lineWidth = radar ? Math.max(1.5, 1 / cam.s) : 1.5;
    ctx.strokeRect(m.x - 2, m.y - 2, m.w + 4, m.h + 4);
    if (radar || myTeam === "red") {
      text(
        d.id + (d.c ? " CLOSED" : " OPEN") + (d.e && d.h ? " (EMP)" : ""),
        m.x + m.w / 2,
        m.y + m.h / 2 + 5,
        hackableHighlight(!!d.h),
        12,
      );
    }
  });

  snap.lasers.forEach((l, i) => {
    const m = map.lasers[i];
    const disabledByHack = l.h && !l.on;
    if (radar) {
      ctx.fillStyle = hackableFill(!!l.h);
      ctx.fillRect(m.x, m.y, m.w, m.h);
      ctx.strokeStyle = hackableHighlight(!!l.h);
      ctx.lineWidth = Math.max(3, 2 / cam.s);
      ctx.setLineDash([]);
    } else {
      ctx.strokeStyle = hackableHighlight(!!l.h);
      ctx.setLineDash([6, 6]);
    }
    ctx.strokeRect(m.x, m.y, m.w, m.h);
    ctx.setLineDash([]);
    ctx.strokeStyle = hackableHighlight(!!l.h);
    ctx.lineWidth = radar ? Math.max(1.5, 1 / cam.s) : 1.5;
    ctx.strokeRect(m.x - 2, m.y - 2, m.w + 4, m.h + 4);
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
    if ((radar || myTeam === "red") && (!l.on || (l.h && l.e))) {
      text(
        l.id + (l.on ? " ON (EMP)" : l.h ? " HACKED" : " OFF"),
        m.x + m.w / 2,
        m.y - (radar ? Math.max(6, 5 / cam.s) : 6),
        hackableHighlight(!!l.h),
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
    circle(m.x, m.y, 13, null, hackableHighlight(!!c.h), radar ? Math.max(1.5, 1 / cam.s) : 1.5);
    if (radar || myTeam === "red") {
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

function drawDashTracer(entity) {
  if (!entity || !entity.d) return;
  const angle = Math.atan2(entity.y - entity.dy, entity.x - entity.dx);
  const startX = entity.x - Math.cos(angle) * 42;
  const startY = entity.y - Math.sin(angle) * 42;
  ctx.save();
  ctx.lineCap = "round";
  ctx.strokeStyle = "#c9ced4";
  ctx.globalAlpha = 0.24;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(startX, startY);
  ctx.lineTo(entity.x, entity.y);
  ctx.stroke();
  ctx.restore();
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
    drawDashTracer({ ...g, ...d });
    body(d.x, d.y, g.a, "#4aa3ff", g.c ? "#ff3b3b" : g.p ? "#3ff" : "#1b5a9c");
    healthBar(d.x, d.y, g.hp, cfg.guardHp, g.armor || 0);
  });
  (snap.reds || []).forEach((r) => {
    if (r.tracked || r.cameraDetected || r.extracting) {
      return;
    }
    const d = smoothPosition("r" + r.n, r.x, r.y);
    drawDashTracer({ ...r, ...d });
    const disguised = r.dg && myTeam !== "spectator";
    body(d.x, d.y, r.a, disguised ? "#4aa3ff" : "#ff4d6d", disguised ? "#ffd34d" : "#a02040");
    healthBar(d.x, d.y, r.hp, cfg.redHp, r.armor || 0);
    text(r.n, d.x, d.y - 34, "#ff9bb0", 12);
  });
  (snap.bullets || []).forEach((b) => circle(b.x, b.y, 3.5, "#ffe066"));
  (snap.grenades || []).forEach((g) => circle(g.x, g.y, 6, "#7fe07f", "#000", 1));
  (snap.boom || []).forEach((b) => {
    const progress = Math.max(0, Math.min(1, b.p || 0));
    const radius = cfg.grenadeRadius * (0.12 + progress * 0.88);
    const red = Math.round(255);
    const green = Math.round(205 * (1 - progress) + 60 * progress);
    const alpha = 0.48 * (1 - progress * 0.75);
    circle(
      b.x,
      b.y,
      radius,
      `rgba(${red},${green},20,${alpha})`,
      `rgb(${red},${green},30)`,
      3 + progress * 2,
    );
  });
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

function heldEquipment(entity) {
  if (!entity) return [];
  const items = [];
  if ((entity.guns.pistol || 0) > 0) items.push("pistol");
  if ((entity.guns.smg || 0) > 0) items.push("smg");
  if (entity.grenades > 0) items.push("grenade");
  if (entity.hasPad || entity.padSet) items.push("pad");
  items.push("knife");
  return items;
}

function drawEquipmentWheel(centerX, centerY) {
  const entity = myTeam === "red" ? snap.me : snap.me.guard;
  const items = heldEquipment(entity);
  const remaining = equipmentWheelUntil - performance.now();
  if (remaining <= 0 || !items.length) return;
  if (!items.includes(equipmentWheelSelection)) equipmentWheelSelection = entity.cur;
  const selected = items.includes(equipmentWheelSelection) ? equipmentWheelSelection : entity.cur;
  const radius = Math.min(145, cv.width * 0.12, cv.height * 0.18);
  const fade = Math.min(1, remaining / 125);
  const start = -Math.PI / 2;
  ctx.save();
  ctx.globalAlpha = fade;
  items.forEach((item, index) => {
    const angle = start + (index / items.length) * Math.PI * 2;
    const x = centerX + Math.cos(angle) * radius;
    const y = centerY + Math.sin(angle) * radius;
    circle(x, y, 38, item === selected ? "rgba(150,155,165,.92)" : "rgba(18,25,35,.9)",
      item === selected ? "#e2e5e9" : "#617083", item === selected ? 5 : 2);
    const image = equipmentSprites[item];
    if (image && image.complete && image.naturalWidth) {
      const height = item === "pad" ? 58 : 54;
      const width = item === "pad" ? height : height * 1.45;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(image, x - width / 2, y - height / 2, width, height);
    }
    const key = { pistol: "1", smg: "2", grenade: "3", pad: "4", knife: "5" }[item];
    circle(x + 28, y + 27, 10, "rgba(8,15,23,.96)", item === selected ? "#e2e5e9" : "#617083", 2);
    text(key, x + 28, y + 32, "#fff", 13);
  });
  ctx.restore();
}

function drawShooter() {
  const me = snap.me,
    cw = cv.width,
    ch = cv.height;
  const sp = myTeam === "blue" ? me.guard : me;
  const c = smoothPosition("self", sp.x, sp.y);
  const maxX = Math.min(120, cw * 0.12);
  const maxY = Math.min(90, ch * 0.12);
  const targetX = Math.max(-maxX, Math.min(maxX, (mouse.x - cw / 2) * 0.25));
  const targetY = Math.max(-maxY, Math.min(maxY, (mouse.y - ch / 2) * 0.25));
  shooterLook.x += (targetX - shooterLook.x) * 0.12;
  shooterLook.y += (targetY - shooterLook.y) * 0.12;
  cam = {
    s: 1,
    ox: cw / 2 - c.x - shooterLook.x,
    oy: ch / 2 - c.y - shooterLook.y,
  };
  ctx.setTransform(1, 0, 0, 1, cam.ox, cam.oy);
  drawWorld(false);
  drawDashTracer(sp);
  drawDebug();
  drawEntities(myTeam === "blue" ? me.guard.id : null);
  const playerScreenX = c.x + cam.ox;
  const playerScreenY = c.y + cam.oy;
  const aim = Math.atan2(mouse.y - playerScreenY, mouse.x - playerScreenX);
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
  if (myTeam === "red" && me.alive) healthBar(c.x, c.y, me.hp, cfg.redHp, me.armor || 0,
    me.reloading ? me.reloadProgress : null);
  if (myTeam === "blue" && me.guard) healthBar(c.x, c.y, me.guard.hp, cfg.guardHp, me.guard.armor || 0,
    me.guard.reloading ? me.guard.reloadProgress : null);
  lastAim = aim;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (myTeam !== "spectator") drawVision(playerScreenX, playerScreenY, aim, myTeam === "blue");
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
        healthBar(position.x, position.y, red.hp, cfg.redHp, red.armor || 0);
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
  drawEquipmentWheel(playerScreenX, playerScreenY);
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
  if (myTeam === "blue" && bluePlacement === "emp") {
    const point = toWorld(mouse.x, mouse.y);
    circle(point.x, point.y, Math.max(22, 14 / cam.s), "rgba(74,163,255,.35)", "#5ab0ff", 3);
  }
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

function updateEquipmentQuick() {
  $("chargeQuick").innerHTML = myTeam === "red"
    ? `<span class="charge-label">HACKS</span>${chargeCells(snap.me.charges, "#6ff2a8")}`
    : myTeam === "blue"
      ? `<span class="charge-label">SECURITY</span>${chargeCells(snap.me.charges, "#5ab0ff")}` : "";
  const entity = myTeam === "red" ? snap.me : myTeam === "blue" ? snap.me.guard : null;
  if (!entity) {
    $("equipmentQuick").innerHTML = "";
    return;
  }
  const item = entity.cur;
  const image = equipmentSprites[item];
  const key = { pistol: 1, smg: 2, grenade: 3, pad: 4, knife: 5 }[item] || "";
  const value = item === "pistol" || item === "smg"
    ? `${entity.guns[item] || 0}`
    : item === "grenade" ? `${entity.grenades || 0}`
      : item === "pad" ? (entity.padSet ? "SET" : "READY") : "∞";
  const status = `${key}`;
  const html = image ? `<img src="${image.src}" alt="${escapeHud(item)}">` : "";
  $("equipmentQuick").innerHTML = html +
    `<div><div class="equipment-caption">${escapeHud(item)} · ${escapeHud(status)}</div>` +
    `<div class="equipment-ammo">${escapeHud(value)}</div></div>`;
}

function chargeCells(status, color) {
  return `<span class="charge-cells" aria-label="${status.a} of ${status.m} charges ready">` +
    Array.from({ length: status.m }, (_, index) => {
      const progress = Math.max(0, Math.min(1, status.p?.[index] || 0));
      return `<span class="charge-cell"><span style="width:${progress * 100}%;background:${color}"></span></span>`;
    }).join("") + "</span>";
}

function cooldownStat(label, seconds) {
  return hudStat(label, seconds ? `${seconds}s` : "READY", seconds ? "warning" : "ready");
}

function updateHud() {
  const me = snap.me;
  updateEquipmentQuick();
  $("blueRadarControls").classList.toggle("hidden", !(myTeam === "blue" && isRadar()));
  $("blueEmp").setAttribute("aria-pressed", String(bluePlacement === "emp"));
  $("blueEmp").disabled = !bluePlacement && me.empCd > 0;
  $("blueBlackout").disabled = me.darkCd > 0;
  const mm = Math.floor(snap.left / 60),
    ss = String(snap.left % 60).padStart(2, "0");
  const servers = `<div class="server-meters">${snap.servers.map((s) =>
    `<div class="server-meter${s.done ? " done" : ""}" title="${escapeHud(s.id)}">` +
    `<span class="server-meter-fill" style="height:${Math.max(0, Math.min(100, s.p * 100))}%"></span>` +
    `<span class="server-meter-label">${escapeHud(s.id)}</span></div>`).join("")}</div>`;
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
    panels = "";
    const sv = map.servers.find(
      (s, i) => !snap.servers[i].done && Math.hypot(s.x - me.x, s.y - me.y) < 95,
    );
    const corpse = (snap.corpses || []).find(
      (c) => c.k === "guard" && !c.inv && Math.hypot(c.x - me.x, c.y - me.y) < 60,
    );
    if (me.disposing != null) {
      hint = (disposalLine || "Disposing body...") + " " + Math.round(me.disposing * 100) + "%";
    } else if (sv) {
      hint = "Right-click " + sv.id + " to start extraction";
    } else if (corpse) {
      hint = corpse.tag ? "Space: steal nametag" : "Hold Space: dispose body";
    }
    if (redRadar && me.alive) {
      hint =
        "RADAR (Tab/Esc to close). Click a nearby server to extract or a device to hack. Scroll to zoom, left-drag to pan";
    } else if (!hint) {
      hint = "Right-click: hack nearby device/server | 1–5 or wheel: select weapon/knife | Tab: radar";
    }
    if (!me.alive) {
      hint = respawnStarting
        ? "Respawn selected. Complete the challenge or wait for auto-respawn."
        : "CONNECTION LOST: click a numbered spawn to reboot | scroll zoom, drag pan";
    }
  } else {
    const charges = "";
    const blackout = snap.dark
      ? hudStat("Blackout", `ACTIVE ${snap.dark}s`, "warning")
      : me.darkCd
        ? hudStat("Blackout", `COOLDOWN ${me.darkCd}s`, "warning")
        : hudStat("Blackout", "READY", "ready");
    const alerts = hudStat("Alerts", `${me.alertCd.a}/${me.alertCd.m}`) +
      (me.alertCd.n ? hudStat("Next alert", `${me.alertCd.n}s`, "warning") : "");
    const abilities = alerts + cooldownStat("EMP", me.empCd) + blackout;
    const possession = me.possessed ? "ACTIVE (Tab opens radar and releases)"
      : me.possessCd ? `cooldown ${me.possessCd}s` : "READY";
    let teleport = "";
    if (me.guard && me.guard.hasPad) {
      teleport = hudStat("Pad", me.guard.padSet ? "Click: teleport" : "Click: place", "ready");
    }
    const security = charges + hudStat("Possession", possession,
      me.possessCd && !me.possessed ? "warning" : "ready") + abilities + teleport;
    panels = `<div class="hud-row">${hudPanel("Blue security", security, "hud-team-blue")}</div>`;
    hint = isRadar()
      ? (bluePlacement === "emp"
        ? "EMP armed: click a point on the radar to place it (EMP button cancels)"
        : "Radar: right-click anywhere to alert guards | left-click objects/guards to interact | scroll zoom, drag pan")
      : "Guard: WASD move, hold Shift to run, left click use, 1–5 or wheel select | Tab releases guard to radar";
  }
  const blackoutPanel = myTeam === "red" && snap.dark
    ? `<div class="hud-row">${hudPanel("Status", hudStat("BLACKOUT", snap.dark + "s", "warning"))}</div>`
    : "";
  const html = panels + blackoutPanel;
  if ($("hud").innerHTML !== html) $("hud").innerHTML = html;
  if ($("matchStatus").innerHTML !== matchPanel) $("matchStatus").innerHTML = matchPanel;
  if ($("serverStatus").innerHTML !== servers) $("serverStatus").innerHTML = servers;
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
