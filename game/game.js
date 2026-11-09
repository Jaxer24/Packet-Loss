// Packet Loss - authoritative game simulation.
// The server owns ALL game state. Clients only send inputs ("I'm holding W", "I clicked here")
// and receive snapshots filtered by what their role is allowed to know.
// Times such as `this.t` and `nextShot` are in seconds, not milliseconds.
// `dt` is the fixed duration of one simulation tick, also in seconds.

const C = require("./config");
const M = require("./map");
const { tickRedBot } = require("./red-bot");
const {
  dist,
  angleDiff,
  pushOutOfRect,
  segHitsRect,
  distPointToSegment,
} = require("./geom");

const RADIUS = C.playerRadius;
const KNIFE_RANGE = 52;
const KNIFE_HALF_ANGLE = 0.9;
const KNIFE_COOLDOWN_SECONDS = 0.5;
const KNIFE_EFFECT_SECONDS = 0.25;
const GUNS = {
  pistol: { capacity: C.pistolAmmo, cd: 0.35, spread: 0.03, dmg: C.pistolDamage },
  smg: { capacity: C.smgAmmo, cd: 0.09, spread: 0.12, dmg: C.smgDamage },
};
const nowSec = () => Date.now() / 1000;
const rid = () => Math.random().toString(36).slice(2, 7);
const num = (v, lo, hi) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0);
const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

class Game {
  // send(username, messageObject) is provided by server.js and writes to that user's sockets
  constructor(send) {
    this.send = send;
    this.players = new Map(); // username -> player
    this.phase = "lobby"; // lobby | playing | ended
    this.result = null;
    this.t = nowSec();
    this.host = null;
  }

  // =============== LOBBY ===============
  connect(name) {
    let p = this.players.get(name);
    if (!p) {
      const reds = [...this.players.values()].filter((x) => x.team === "red").length;
      const blues = [...this.players.values()].filter((x) => x.team === "blue").length;
      p = {
        name,
        team: this.phase === "lobby" ? (reds <= blues ? "red" : "blue") : "spectator",
      };
      this.players.set(name, p);
      if (p.team === "spectator") {
        p.x = M.WORLD.w / 2;
        p.y = M.WORLD.h / 2;
        p.input = { mx: 0, my: 0, ax: 0, ay: 0, fire: false, use: false, dispose: false };
      }
    }
    p.connected = true;
    if (!this.host) this.host = name;
    this.broadcastLobby();
    if (this.phase !== "lobby") {
      this.sendInit(p);
    }
  }

  disconnect(name) {
    const p = this.players.get(name);
    if (!p) {
      return;
    }
    p.connected = false;
    this.stopServerExtraction(p);
    if (p.input) {
      p.input = { ...p.input, mx: 0, my: 0, fire: false, use: false, dispose: false };
    }
    if (p.possessed && this.guards) this.releaseGuard(p);
    p.respawnGame = null;
    p.counter = null;
    if (this.phase === "lobby") {
      this.players.delete(name);
    }
    if (this.host === name) {
      this.host = [...this.players.values()].find((player) => player.connected && !player.bot)?.name || null;
    }
    this.broadcastLobby();
  }

  hostName() {
    return this.host;
  }

  lobbyMsg() {
    return {
      t: "lobby",
      phase: this.phase,
      result: this.result,
      host: this.hostName(),
      players: [...this.players.values()].map((p) => ({
        name: p.name,
        team: p.team,
        connected: !!p.connected,
      })),
    };
  }

  broadcastLobby() {
    const msg = this.lobbyMsg();
    for (const p of this.players.values()) {
      this.send(p.name, msg);
    }
  }

  toTeam(team, text) {
    for (const p of this.players.values()) {
      if (p.team === team) {
        this.send(p.name, { t: "event", text });
      }
    }
  }
  toAll(text) {
    for (const p of this.players.values()) {
      this.send(p.name, { t: "event", text });
    }
  }
  toPlayer(p, text) {
    this.send(p.name, { t: "event", text });
  }

  // =============== MATCH SETUP ===============
  startMatch() {
    const t = (this.t = nowSec());
    this.phase = "playing";
    this.result = null;
    this.wallState = null;
    this.wallBlasts = [];
    this.startedAt = t;
    this.endAt = t + C.matchSeconds;
    const list = [...this.players.values()].filter(
      (p) => p.team === "red" || p.team === "blue",
    );
    const reds = list.filter((p) => p.team === "red");
    const blues = list.filter((p) => p.team === "blue");
    if (!reds.length && blues.length) {
      const bot = { name: "Red Bot", team: "red", connected: true, bot: true };
      this.players.set(bot.name, bot);
      reds.push(bot);
      list.push(bot);
    }

    this.servers = M.servers.map((s) => ({
      id: s.id,
      x: s.x,
      y: s.y,
      progress: 0,
      done: false,
      extractor: null,
      counterUsed: false,
      counterBy: null,
      lockoutUntil: 0,
      counterCooldownUntil: 0,
      extractionId: null,
    }));
    this.doors = M.doors.map((d) => ({
      ...d,
      open: false,
    }));
    this.lasers = M.lasers.map((l) => ({
      ...l,
      hacked: false,
      beam: l.axis === "x" ? l.x : l.y,
    }));
    this.cams = M.cameras.map((c, i) => ({
      ...c,
      base: c.angle,
      hacked: false,
      phase: i * 1.7,
      seen: [],
    }));
    this.lockers = M.lockers.map((l) => ({ ...l, readyAt: 0 }));
    this.corpses = [];
    this.bullets = [];
    this.knifeSwings = [];
    this.grenades = [];
    this.pings = [];
    this.emps = [];
    this.alertCdUntil = 0;
    this.empCdUntil = 0;
    this.lightsOffUntil = 0;
    this.lightsCdUntil = 0;
    this.nextShift = t + C.guardRouteShiftSeconds;
    this.redPool = {
      max: Math.max(
        1,
        Math.round(
          C.remoteHackCharges *
            (1 + C.teamChargeMultiplier * (Math.max(1, reds.length) - 1)),
        ),
      ),
      cds: [],
    };
    this.bluePool = {
      max: Math.max(
        1,
        Math.round(
          C.blueSecurityCharges *
            (1 + C.teamChargeMultiplier * (Math.max(1, blues.length) - 1)),
        ),
      ),
      cds: [],
    };

    const guardCount = C.guardCountByRedPlayers[Math.min(3, reds.length)] || 5;
    const routeOrder = shuffle(M.routes.map((_, i) => i));
    this.guards = [];
    for (let i = 0; i < guardCount; i++) {
      this.guards.push(this.makeGuard(i, routeOrder[i % routeOrder.length]));
    }

    for (const p of list) {
      p.input = {
        mx: 0,
        my: 0,
        ax: 0,
        ay: 0,
        fire: false,
        use: false,
        dispose: false,
      };
      p.vx = 0;
      p.vy = 0;
      p.aim = 0;
      if (p.team === "red") {
        this.initRed(p, Math.floor(Math.random() * M.redSpawns.length));
      } else {
        p.view = "radar";
        p.possessed = null;
        p.possessCdUntil = 0;
        p.counter = null;
      }
    }
    for (const p of this.players.values()) {
      if (p.team === "spectator") {
        p.input = { mx: 0, my: 0, ax: 0, ay: 0, fire: false, use: false, dispose: false };
      }
    }
    for (const p of this.players.values()) {
      if (!p.bot) this.sendInit(p);
    }
    this.broadcastLobby();
  }

  initRed(p, spawnIndex) {
    const sp = M.redSpawns[spawnIndex] || M.redSpawns[0];
    Object.assign(p, {
      kind: "red",
      x: sp.x,
      y: sp.y,
      vx: 0,
      vy: 0,
      hp: C.redHp,
      armor: 0,
      alive: true,
      guns: { pistol: C.pistolAmmo },
      grenades: 0,
      cur: "pistol",
      nextShot: 0,
      disguise: null,
      markerId: null,
      pad: null,
      hasPad: false,
      deadAt: 0,
      respawnGame: null,
      extraction: null,
      laserHitAt: 0,
      disposing: null,
    });
    if (p.bot) {
      p.botThreat = null;
      p.botFleeUntil = 0;
      p.botRepathAt = 0;
      p.botPath = [];
      p.botPathTarget = null;
    }
  }

  makeGuard(index, routeId) {
    const route = M.routes[routeId];
    return {
      kind: "guard",
      id: "g" + index,
      idx: index,
      markerId: rid(),
      routeId,
      route,
      routeIdx: 1,
      x: route[0].x,
      y: route[0].y,
      vx: 0,
      vy: 0,
      hp: C.guardHp,
      armor: 0,
      alive: true,
      respawnAt: 0,
      state: "patrol",
      target: null,
      until: 0,
      lastSeen: 0,
      extractionTarget: null,
      path: [],
      repathAt: 0,
      angle: 0,
      nextShot: 0,
      possessedBy: null,
      input: null,
      guns: { pistol: C.pistolAmmo, smg: C.smgAmmo },
      grenades: 0,
      hasPad: false,
      pad: null,
      cur: "smg",
      aim: 0,
    };
  }

