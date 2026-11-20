const test = require("node:test");
const assert = require("node:assert/strict");
const { Game } = require("../game/game");
const C = require("../game/config");

function lobby() {
  const messages = [];
  const game = new Game((name, message) => messages.push({ name, message }));
  game.connect("host");
  game.connect("guest");
  return { game, messages };
}

test("hard mode is host-controlled in the lobby and persists between matches", () => {
  const { game, messages } = lobby();
  assert.equal(game.lobbyMsg().hardMode, false);
  game.handle("guest", { t: "hard_mode", enabled: true });
  assert.equal(game.hardMode, false);
  game.handle("host", { t: "hard_mode", enabled: "true" });
  assert.equal(game.hardMode, false);
  game.handle("host", { t: "hard_mode", enabled: false });
  assert.equal(game.hardMode, false);
  for (const name of ["host", "guest"]) {
    assert.equal(messages.filter((entry) => entry.name === name).at(-1).message.hardMode, false);
  }
  game.startMatch();
  game.handle("host", { t: "hard_mode", enabled: true });
  assert.equal(game.hardMode, false);
  game.backToLobby();
  assert.equal(game.lobbyMsg().hardMode, false);
  game.handle("host", { t: "hard_mode", enabled: true });
  assert.equal(game.lobbyMsg().hardMode, true);
});

test("hard mode controls recoil for both Red players and guards", () => {
  for (const enabled of [false, true]) {
    const { game } = lobby();
    game.handle("host", { t: "hard_mode", enabled });
    game.startMatch();
    const red = game.players.get("host");
    const guard = game.guards[0];
    for (const entity of [red, guard]) {
      entity.cur = "smg";
      entity.guns.smg = 30;
      entity.input = { mx: 0, my: 0, ax: entity.x + 100, ay: entity.y };
      game.fire(entity, game.t);
      game.fire(entity, game.t + 0.1);
      const bullet = game.bullets.at(-1);
      if (enabled) assert.ok(Math.abs(bullet.vy) > 1);
      else assert.equal(bullet.vy, 0);
    }
  }
});

test("hard mode controls difficulty for extraction, counterhack, and respawn", () => {
  for (const enabled of [false, true]) {
    const { game, messages } = lobby();
    game.handle("host", { t: "hard_mode", enabled });
    game.startMatch();
    const red = game.players.get("host");
    const blue = game.players.get("guest");
    const server = game.servers[0];
    game.t = game.startedAt + C.matchSeconds / 2;
    server.progress = C.serverHackSeconds / 2;
    game.servers[1].done = true;
    server.extractor = red.name;
    server.extractionId = "session";
    red.extraction = { server: server.id, sessionId: server.extractionId };
    game.startServerChallenge(red);
    game.blueAct(blue, { a: "counter", id: server.id });
    red.alive = false;
    red.deadAt = game.t;
    game.act(red, { a: "respawn_start", request: 1 });
    for (const purpose of ["extraction", "counterhack", "respawn"]) {
      const message = messages.findLast((entry) =>
        entry.message.t === "minigame" && entry.message.purpose === purpose).message;
      const expected = enabled ? (purpose === "respawn" ? 0.355 : 0.445) : 0;
      assert.ok(Math.abs(message.difficulty - expected) < 1e-10, purpose);
    }
  }
});