  sendInit(p) {
    this.send(p.name, {
      t: "init",
      map: M.clientMap,
      team: p.team,
      name: p.name,
      matchSeconds: C.matchSeconds,
      cfg: {
        litRadius: C.visionRadiusLit,
        darkRadius: C.visionRadiusDark,
        coneRange: C.visionConeRange,
        coneDeg: C.visionConeDegrees,
        serverHackSeconds: C.serverHackSeconds,
        respawnMax: C.respawnMaxSeconds,
        disposeSeconds: C.corpseDisposeSeconds,
        playerRadius: C.playerRadius,
        redHp: C.redHp,
        guardHp: C.guardHp,
        guardFovDegrees: C.guardFovDegrees,
        maxArmor: C.redMaxArmor,
        grenadeRadius: C.grenadeRadius,
      },
    });
  }

  // =============== INCOMING MESSAGES ===============
  handle(name, msg) {
    const p = this.players.get(name);
    if (!p || !msg || typeof msg.t !== "string") {
      return;
    }
    if (
      msg.t === "team" &&
      this.phase === "lobby" &&
      (msg.team === "red" || msg.team === "blue")
    ) {
      p.team = msg.team;
      this.broadcastLobby();
    } else if (msg.t === "start" && this.phase === "lobby" && name === this.hostName()) {
      const n = [...this.players.values()].filter(
        (x) => x.team === "red" || x.team === "blue",
      ).length;
      if (n < 1) {
        return this.toPlayer(p, "Need at least one player on a team.");
      }
      this.startMatch();
    } else if (msg.t === "lobby" && this.phase === "ended" && name === this.hostName()) {
      this.backToLobby();
    } else if (msg.t === "input" && this.phase === "playing" && p.input) {
      p.input = {
        mx: num(msg.mx, -1, 1),
        my: num(msg.my, -1, 1),
        ax: num(msg.ax, -1e5, 1e5),
        ay: num(msg.ay, -1e5, 1e5),
        fire: !!msg.fire,
        use: !!msg.use,
        dispose: !!msg.dispose,
      };
    } else if (msg.t === "act" && this.phase === "playing" && p.team !== "spectator") {
      this.act(p, msg);
    }
  }

  backToLobby() {
    this.phase = "lobby";
    this.result = null;
    for (const [name, p] of [...this.players]) {
      if (!p.connected || p.bot) {
        this.players.delete(name);
      }
    }
    this.broadcastLobby();
  }

  act(p, m) {
    const t = this.t;
    if (p.team === "red") {
      if (m.a === "respawn_start") {
        if (p.alive || p.respawnGame) {
          this.send(p.name, { t: "minigame_rejected", request: m.request, text: "Reboot unavailable. Try again shortly." });
          return;
        }
        const remaining = C.respawnMaxSeconds - (t - p.deadAt);
        if (remaining <= 0) {
          this.send(p.name, { t: "minigame_rejected", request: m.request, text: "Automatic respawn is imminent." });
          return;
        }
        const seconds = Math.min(C.counterhackSeconds, remaining);
        p.respawnGame = { id: rid(), startedAt: t, readyAt: null, seconds };
        this.send(p.name, {
          t: "minigame",
          purpose: "respawn",
          request: m.request,
          id: p.respawnGame.id,
          game: ["flappy", "maze", "meteors"][Math.floor(Math.random() * 3)],
          seconds,
          entrySeconds: Math.min(C.minigameEntrySeconds, remaining),
        });
        return;
      }
      if (m.a === "respawn_ready" && !p.alive && p.respawnGame &&
          m.id === p.respawnGame.id && p.respawnGame.readyAt === null &&
          t - p.respawnGame.startedAt < C.minigameEntrySeconds &&
          t - p.deadAt < C.respawnMaxSeconds) {
        p.respawnGame.readyAt = t;
        p.respawnGame.spawn = Math.round(num(m.spawn, 0, M.redSpawns.length - 1));
        return;
      }
      if (m.a === "respawn_result" && !p.alive && p.respawnGame && m.id === p.respawnGame.id) {
        const elapsed = p.respawnGame.readyAt === null ? -1 : t - p.respawnGame.readyAt;
        const seconds = p.respawnGame.seconds;
        if (m.ok === true && elapsed < seconds) return;
        const spawn = p.respawnGame.spawn;
        p.respawnGame = null;
        if (m.ok === true && elapsed >= seconds && t - p.deadAt < C.respawnMaxSeconds) {
          this.initRed(p, spawn);
          this.send(p.name, { t: "minigame_cancel", id: m.id, text: "Reboot complete." });
        } else {
          this.toPlayer(p, "Reboot failed. Try another minigame or wait for auto-respawn.");
        }
        return;
      }
      if (!p.alive) {
        return;
      }
      if (m.a === "knife") {
        p.cur = "knife";
      } else if (m.a === "weapon_cycle") {
        this.cycleWeapon(p, p);
      } else if (m.a === "steal") {
        this.stealTag(p);
      } else if (m.a === "pad") {
        this.usePad(p);
      } else if (m.a === "hack") {
        this.remoteHack(p, String(m.id));
      } else if (m.a === "server_start") {
        this.startServerExtraction(p, String(m.id));
      } else if (m.a === "server_ready" && p.extraction &&
          m.id === p.extraction.challengeId && p.extraction.readyAt === null &&
          t - p.extraction.startedAt < C.serverChallengeEntrySeconds) {
        p.extraction.readyAt = t;
      } else if (m.a === "server_result") {
        this.finishServerChallenge(p, m);
      }
    } else if (p.team === "blue") {
      this.blueAct(p, m);
    }
  }

  // =============== CHARGE POOLS ===============
  // `cds` contains the absolute time at which each spent charge becomes available.
  availableCharges(pool) {
    pool.cds = pool.cds.filter((x) => x > this.t);
    return pool.max - pool.cds.length;
  }

  // Spend one charge and schedule its individual recharge.
  useCharge(pool, seconds) {
    if (this.availableCharges(pool) <= 0) {
      return false;
    }
    pool.cds.push(this.t + seconds);
    return true;
  }

  // Compact fields are part of the client snapshot: available, maximum, next recharge.
  chargeStatus(pool) {
    const available = this.availableCharges(pool);
    return {
      a: available,
      m: pool.max,
      n: pool.cds.length ? Math.ceil(Math.min(...pool.cds) - this.t) : 0,
    };
  }

  // =============== RED ACTIONS ===============
  cycleWeapon(entity, player) {
    const weapons = ["pistol", "smg", "grenade"];
    const current = weapons.indexOf(entity.cur);
    for (let offset = 1; offset <= weapons.length; offset++) {
      const weapon = weapons[(current + offset) % weapons.length];
      if (weapon === "grenade" ? entity.grenades > 0 : entity.guns[weapon] > 0) {
        entity.cur = weapon;
        return;
      }
    }
    this.toPlayer(player, "No weapons with ammo available. Use Q for your knife.");
  }

  startServerExtraction(p, id) {
    const server = this.servers.find((item) => item.id === id);
    if (!server || server.done) {
      return this.toPlayer(p, "That server is unavailable.");
    }
    if (p.extraction || server.extractor) {
      return this.toPlayer(p, "An extraction is already in progress.");
    }
    if (server.lockoutUntil > this.t) {
      return this.toPlayer(p, "Server locked. Try again after the cooldown.");
    }
    if (this.empBlocksExtraction(p, server)) {
      return this.toPlayer(p, "EMP interference prevents extraction.");
    }
    if (dist(p.x, p.y, server.x, server.y) >= C.serverHackRange) {
      return this.toPlayer(p, "Get closer to the server before starting extraction.");
    }
    if (!this.useCharge(this.redPool, C.remoteHackRechargeSeconds)) {
      return this.toPlayer(p, "No remote hack charges left.");
    }
    server.extractor = p.name;
    server.extractionId = rid();
    server.counterUsed = false;
    p.extraction = { server: id, sessionId: server.extractionId };
    if (p.bot) {
      p.extraction.startedAt = this.t;
      p.extraction.readyAt = this.t;
    } else {
      this.startServerChallenge(p);
    }
    this.toTeam("blue", "Extraction started on " + id + "! Click it on the radar to counterhack.");
  }

  startServerChallenge(p) {
    p.extraction.challengeId = rid();
    p.extraction.startedAt = this.t;
    p.extraction.readyAt = null;
    this.send(p.name, {
      t: "minigame",
      purpose: "extraction",
      id: p.extraction.challengeId,
      server: p.extraction.server,
      game: ["flappy", "maze", "meteors"][Math.floor(Math.random() * 3)],
      seconds: Math.max(0, C.serverHackSeconds -
        this.servers.find((server) => server.id === p.extraction.server).progress),
      entrySeconds: C.serverChallengeEntrySeconds,
    });
  }

  stopServerExtraction(p, reason) {
    if (!p.extraction) return;
    const attempt = p.extraction;
    const server = this.servers.find((item) => item.id === attempt.server);
    if (server && server.extractionId === attempt.sessionId) {
      server.extractor = null;
      server.extractionId = null;
    }
    for (const blue of this.players.values()) {
      if (blue.team === "blue" && blue.counter && blue.counter.sessionId === attempt.sessionId) {
        this.send(blue.name, {
          t: "minigame_cancel",
          id: blue.counter.id,
          text: "The extraction ended before your counterhack finished.",
        });
        blue.counter = null;
      }
    }
    p.extraction = null;
    this.send(p.name, { t: "minigame_cancel", id: attempt.challengeId, text: reason });
  }

  finishServerChallenge(p, message) {
    const attempt = p.extraction;
    if (!attempt || message.id !== attempt.challengeId) return;
    const server = this.servers.find((item) => item.id === attempt.server);
    if (server && this.empBlocksExtraction(p, server)) {
      return this.stopServerExtraction(p, "EMP interrupted extraction. Progress was saved.");
    }
    if (!server || server.extractionId !== attempt.sessionId || !p.connected || message.ok !== true) {
      return this.stopServerExtraction(p, "Extraction stopped. Return to the server to try again.");
    }
  }

  remoteHack(p, id) {
    const door = this.doors.find((d) => d.id === id);
    const cam = this.cams.find((c) => c.id === id);
    const laser = this.lasers.find((l) => l.id === id);
    if (!door && !cam && !laser) {
      return;
    }
    if (door && door.open) {
      return this.toPlayer(p, "Door " + id + " is already open.");
    }
    if ((cam && cam.hacked) || (laser && laser.hacked)) {
      return this.toPlayer(p, "That device is already hacked.");
    }
    const device = door || cam || laser;
    if (this.empContainsPoint(p.x, p.y) || this.empIntersectsDevice(device)) {
      return this.toPlayer(p, "EMP interference prevents hacking.");
    }
    if (!this.useCharge(this.redPool, C.remoteHackRechargeSeconds)) {
      return this.toPlayer(p, "No remote hack charges left.");
    }
    if (door) {
      door.open = true;
      this.toTeam("red", "Door " + id + " hacked open until Blue closes it.");
    }
    if (cam) {
      cam.hacked = true;
      this.toTeam("red", "Camera " + id + " disabled until Blue restores it.");
    }
    if (laser) {
      laser.hacked = true;
      this.toTeam("red", "Laser " + id + " disabled until Blue restores it.");
    }
  }

  stealTag(p) {
    if (p.disguise) {
      return;
    }
    const c = this.corpses.find(
      (c) => c.kind === "guard" && c.tag && !c.invalid && !c.discovered &&
        dist(p.x, p.y, c.x, c.y) < 60,
    );
    if (!c) {
      return this.toPlayer(p, "No nametag to steal here.");
    }
    c.tag = false;
    p.disguise = c.id;
    p.markerId = rid();
    this.toPlayer(
      p,
      "Nametag stolen: guards ignore you, but Blue now sees a guard GPS marker on you.",
    );
  }

  usePad(entity, player = entity) {
    if (entity.pad) {
      entity.x = entity.pad.x;
      entity.y = entity.pad.y;
      entity.pad = null;
      entity.hasPad = false;
      this.toPlayer(player, "Teleported.");
    } else if (entity.hasPad) {
      entity.pad = { x: entity.x, y: entity.y };
      this.toPlayer(player, "Pad placed. Press Space again to teleport back.");
    }
  }

  openLocker(p, locker, player = p) {
    const options = [];
    if (!Object.hasOwn(p.guns, "smg")) {
      options.push("smg");
    }
    if (p.grenades < C.maxGrenades) {
      options.push("grenade");
    }
    if (p.armor < C.redMaxArmor) {
      options.push("armor");
    }
    if (!p.hasPad) {
      options.push("pad");
    }
    if (Object.keys(p.guns).some((gun) => p.guns[gun] < GUNS[gun].capacity)) {
      options.push("ammo");
    }
    if (!options.length) return;
    const prize = options[Math.floor(Math.random() * options.length)];
    locker.readyAt = this.t + C.lockerRestockSeconds;
    if (prize === "smg") {
      p.guns.smg = C.smgAmmo;
      this.toPlayer(player, "Locker: SMG (press E to cycle weapons)");
    } else if (prize === "grenade") {
      p.grenades = Math.min(C.maxGrenades, p.grenades + 2);
      this.toPlayer(player, "Locker: grenades (press E to cycle weapons)");
    } else if (prize === "armor") {
      p.armor = Math.min(C.redMaxArmor, p.armor + 5);
      this.toPlayer(player, "Locker: armor +5");
    } else if (prize === "pad") {
      p.hasPad = true;
      this.toPlayer(player, "Locker: teleport pad (press Space)");
    } else {
      for (const k of Object.keys(p.guns)) {
        p.guns[k] = GUNS[k].capacity;
      }
      this.toPlayer(player, "Locker: ammo refilled");
    }
  }

  collectLockers(entity, previousX, previousY, player, t) {
    for (const locker of this.lockers) {
      if (locker.readyAt <= t &&
          distPointToSegment(locker.x, locker.y, previousX, previousY, entity.x, entity.y) < 55) {
        this.openLocker(entity, locker, player);
      }
    }
  }

  // =============== BLUE ACTIONS ===============
  blueAct(p, m) {
    const t = this.t;
    if (m.a === "alert" || m.a === "emp") {
      if (!Number.isFinite(m.x) || !Number.isFinite(m.y) ||
          m.x < 0 || m.y < 0 || m.x > M.WORLD.w || m.y > M.WORLD.h) {
        return this.toPlayer(p, "Select a location inside the map.");
      }
      if (m.a === "emp") {
        if (t < this.empCdUntil) return this.toPlayer(p, "EMP is on cooldown.");
        this.empCdUntil = t + C.empCooldownSeconds;
        this.emps.push({ x: m.x, y: m.y, until: t + C.empSeconds });
        for (const red of this.livingReds()) {
          if (!red.extraction) continue;
          const server = this.servers.find((s) => s.id === red.extraction.server);
          if (server && this.empBlocksExtraction(red, server)) {
            this.stopServerExtraction(red, "EMP interrupted extraction. Progress was saved.");
          }
        }
        this.toAll("An EMP field was deployed for " + C.empSeconds + "s.");
      } else {
        if (t < this.alertCdUntil) return this.toPlayer(p, "Guard alert is on cooldown.");
        this.alertCdUntil = t + C.alertCooldownSeconds;
        this.addPing("manual", m.x, m.y, C.alertSeconds);
        this.alertGuards(m.x, m.y, C.alertRange, C.guardInvestigationSeconds);
        this.toTeam("blue", p.name + " sent guards to investigate.");
      }
    } else if (m.a === "knife" || m.a === "weapon_cycle" || m.a === "pad") {
      const guard = this.guards.find((g) => g.id === p.possessed && g.possessedBy === p.name && g.alive);
      if (!guard) return;
      if (m.a === "knife") {
        guard.cur = "knife";
      } else if (m.a === "weapon_cycle") {
        this.cycleWeapon(guard, p);
      } else {
        this.usePad(guard, p);
      }
    } else if (m.a === "door") {
      const d = this.doors.find((x) => x.id === m.id);
      if (!d) {
        return;
      }
      if (!this.doorClosed(d)) {
        if (!this.useCharge(this.bluePool, C.blueSecurityRechargeSeconds)) {
          return this.toPlayer(p, "No security charges left.");
        }
        d.open = false;
        this.toTeam("blue", "Door " + d.id + " closed until Red reopens it.");
      } else {
        this.toPlayer(p, d.open
          ? "EMP is temporarily holding that door closed."
          : "That door is already closed.");
      }
    } else if (m.a === "laser") {
      const l = this.lasers.find((x) => x.id === m.id);
      if (!l) {
        return;
      }
      return this.counterDevice(p, "laser", l);
    } else if (m.a === "camera") {
      const camera = this.cams.find((x) => x.id === m.id);
      if (camera) {
        this.counterDevice(p, "camera", camera);
      }
    } else if (m.a === "dark") {
      if (t < this.lightsCdUntil) {
        return this.toPlayer(p, "Blackout is on cooldown.");
      }
      this.lightsOffUntil = t + C.lightsBlackoutSeconds;
      this.lightsCdUntil = t + C.lightsCooldownSeconds;
      this.toAll("BLACKOUT! Lights are off for " + C.lightsBlackoutSeconds + "s");
    } else if (m.a === "possess") {
      if (p.possessed) {
        return;
      }
      if (t < p.possessCdUntil) {
        return this.toPlayer(p, "Possession cooling down.");
      }
      const g = this.guards.find((x) => x.markerId === m.id && x.alive && !x.possessedBy);
      if (!g) {
        return this.toPlayer(p, "No response from that GPS tag.");
      }
      g.possessedBy = p.name;
      g.input = { mx: 0, my: 0, ax: g.x, ay: g.y, fire: false };
      g.path = [];
      p.possessed = g.id;
      p.view = "shooter";
      p.redLastSeen = new Map();
    } else if (m.a === "exit") {
      this.releaseGuard(p);
    } else if (m.a === "view") {
      if (p.possessed) {
        p.view = p.view === "radar" ? "shooter" : "radar";
      }
    } else if (m.a === "counter") {
      const s = this.servers.find((x) => x.id === m.id);
      if (!s || s.done || !s.extractor || s.counterUsed || s.counterCooldownUntil > t || p.counter) {
        return this.toPlayer(p, "Counterhack not available.");
      }
      if (this.availableCharges(this.bluePool) <= 0) {
        return this.toPlayer(p, "No security charges left.");
      }
      s.counterUsed = true; // one attempt per extraction session
      s.counterBy = p.name;
      s.counterCooldownUntil = t + C.serverCounterCooldownSeconds;
      p.counter = { server: s.id, sessionId: s.extractionId, startedAt: t, readyAt: null, id: rid() };
      this.send(p.name, {
        t: "minigame",
        purpose: "counterhack",
        id: p.counter.id,
        game: ["flappy", "maze", "meteors"][Math.floor(Math.random() * 3)],
        seconds: C.counterhackSeconds,
        entrySeconds: C.minigameEntrySeconds,
      });
    } else if (m.a === "cm_ready" && p.counter && m.id === p.counter.id &&
        p.counter.readyAt === null && t - p.counter.startedAt < C.minigameEntrySeconds) {
      p.counter.readyAt = t;
    } else if (m.a === "cm_result" && p.counter && m.id === p.counter.id) {
      const attempt = p.counter;
      const elapsed = attempt.readyAt === null ? -1 : t - attempt.readyAt;
      if (m.ok === true && elapsed < C.counterhackSeconds) return;
      p.counter = null;
      if (m.ok === true) {
        this.send(p.name, { t: "minigame_cancel", id: attempt.id });
      }
      const s = this.servers.find((x) => x.id === attempt.server);
      if (
        m.ok === true &&
        elapsed >= C.counterhackSeconds &&
        s && !s.done &&
        s.extractor && s.extractionId === attempt.sessionId
      ) {
        if (!this.useCharge(this.bluePool, C.blueSecurityRechargeSeconds)) {
          return this.toPlayer(p, "Counterhack could not finish: no security charges left.");
        }
        s.progress *= 0.25;
        s.lockoutUntil = t + C.serverCounterLockoutSeconds;
        const red = this.players.get(s.extractor);
        if (red) this.stopServerExtraction(red, "Counterhacked! Return after the server lockout.");
        this.toAll("Counterhack SUCCESS: " + s.id + " lost 60% of its accumulated progress.");
      } else {
        this.toTeam(
          "blue",
          "Counterhack failed or abandoned. That was your only attempt on this extraction.",
        );
      }
    }
  }