test("hard mode controls continuous guard tracking but preserves the initial server alert", () => {
  for (const enabled of [false, true]) {
    const { game } = lobby();
    game.handle("host", { t: "hard_mode", enabled });
    game.startMatch();
    const red = game.players.get("host");
    const server = game.servers[0];
    red.x = server.x + 10;
    red.y = server.y;
    const [near, far] = game.guards;
    near.x = server.x + 100;
    near.y = server.y;
    far.x = server.x + 900;
    far.y = server.y;
    for (const guard of game.guards) {
      guard.state = "patrol";
      guard.path = [];
    }
    game.empBlocksExtraction = () => false;
    game.startServerExtraction(red, server.id);
    assert.ok(red.extraction);
    assert.equal(near.state, "investigate");
    assert.deepEqual(near.target, enabled ? { x: red.x, y: red.y } : { x: server.x, y: server.y });
    assert.equal(far.state, enabled ? "investigate" : "patrol");
    red.x += 50;
    game.guardSees = () => false;
    game.findWallPath = () => [];
    game.tickGuard(near, 0, game.t + 1);
    assert.deepEqual(near.target, enabled ? { x: red.x, y: red.y } : { x: server.x, y: server.y });
    assert.equal(near.extractionTarget, enabled ? red.name : null);
    game.tickGuard(far, 0, game.t + 1);
    assert.equal(far.extractionTarget, enabled ? red.name : null);
    game.stopServerExtraction(red);
    if (enabled) {
      assert.equal(near.extractionTarget, null);
      assert.deepEqual(near.target, { x: red.x, y: red.y });
    }
  }
});

test("normal mode still chases an extractor on direct sight", () => {
  const { game } = lobby();
  game.handle("host", { t: "hard_mode", enabled: false });
  game.startMatch();
  const red = game.players.get("host");
  const server = game.servers[0];
  const guard = game.guards[0];
  red.x = server.x + 10;
  red.y = server.y;
  guard.x = red.x + 100;
  guard.y = red.y;
  game.empBlocksExtraction = () => false;
  game.startServerExtraction(red, server.id);
  game.guardSees = () => true;
  game.findWallPath = () => [];
  game.tickGuard(guard, 0, game.t + 1);
  assert.equal(guard.state, "chase");
  assert.equal(guard.seenPlayer, red);
  assert.equal(guard.extractionTarget, null);
  assert.deepEqual(guard.target, { x: red.x, y: red.y });
});

test("normal mode alerts available guards once when the minigame starts, even beyond noise range", () => {
  const { game } = lobby();
  game.handle("host", { t: "hard_mode", enabled: false });
  game.startMatch();
  const red = game.players.get("host");
  const server = game.servers[0];
  const [near, far, chasing, possessed, dead] = game.guards;
  red.x = server.x;
  red.y = server.y;
  game.empBlocksExtraction = () => false;
  game.startServerExtraction(red, server.id);
  const id = red.extraction.challengeId;
  red.x += 50;
  near.x = red.x + 100; near.y = red.y;
  far.x = red.x + 801; far.y = red.y;
  chasing.x = red.x; chasing.y = red.y; chasing.state = "chase";
  possessed.x = red.x; possessed.y = red.y; possessed.possessedBy = "guest";
  dead.x = red.x; dead.y = red.y; dead.alive = false;
  for (const guard of [far, chasing, possessed, dead]) guard.target = { x: -1, y: -1 };

  game.manualAlertSequence = 1;
  game.latestManualAlert = {
    x: red.x + 200, y: red.y, until: game.t + 10, sequence: 1,
  };
  game.act(red, { a: "server_ready", id: "wrong" });
  assert.equal(red.extraction.readyAt, null);
  game.act(red, { a: "server_ready", id });
  assert.deepEqual(near.target, { x: red.x, y: red.y });
  assert.deepEqual(far.target, { x: red.x, y: red.y });
  for (const guard of [chasing, possessed, dead]) assert.deepEqual(guard.target, { x: -1, y: -1 });
  const alertPosition = { ...near.target };
  red.x += 100;
  game.act(red, { a: "server_ready", id });
  game.guardSees = () => false;
  game.findWallPath = () => [];
  game.tickGuard(near, 0, game.t + 1);
  game.tickGuard(far, 0, game.t + 1);
  assert.deepEqual(near.target, alertPosition);
  assert.deepEqual(far.target, alertPosition);
  assert.equal(near.extractionTarget, null);
});