  counterDevice(p, kind, device) {
    if (!device.hacked) {
      return this.toPlayer(p, "That " + kind + " is not hacked.");
    }
    if (p.counter) {
      return this.toPlayer(p, "Counterhack not available for that " + kind + ".");
    }
    if (!this.useCharge(this.bluePool, C.blueSecurityRechargeSeconds)) {
      return this.toPlayer(p, "No security charges left.");
    }
    device.hacked = false;
    this.toTeam("blue", "Counterhack SUCCESS: " + kind + " " + device.id + " restored.");
  }

  releaseGuard(p) {
    const g = this.guards.find((x) => x.possessedBy === p.name);
    if (g) {
      g.possessedBy = null;
      g.input = null;
      g.state = "patrol";
      g.path = [];
    }
    p.possessed = null;
    p.view = "radar";
    p.redLastSeen = null;
    p.possessCdUntil = this.t + C.possessionCooldownSeconds;
  }

  // =============== HELPERS ===============
  empContainsPoint(x, y) {
    return this.emps.some((emp) => emp.until > this.t && dist(x, y, emp.x, emp.y) <= C.empRadius);
  }

  empIntersectsDevice(device) {
    return this.emps.some((emp) => {
      if (emp.until <= this.t) return false;
      const x = device.w === undefined ? device.x : Math.max(device.x, Math.min(emp.x, device.x + device.w));
      const y = device.h === undefined ? device.y : Math.max(device.y, Math.min(emp.y, device.y + device.h));
      return dist(x, y, emp.x, emp.y) <= C.empRadius;
    });
  }

  empBlocksExtraction(player, server) {
    return this.empContainsPoint(player.x, player.y) || this.empContainsPoint(server.x, server.y);
  }

  doorClosed(d) {
    return !d.open || this.empIntersectsDevice(d);
  }
  closedDoorRects() {
    return this.doors.filter((d) => this.doorClosed(d));
  }
  lightsOn() {
    return this.t >= this.lightsOffUntil;
  }
  camActive(c) {
    return !c.hacked || this.empIntersectsDevice(c);
  }
  laserActive(l) {
    return !l.hacked || this.empIntersectsDevice(l);
  }
  redPlayers() {
    return [...this.players.values()].filter((p) => p.team === "red" && p.kind === "red");
  }
  livingReds() {
    return this.redPlayers().filter((p) => p.alive);
  }

  // Line of sight: blocked by solid walls and by closed doors
  los(x1, y1, x2, y2) {
    if (this.wallSegBlocked(x1, y1, x2, y2)) {
      return false;
    }

    for (const d of this.closedDoorRects()) {
      if (segHitsRect(x1, y1, x2, y2, d)) {
        return false;
      }
    }
    return true;
  }

  wallSegBlocked(x1, y1, x2, y2) {
    return this.wallState
      ? this.wallState.segBlocked(x1, y1, x2, y2)
      : M.segBlocked(x1, y1, x2, y2);
  }

  wallSolidsNear(x, y, radius) {
    return this.wallState ? this.wallState.solidsNear(x, y, radius) : M.solidsNear(x, y, radius);
  }

  findWallPath(sx, sy, tx, ty, avoid = []) {
    return this.wallState
      ? this.wallState.findPath(sx, sy, tx, ty, avoid)
      : M.findPath(sx, sy, tx, ty, avoid);
  }

  addPing(kind, x, y, seconds) {
    const old = this.pings.find((p) => p.kind === kind && dist(p.x, p.y, x, y) < 60);
    if (old) {
      old.until = this.t + seconds;
      return;
    }
    this.pings.push({ kind, x, y, until: this.t + seconds });
  }

  alertGuards(x, y, range, seconds) {
    for (const g of this.guards) {
      if (!g.alive || g.possessedBy || g.state === "chase") {
        continue;
      }
      if (dist(g.x, g.y, x, y) <= range) {
        g.state = "investigate";
        g.target = { x, y };
        g.until = this.t + seconds;
        g.path = [];
      }
    }
  }

  // Loud noise (gunfire/explosion): Blue gets a fixed marker; nearby guards come to look.
  makeNoise(x, y) {
    this.addPing("shot", x, y, C.gunshotMarkerSeconds);
    this.alertGuards(x, y, 800, C.guardInvestigationSeconds);
  }

  // If a guard or active camera can see a disguised Red doing something suspicious, the disguise breaks.
  breakDisguiseIfSeen(p) {
    if (!p.disguise) {
      return;
    }
    const seenByGuard = this.guards.some(
      (g) =>
        g.alive &&
        dist(g.x, g.y, p.x, p.y) < C.guardSightRange &&
        this.los(g.x, g.y, p.x, p.y),
    );
    const seenByCam = this.cams.some((c) => this.camActive(c) && this.camSees(c, p));
    if (seenByGuard || seenByCam) {
      p.disguise = null;
      p.markerId = null;
      this.toPlayer(p, "Your disguise was blown!");
    }
  }

  camSees(c, p) {
    const d = dist(c.x, c.y, p.x, p.y);
    if (d > 380) {
      return false;
    }
    if (Math.abs(angleDiff(Math.atan2(p.y - c.y, p.x - c.x), c.angle)) > 0.6) {
      return false;
    } // ~70 degree cone
    return this.los(c.x, c.y, p.x, p.y);
  }

  // =============== COMBAT ===============
  fire(e, t) {
    const a = Math.atan2(e.input.ay - e.y, e.input.ax - e.x);
    e.aim = a;
    const isRed = e.kind === "red";
    if (e.cur === "knife") {
      if (t < e.nextShot) {
        return;
      }
      e.nextShot = t + KNIFE_COOLDOWN_SECONDS;
      this.knifeSwings.push({
        x: e.x,
        y: e.y,
        angle: a,
        source: e,
        until: t + KNIFE_EFFECT_SECONDS,
      });
      const targets = [
        ...this.livingReds().filter((r) => r !== e),
        ...this.guards.filter((g) => g.alive && g !== e),
      ];
      for (const tg of targets) {
        if (
          dist(e.x, e.y, tg.x, tg.y) < KNIFE_RANGE &&
          Math.abs(angleDiff(Math.atan2(tg.y - e.y, tg.x - e.x), a)) < KNIFE_HALF_ANGLE
        ) {
          this.damage(tg, C.knifeDamage, e);
        }
      }
      if (isRed) {
        this.breakDisguiseIfSeen(e);
      }
    } else if (e.cur === "grenade") {
      if (e.grenades <= 0 || t < e.nextShot) {
        return;
      }
      e.grenades--;
      e.nextShot = t + 0.8;
      const d = Math.min(420, dist(e.x, e.y, e.input.ax, e.input.ay));
      this.grenades.push({
        x: e.x,
        y: e.y,
        vx: (Math.cos(a) * d) / 0.8,
        vy: (Math.sin(a) * d) / 0.8,
        flight: 0.8,
        fuse: 1.4,
        owner: e.name,
      });
      if (e.grenades === 0) {
        e.cur = "pistol";
      }
      if (isRed) {
        this.breakDisguiseIfSeen(e);
      }
    } else {
      const spec = GUNS[e.cur];
      if (!spec || !e.guns || !Object.hasOwn(e.guns, e.cur) || t < e.nextShot) {
        return;
      }
      if (e.guns[e.cur] <= 0) return;
      e.guns[e.cur]--;
      e.nextShot = t + spec.cd;
      this.spawnBullet(e, a + (Math.random() - 0.5) * spec.spread * 2, spec.dmg);
      if (isRed) {
        this.makeNoise(e.x, e.y);
        this.breakDisguiseIfSeen(e);
      }
    }
  }

  spawnBullet(e, angle, dmg) {
    this.bullets.push({
      x: e.x + Math.cos(angle) * 10,
      y: e.y + Math.sin(angle) * 10,
      vx: Math.cos(angle) * C.bulletSpeed,
      vy: Math.sin(angle) * C.bulletSpeed,
      owner: e.kind === "red" ? e.name : e.id,
      ownerKind: e.kind,
      dmg,
      life: 1.2,
    });
  }

  damage(target, amount, source) {
    if (target.kind === "red") {
      if (!target.alive) {
        return;
      }
      const absorbed = Math.min(target.armor, amount);
      target.armor -= absorbed;
      target.hp -= amount - absorbed;
      if (target.bot && source && source.shooter && source.shooter.kind === "guard") {
        target.botThreat = source.shooter.id;
        target.botFleeUntil = this.t + 4;
        target.botRepathAt = 0;
      }
      if (target.hp <= 0) {
        this.killRed(target);
      }
    } else {
      if (!target.alive) {
        return;
      }
      const absorbed = Math.min(target.armor, amount);
      target.armor -= absorbed;
      target.hp -= amount - absorbed;
      if (target.hp <= 0) {
        this.killGuard(target);
      } else if (
        !target.possessedBy &&
        source &&
        source.x !== undefined &&
        target.state !== "chase"
      ) {
        target.state = "investigate";
        target.target = { x: source.x, y: source.y };
        target.until = this.t + C.guardInvestigationSeconds;
        target.path = [];
      }
    }
  }

  killRed(p) {
    this.stopServerExtraction(p, "Extraction stopped because you were eliminated.");
    p.alive = false;
    p.hp = 0;
    p.deadAt = this.t;
    p.respawnGame = null;
    p.disguise = null;
    p.markerId = null;
    for (const player of this.players.values()) {
      if (player.redLastSeen) {
        player.redLastSeen.delete(p.name);
      }
    }
    this.corpses.push({
      id: rid(),
      kind: "red",
      x: p.x,
      y: p.y,
      invalid: true,
      tag: false,
      discovered: true,
      dispose: 0,
    });
    this.toTeam("red", p.name + " was eliminated. Respawn minigame!");
    this.toTeam("blue", "Hacker " + p.name + " eliminated.");
  }

  killGuard(g) {
    g.alive = false;
    g.respawnAt = this.t + C.guardRespawnSeconds;
    this.corpses.push({
      id: rid(),
      kind: "guard",
      x: g.x,
      y: g.y,
      invalid: false,
      tag: true,
      discovered: false,
      dispose: 0,
    });
    if (g.possessedBy) {
      const bp = this.players.get(g.possessedBy);
      if (bp) {
        this.releaseGuard(bp);
        this.toPlayer(bp, "Your guard died. Possession cooldown started.");
      }
    }
  }

  explode(gr) {
    this.makeNoise(gr.x, gr.y);
    const targets = [...this.livingReds(), ...this.guards.filter((g) => g.alive)];
    for (const tg of targets) {
      if (
        dist(gr.x, gr.y, tg.x, tg.y) <= C.grenadeRadius &&
        this.los(gr.x, gr.y, tg.x, tg.y)
      ) {
        this.damage(tg, C.grenadeDamage, { x: gr.x, y: gr.y });
      }
    }
    const blast = { x: gr.x, y: gr.y, radius: C.grenadeRadius };
    const touchesWall = this.wallSolidsNear(gr.x, gr.y, blast.radius).some((wall) => {
      const x = Math.max(wall.x, Math.min(gr.x, wall.x + wall.w));
      const y = Math.max(wall.y, Math.min(gr.y, wall.y + wall.h));
      return dist(gr.x, gr.y, x, y) < blast.radius;
    });
    if (touchesWall) {
      if (!this.wallState) this.wallState = M.createWallState();
      if (this.wallState.destroy(blast)) this.wallBlasts.push(blast);
    }
    this.explosions = (this.explosions || []).concat([
      { x: gr.x, y: gr.y, until: this.t + 0.4 },
    ]);
  }

  // =============== MAIN TICK ===============
  tick() {
    const t = (this.t = nowSec());
    const dt = 1 / C.tickRate;
    if (this.phase === "ended") {
      if (t > this.endedAt + 20) {
        this.backToLobby();
      }
      return;
    }
    if (this.phase !== "playing") {
      return;
    }

    this.pings = this.pings.filter((p) => p.until > t);
    this.emps = this.emps.filter((emp) => emp.until > t);
    this.knifeSwings = this.knifeSwings.filter((swing) => swing.until > t);
    this.explosions = (this.explosions || []).filter((e) => e.until > t);

    // route reshuffle
    if (t >= this.nextShift) {
      this.nextShift = t + C.guardRouteShiftSeconds;
      const free = this.guards.filter((g) => g.alive && !g.possessedBy);
      const ids = shuffle(free.map((g) => g.routeId));
      free.forEach((g, i) => {
        g.routeId = ids[i];
        g.route = M.routes[ids[i]];
        g.routeIdx = 0;
        g.path = [];
        if (g.state === "patrol") {
          g.target = null;
        }
      });
      this.toTeam("blue", "Guard patrol routes were reshuffled.");
    }

    // Update players and world systems before checking the result and sending snapshots.
    for (const p of this.players.values()) {
      if (p.team === "red" && p.kind === "red") {
        if (p.bot) tickRedBot(this, p, t);
        this.tickRed(p, dt, t);
      } else if (p.team === "blue" && p.input) {
        this.tickBlue(p, t);
      } else if (p.team === "spectator" && p.connected && p.input) {
        const length = Math.hypot(p.input.mx, p.input.my) || 1;
        p.x = Math.max(0, Math.min(M.WORLD.w, p.x + p.input.mx / length * C.redSpeed * dt));
        p.y = Math.max(0, Math.min(M.WORLD.h, p.y + p.input.my / length * C.redSpeed * dt));
      }
    }
    this.tickServers(dt, t);
    for (const g of this.guards) {
      this.tickGuard(g, dt, t);
    }
    this.tickCameras(t);
    this.tickLasers(t);
    this.tickProjectiles(dt, t);
    this.checkEnd(t);

    for (const p of this.players.values()) {
      if (!p.bot && p.connected && (p.team === "red" || p.team === "blue" || p.team === "spectator")) {
        this.send(p.name, this.snapshot(p));
      }
    }
  }

  moveBody(e, dx, dy, blockDoors) {
    const doors = blockDoors ? this.closedDoorRects() : [];
    // Break fast movement into short steps so thin walls cannot be skipped.
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (RADIUS / 2)));
    for (let step = 0; step < steps; step++) {
      e.x += dx / steps;
      e.y += dy / steps;
      for (let pass = 0; pass < 2; pass++) {
        for (const s of this.wallSolidsNear(e.x, e.y, RADIUS * 2)) {
          pushOutOfRect(e, RADIUS, s);
        }
        for (const d of doors) {
          pushOutOfRect(e, RADIUS, d);
        }
      }
      e.x = Math.max(RADIUS, Math.min(M.WORLD.w - RADIUS, e.x));
      e.y = Math.max(RADIUS, Math.min(M.WORLD.h - RADIUS, e.y));
    }
  }

  steer(e, input, speed, dt, blockDoors = true) {
    const len = Math.hypot(input.mx, input.my);
    const tx = len > 0 ? (input.mx / len) * speed : 0;
    const ty = len > 0 ? (input.my / len) * speed : 0;
    const k = 1 - Math.exp(-14 * dt); // smooth acceleration
    e.vx += (tx - e.vx) * k;
    e.vy += (ty - e.vy) * k;
    this.moveBody(e, e.vx * dt, e.vy * dt, blockDoors);
  }

  tickRed(p, dt, t) {
    if (!p.alive) {
      if (p.respawnGame && p.respawnGame.readyAt !== null &&
          t - p.respawnGame.readyAt >= p.respawnGame.seconds &&
          t - p.deadAt < C.respawnMaxSeconds) {
        this.act(p, { a: "respawn_result", id: p.respawnGame.id, ok: true });
        return;
      }
      if (p.respawnGame && p.respawnGame.readyAt === null &&
          t > p.respawnGame.startedAt + C.minigameEntrySeconds + 2) {
        this.send(p.name, { t: "minigame_cancel", id: p.respawnGame.id, text: "Reboot timed out. Try again or wait for auto-respawn." });
        p.respawnGame = null;
      }
      if (t - p.deadAt >= C.respawnMaxSeconds) {
        this.initRed(p, Math.floor(Math.random() * M.redSpawns.length));
      }
      return;
    }
    const inp = p.input;
    p.aim = Math.atan2(inp.ay - p.y, inp.ax - p.x);
    const previousX = p.x;
    const previousY = p.y;
    this.steer(p, inp, C.redSpeed, dt);
    if (inp.fire) {
      this.fire(p, t);
    }

    // Collect ready lockers touched during movement, even near a server.
    this.collectLockers(p, previousX, previousY, p, t);
    // corpse disposal: hold 2 next to a guard corpse
    p.disposing = null;
    if (inp.dispose) {
      const c = this.corpses.find(
        (c) => c.kind === "guard" && !c.invalid && dist(p.x, p.y, c.x, c.y) < 60,
      );
      if (c) {
        c.dispose += dt;
        p.disposing = c.dispose / C.corpseDisposeSeconds;
        if (c.dispose >= C.corpseDisposeSeconds) {
          this.corpses.splice(this.corpses.indexOf(c), 1);
          this.toPlayer(p, "Guard corpse disposed.");
        }
      }
    }
  }

  tickBlue(p, t) {
    if (p.counter && p.counter.readyAt !== null &&
        t - p.counter.readyAt >= C.counterhackSeconds) {
      this.blueAct(p, { a: "cm_result", id: p.counter.id, ok: true });
    } else if (p.counter && p.counter.readyAt === null &&
        t > p.counter.startedAt + C.minigameEntrySeconds + 3) {
      this.send(p.name, { t: "minigame_cancel", id: p.counter.id, text: "Counterhack timed out. The attempt was used." });
      p.counter = null;
    }
    if (p.possessed) {
      const g = this.guards.find((x) => x.id === p.possessed);
      // Radar allows movement but never shooting.
      g.input = p.view === "shooter" ? p.input : { ...p.input, fire: false };
    }
  }

  tickServers(dt, t) {
    for (const s of this.servers) {
      if (s.done || !s.extractor) continue;
      const player = this.players.get(s.extractor);
      if (!player || !player.connected || !player.alive || !player.extraction ||
          player.extraction.sessionId !== s.extractionId) {
        if (player && player.extraction) this.stopServerExtraction(player);
        else { s.extractor = null; s.extractionId = null; }
        continue;
      }
      if (this.empBlocksExtraction(player, s)) {
        this.stopServerExtraction(player, "EMP interrupted extraction. Progress was saved.");
        continue;
      }
      const attempt = player.extraction;
      if (attempt.readyAt === null && t > attempt.startedAt + C.serverChallengeEntrySeconds + 2) {
        this.stopServerExtraction(player, "Extraction timed out. Return to the server to try again.");
        continue;
      }
      if (player.extraction.readyAt !== null) {
        const activeTime = Math.min(dt, Math.max(0, t - player.extraction.readyAt));
        s.progress = Math.min(C.serverHackSeconds, s.progress + activeTime);
        if (s.progress >= C.serverHackSeconds) {
          s.done = true;
          this.stopServerExtraction(player);
          this.toAll("SERVER " + s.id + " EXTRACTED (" +
            this.servers.filter((item) => item.done).length + "/3)");
        }
      }
    }
  }

  tickCameras(t) {
    const detected = new Map();
    for (const c of this.cams) {
      c.angle = c.base + Math.sin(t * 0.5 + c.phase) * 0.45;
      const visible = this.camActive(c)
        ? this.livingReds().filter((p) => !p.disguise && this.camSees(c, p))
        : [];
      c.seen = visible.map((p) => p.name);
      for (const player of visible) {
        detected.set(player.name, player);
      }
    }
    // Guards investigate the nearest active camera sighting, but only chase on direct sight.
    for (const guard of this.guards) {
      if (!guard.alive || guard.possessedBy || guard.state === "chase") continue;
      let nearest = null;
      let nearestDistance = 800;
      for (const player of detected.values()) {
        const distance = dist(guard.x, guard.y, player.x, player.y);
        if (distance <= nearestDistance) {
          nearest = player;
          nearestDistance = distance;
        }
      }
      if (!nearest) continue;
      if (guard.state !== "investigate") guard.path = [];
      guard.state = "investigate";
      guard.target = { x: nearest.x, y: nearest.y };
      guard.until = t + C.guardInvestigationSeconds;
    }
  }

  tickLasers(t) {
    for (const l of this.lasers) {
      const f = Math.sin(t * 1.2) * 0.5 + 0.5;
      l.beam = l.axis === "y" ? l.y + f * l.h : l.x + f * l.w;
      if (!this.laserActive(l)) {
        continue;
      }
      const rect =
        l.axis === "y"
          ? { x: l.x, y: l.beam - 4, w: l.w, h: 8 }
          : { x: l.x + 0, y: l.y, w: 8, h: l.h };
      if (l.axis !== "y") {
        rect.x = l.beam - 4;
      }
      for (const p of this.livingReds()) {
        const c = { x: p.x, y: p.y };
        if (pushOutOfRect(c, RADIUS, rect) && t - p.laserHitAt > 0.5) {
          p.laserHitAt = t;
          this.damage(p, C.laserDamage, null);
          this.addPing("laser", p.x, p.y, 6);
        }
      }
    }
  }

  tickProjectiles(dt, t) {
    const doors = this.closedDoorRects();
    const targets = () => [...this.livingReds(), ...this.guards.filter((g) => g.alive)];
    for (const b of this.bullets) {
      const nx = b.x + b.vx * dt,
        ny = b.y + b.vy * dt;
      b.life -= dt;
      let hit = false;
      if (
        this.wallSegBlocked(b.x, b.y, nx, ny) ||
        doors.some((d) => segHitsRect(b.x, b.y, nx, ny, d))
      ) {
        hit = true;
      } else {
        for (const tg of targets()) {
          if ((tg.kind === "red" ? tg.name : tg.id) === b.owner) {
            continue;
          }
          if (distPointToSegment(tg.x, tg.y, b.x, b.y, nx, ny) < RADIUS + 2) {
            this.damage(tg, b.dmg, {
              x: b.x - b.vx, y: b.y - b.vy,
              shooter: b.ownerKind === "guard"
                ? this.guards.find((guard) => guard.id === b.owner) : null,
            });
            hit = true;
            break;
          }
        }
      }
      b.x = nx;
      b.y = ny;
      if (hit) {
        b.life = 0;
      }
    }
    this.bullets = this.bullets.filter((b) => b.life > 0);

    for (const g of this.grenades) {
      g.fuse -= dt;
      if (g.flight > 0) {
        g.flight -= dt;
        const nx = g.x + g.vx * dt,
          ny = g.y + g.vy * dt;
        if (
          this.wallSegBlocked(g.x, g.y, nx, ny) ||
          doors.some((d) => segHitsRect(g.x, g.y, nx, ny, d))
        ) {
          g.flight = 0;
        } else {
          g.x = nx;
          g.y = ny;
        }
      }
      if (g.fuse <= 0) {
        this.explode(g);
        g.dead = true;
      }
    }
    this.grenades = this.grenades.filter((g) => !g.dead);
  }

  // =============== GUARD AI ===============
  guardSees(g, x, y) {
    const d = dist(g.x, g.y, x, y);
    if (d > C.guardSightRange) {
      return false;
    }
    if (
      d > 45 &&
      Math.abs(angleDiff(Math.atan2(y - g.y, x - g.x), g.angle)) >
        (C.guardFovDegrees * Math.PI) / 360
    ) {
      return false;
    }
    return this.los(g.x, g.y, x, y);
  }

  tickGuard(g, dt, t) {
    if (!g.alive) {
      if (t >= g.respawnAt) {
        const fresh = this.makeGuard(g.idx, g.routeId);
        Object.assign(g, fresh);
      }
      return;
    }
    if (g.possessedBy) {
      return this.tickPossessed(g, dt, t);
    }

    // 1) look for undisguised hackers and disguised players extracting a server
    let seen = null,
      best = 1e9;
    for (const p of this.livingReds()) {
      if (p.disguise && !p.extraction) {
        continue;
      }
      const d = dist(g.x, g.y, p.x, p.y);
      if (d < best && this.guardSees(g, p.x, p.y)) {
        seen = p;
        best = d;
      }
    }
    // 2) look for corpses that haven't been discovered
    for (const c of this.corpses) {
      if (
        c.kind === "guard" &&
        !c.invalid &&
        !c.discovered &&
        this.guardSees(g, c.x, c.y)
      ) {
        this.discoverCorpse(c);
      }
    }

    const activeExtractor = (player) =>
      player && player.connected && player.alive && player.extraction &&
      player.extraction.readyAt !== null;
    let extractor = activeExtractor(this.players.get(g.extractionTarget))
      ? this.players.get(g.extractionTarget) : null;
    if (!extractor) {
      let nearest = 800;
      for (const player of this.livingReds()) {
        const distance = dist(g.x, g.y, player.x, player.y);
        if (activeExtractor(player) && distance <= nearest) {
          extractor = player;
          nearest = distance;
        }
      }
    }

    if (seen) {
      g.state = "chase";
      g.target = { x: seen.x, y: seen.y };
      g.lastSeen = t;
      g.seenPlayer = seen;
      g.extractionTarget = activeExtractor(seen) ? seen.name : null;
    } else {
      const pursuingAnother = g.state === "chase" && g.seenPlayer &&
        g.seenPlayer !== extractor && t - g.lastSeen <= 1.5;
      if (extractor && !pursuingAnother) {
        if (g.state !== "chase" || g.extractionTarget !== extractor.name) g.path = [];
        g.state = "chase";
        g.target = { x: extractor.x, y: extractor.y };
        g.extractionTarget = extractor.name;
        g.seenPlayer = null;
      } else {
        g.extractionTarget = null;
        if (g.state === "chase" && t - g.lastSeen > 1.5) {
          g.state = "investigate";
          g.until = t + C.guardLostSightSeconds;
          g.seenPlayer = null;
        }
      }
    }
    if (g.state === "investigate" && t > g.until) {
      g.state = "patrol";
      g.path = [];
    }

    let goal = null,
      speed = C.guardPatrolSpeed,
      stand = false;
    if (g.state === "patrol") {
      goal = g.route[g.routeIdx % g.route.length];
      if (dist(g.x, g.y, goal.x, goal.y) < 30) {
        g.routeIdx = (g.routeIdx + 1) % g.route.length;
        g.path = [];
      }
    } else if (g.state === "investigate") {
      goal = g.target;
      if (!goal || dist(g.x, g.y, goal.x, goal.y) < 40) {
        stand = true;
        g.angle += dt * 1.4;
      } // look around
    } else {
      goal = g.target;
      speed = C.guardChaseSpeed;
      if (seen && best < 260) {
        stand = true;
      } // close enough: stop and shoot
      if (seen && t >= g.nextShot && best < 380) {
        g.nextShot = t + 0.8;
        g.angle = Math.atan2(seen.y - g.y, seen.x - g.x);
        this.spawnBullet(g, g.angle + (Math.random() - 0.5) * 0.25, C.pistolDamage);
      }
    }

    if (goal && !stand) {
      const previousX = g.x;
      const previousY = g.y;
      if (!g.path.length || t >= g.repathAt) {
        g.path = this.findWallPath(g.x, g.y, goal.x, goal.y);
        g.repathAt = t + 0.6;
      }
      const wp = g.path[0];
      if (wp) {
        const d = dist(g.x, g.y, wp.x, wp.y);
        if (d < 8) {
          g.path.shift();
        } else {
          const step = Math.min(d, speed * dt);
          const want = Math.atan2(wp.y - g.y, wp.x - g.x);
          this.moveBody(g, ((wp.x - g.x) / d) * step, ((wp.y - g.y) / d) * step, false);
          if (!(g.state === "chase" && seen)) {
            g.angle += Math.max(-8 * dt, Math.min(8 * dt, angleDiff(want, g.angle)));
          }
        }
      }
      for (const s of this.wallSolidsNear(g.x, g.y, RADIUS * 2)) {
        pushOutOfRect(g, RADIUS, s);
      }
      for (const c of this.corpses) {
        if (
          c.kind === "guard" &&
          !c.invalid &&
          !c.discovered &&
          distPointToSegment(c.x, c.y, previousX, previousY, g.x, g.y) <= RADIUS * 2 &&
          this.los(g.x, g.y, c.x, c.y)
        ) {
          this.discoverCorpse(c);
        }
      }
    }
  }

  discoverCorpse(c) {
    c.discovered = true;
    this.addPing("alert", c.x, c.y, 20);
    this.alertGuards(c.x, c.y, 700, C.guardInvestigationSeconds);
    this.toTeam("blue", "A guard found a body!");
    for (const p of this.redPlayers()) {
      if (p.disguise === c.id) {
        p.disguise = null;
        p.markerId = null;
        this.toPlayer(
          p,
          "The corpse you took the nametag from was discovered. Disguise invalid!",
        );
      }
    }
  }

  tickPossessed(g, dt, t) {
    const inp = g.input;
    g.aim = g.angle = Math.atan2(inp.ay - g.y, inp.ax - g.x);
    const previousX = g.x;
    const previousY = g.y;
    this.steer(g, inp, C.possessedSpeed, dt, false);
    g.name = g.id;
    const player = this.players.get(g.possessedBy);
    if (player) this.collectLockers(g, previousX, previousY, player, t);
    if (inp.fire) {
      this.fire(g, t);
    }
  }

  // =============== VICTORY ===============
  checkEnd(t) {
    const done = this.servers.filter((s) => s.done).length;
    let winner = null,
      reason = "";
    if (done >= 3) {
      winner = "red";
      reason = "All 3 servers were extracted.";
    } else if (t >= this.endAt) {
      winner = done <= 1 ? "blue" : "draw";
      reason = "Time ran out with " + done + "/3 servers extracted.";
    }
    if (winner) {
      this.phase = "ended";
      this.endedAt = t;
      this.result = { winner, reason };
      this.broadcastLobby();
    }
  }

  // =============== SNAPSHOTS (what each client is allowed to see) ===============
  canViewerSee(v, x, y, nightVision) {
    const d = dist(v.x, v.y, x, y);
    if (nightVision || this.lightsOn()) {
      if (d > C.visionRadiusLit) {
        return false;
      }
    } else if (d > C.visionRadiusDark) {
      if (d > C.visionConeRange) {
        return false;
      }
      if (
        Math.abs(angleDiff(Math.atan2(y - v.y, x - v.x), v.aim)) >
        (C.visionConeDegrees * Math.PI) / 360
      ) {
        return false;
      }
    }
    return this.los(v.x, v.y, x, y);
  }

  // Everything the player standing at `v` can see in the world
  worldView(v, nightVision, selfName) {
    const see = (x, y) => v.team === "spectator" || this.canViewerSee(v, x, y, nightVision);
    const r = Math.round;
    return {
      guards: this.guards
        .filter((g) => g.alive && see(g.x, g.y))
        .map((g) => ({
          id: g.id,
          x: r(g.x),
          y: r(g.y),
          a: +g.angle.toFixed(2),
          hp: g.hp,
          c: g.state === "chase" ? 1 : 0,
          p: g.possessedBy ? 1 : 0,
        })),
      reds: this.livingReds()
        .filter((p) => p.name !== selfName && (see(p.x, p.y) || v.team === "red"))
        .map((p) => ({
          n: p.name,
          x: r(p.x),
          y: r(p.y),
          a: +p.aim.toFixed(2),
          dg: p.disguise ? 1 : 0,
          hp: p.hp,
        })),
      bullets: this.bullets
        .filter((b) => see(b.x, b.y))
        .map((b) => ({ x: r(b.x), y: r(b.y) })),
      knifeSwings: this.knifeSwings
        .filter((swing) => swing.until > this.t &&
          (swing.source === v || (v.team === "red" && swing.source.kind === "red") ||
            see(swing.x, swing.y)))
        .map((swing) => ({
          x: swing.x, y: swing.y, angle: swing.angle,
          radius: KNIFE_RANGE, halfAngle: KNIFE_HALF_ANGLE,
        })),
      grenades: this.grenades
        .filter((g) => see(g.x, g.y))
        .map((g) => ({ x: r(g.x), y: r(g.y) })),
      corpses: this.corpses
        .filter((c) => see(c.x, c.y))
        .map((c) => ({
          id: c.id,
          x: r(c.x),
          y: r(c.y),
          k: c.kind,
          inv: c.invalid ? 1 : 0,
          tag: c.tag && !c.discovered ? 1 : 0,
        })),
      boom: (this.explosions || [])
        .filter((e) => see(e.x, e.y))
        .map((e) => ({ x: r(e.x), y: r(e.y) })),
    };
  }

  snapshot(p) {
    const t = this.t,
      r = Math.round;
    const snap = {
      t: "snap",
      wallBlasts: this.wallBlasts,
      pads: [...this.redPlayers(), ...this.guards]
        .filter((entity) => entity.pad)
        .map((entity) => ({ x: r(entity.pad.x), y: r(entity.pad.y) })),
      left: Math.max(0, Math.ceil(this.endAt - t)),
      dark: !this.lightsOn() ? Math.ceil(this.lightsOffUntil - t) : 0,
      emps: this.emps.filter((emp) => emp.until > t).map((emp) => ({
        x: r(emp.x), y: r(emp.y), radius: C.empRadius, seconds: Math.ceil(emp.until - t),
      })),
      servers: this.servers.map((s) => ({
        id: s.id,
        p: Math.floor((s.progress / C.serverHackSeconds) * 1000) / 1000,
        done: s.done ? 1 : 0,
        ex: s.extractor ? 1 : 0,
        lock: s.lockoutUntil > t ? 1 : 0,
        cu: s.counterUsed || s.counterCooldownUntil > t ? 1 : 0,
        counterCd: Math.max(0, Math.ceil(s.counterCooldownUntil - t)),
      })),
      doors: this.doors.map((d) => ({
        id: d.id,
        c: this.doorClosed(d) ? 1 : 0,
        h: d.open ? 1 : 0,
        e: this.empIntersectsDevice(d) ? 1 : 0,
      })),
      cams: this.cams.map((c) => ({
        id: c.id,
        a: c.angle,
        on: this.camActive(c) ? 1 : 0,
        h: c.hacked ? 1 : 0,
        e: this.empIntersectsDevice(c) ? 1 : 0,
      })),
      lasers: this.lasers.map((l) => ({
        id: l.id,
        on: this.laserActive(l) ? 1 : 0,
        b: r(l.beam),
        h: l.hacked ? 1 : 0,
        e: this.empIntersectsDevice(l) ? 1 : 0,
      })),
      lockers: this.lockers.map((l) => ({ id: l.id, r: l.readyAt <= t ? 1 : 0 })),
    };

    if (p.team === "spectator") {
      Object.assign(snap, this.worldView(p, true, null));
      snap.me = { x: r(p.x), y: r(p.y) };
    } else if (p.team === "red") {
      Object.assign(snap, this.worldView(p, false, p.name));
      // Hacked guard GPS: Red always knows where every living guard is, even through walls and fog
      snap.gps = this.guards
        .filter((g) => g.alive)
        .map((g) => ({
          id: g.id,
          x: Math.floor(g.x / 80) * 80 + 40,
          y: Math.floor(g.y / 80) * 80 + 40,
          a: +g.angle.toFixed(2),
          ...(!p.disguise && p.alive && g.possessedBy &&
            this.players.get(g.possessedBy) &&
            this.players.get(g.possessedBy).view === "shooter" &&
            this.canViewerSee(g, p.x, p.y, true)
            ? { viewerName: g.possessedBy } : {}),
        }));
      snap.me = {
        x: r(p.x),
        y: r(p.y),
        hp: p.hp,
        armor: p.armor,
        alive: p.alive,
        cur: p.cur,
        a: +p.aim.toFixed(2),
        guns: { ...p.guns },
        grenades: p.grenades,
        hasPad: p.hasPad,
        padSet: !!p.pad,
        disguised: !!p.disguise,
        charges: this.chargeStatus(this.redPool),
        disposing: p.disposing,
        respawnLeft: p.alive
          ? 0
          : Math.max(0, Math.ceil(C.respawnMaxSeconds - (t - p.deadAt))),
      };
    } else {
      const g = p.possessed && this.guards.find((x) => x.id === p.possessed);
      const markers = this.guards
        .filter((x) => x.alive)
        .map((x) => ({
          id: x.markerId,
          x: Math.floor(x.x / 80) * 80 + 40,
          y: Math.floor(x.y / 80) * 80 + 40,
          a: +x.angle.toFixed(2),
          mine: x.possessedBy === p.name ? 1 : 0,
          taken: x.possessedBy ? 1 : 0,
        }));
      for (const rp of this.livingReds()) {
        if (rp.disguise && !rp.extraction) {
          markers.push({
            id: rp.markerId,
            x: Math.floor(rp.x / 80) * 80 + 40,
            y: Math.floor(rp.y / 80) * 80 + 40,
            a: +rp.aim.toFixed(2),
            mine: 0,
            taken: 0,
          });
        }
      }
      snap.markers = markers;
      snap.pings = this.pings.map((q) => ({
        k: q.kind,
        x: r(q.x),
        y: r(q.y),
        s: Math.ceil(q.until - t),
      }));
      snap.camSeen = this.cams.flatMap((c) =>
        c.seen
          .map((n) => this.players.get(n))
          .filter((rp) => rp && rp.alive && !rp.disguise)
          .map((rp) => ({
            cam: c.id,
            x: r(rp.x),
            y: r(rp.y),
            n: rp.name,
            a: +rp.aim.toFixed(2),
            hp: rp.hp,
          })),
      );
      // Only report current detections; lastSeen/target may otherwise retain stale positions.
      const detectedNames = new Set(this.cams.flatMap((camera) => camera.seen));
      for (const guard of this.guards) {
        if (
          guard.alive &&
          !guard.possessedBy &&
          guard.lastSeen === t &&
          guard.seenPlayer
        ) {
          detectedNames.add(guard.seenPlayer.name);
        }
        if (guard.alive && guard.possessedBy) {
          for (const red of this.livingReds()) {
            if (!red.disguise && this.guardSees(guard, red.x, red.y)) {
              detectedNames.add(red.name);
            }
          }
        }
      }
      snap.detectedReds = this.livingReds()
        .filter((red) => !red.disguise && detectedNames.has(red.name))
        .map((red) => ({ name: red.name, x: r(red.x), y: r(red.y) }));
      snap.extractingReds = this.livingReds()
        .filter((red) => red.extraction)
        .map((red) => ({
          n: red.name,
          x: r(red.x),
          y: r(red.y),
          a: +red.aim.toFixed(2),
          hp: red.hp,
        }));
      snap.me = {
        view: p.view,
        possessed: !!g,
        charges: this.chargeStatus(this.bluePool),
        darkCd: Math.max(0, Math.ceil(this.lightsCdUntil - t)),
        alertCd: Math.max(0, Math.ceil(this.alertCdUntil - t)),
        empCd: Math.max(0, Math.ceil(this.empCdUntil - t)),
        possessCd: Math.max(0, Math.ceil(p.possessCdUntil - t)),
      };
      if (g) {
        Object.assign(snap, this.worldView(g, true, null));
        // A disguise is presented as an ordinary guard, never as a named Red.
        snap.reds = snap.reds.filter((red) => !red.dg);
        for (const red of this.livingReds()) {
          if (red.disguise) {
            p.redLastSeen.delete(red.name);
            if (!red.extraction && this.canViewerSee(g, red.x, red.y, true)) {
              snap.guards.push({
                id: red.markerId,
                x: r(red.x),
                y: r(red.y),
                a: +red.aim.toFixed(2),
                hp: Math.max(0, Math.ceil(red.hp * C.guardHp / C.redHp)),
                c: 0,
                p: 0,
              });
            }
          }
        }
        if (p.view === "shooter") {
          // Only direct shooter-view sightings start or refresh the tracking window.
          const visibleNames = new Set(snap.reds.map((red) => red.n));
          const cameraNames = new Set(snap.camSeen.map((red) => red.n));
          for (const red of this.livingReds()) {
            if (red.extraction) {
              if (!red.disguise && visibleNames.has(red.name)) {
                p.redLastSeen.set(red.name, t);
              }
              snap.reds = snap.reds.filter((item) => item.n !== red.name);
              const extracting = snap.extractingReds.find((item) => item.n === red.name);
              snap.reds.push({ ...extracting, dg: 0, extracting: 1 });
              continue;
            }
            if (red.disguise) continue;
            if (visibleNames.has(red.name)) {
              p.redLastSeen.set(red.name, t);
            } else if (cameraNames.has(red.name)) {
              snap.reds.push({
                n: red.name,
                x: r(red.x),
                y: r(red.y),
                a: +red.aim.toFixed(2),
                dg: 0,
                hp: red.hp,
                cameraDetected: 1,
              });
            } else {
              const lastSeen = p.redLastSeen.get(red.name);
              if (lastSeen !== undefined && t - lastSeen < C.possessedRedTrackingSeconds) {
                snap.reds.push({
                  n: red.name,
                  x: r(red.x),
                  y: r(red.y),
                  a: +red.aim.toFixed(2),
                  dg: red.disguise ? 1 : 0,
                  hp: red.hp,
                  tracked: 1,
                });
              } else {
                p.redLastSeen.delete(red.name);
              }
            }
          }
        }
        snap.me.guard = {
          id: g.id,
          x: r(g.x),
          y: r(g.y),
          hp: g.hp,
          a: +g.aim.toFixed(2),
          armor: g.armor,
          cur: g.cur,
          guns: { ...g.guns },
          grenades: g.grenades,
          hasPad: g.hasPad,
          padSet: !!g.pad,
        };
      }
    }
    return snap;
  }
}

module.exports = { Game };
