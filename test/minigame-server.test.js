const test = require("node:test");
const assert = require("node:assert/strict");
const { Game } = require("../game/game");
const C = require("../game/config");

function setup() {
  const messages = [];
  const game = new Game((name, message) => messages.push({ name, message }));
  game.connect("red");
  game.connect("blue");
  game.startMatch();
  game.insideServerRoom = () => true;
  game.empBlocksExtraction = () => false;
  return { game, red: game.players.get("red"), blue: game.players.get("blue"), messages };
}

function select(value, action) {
  const random = Math.random;
  Math.random = () => value;
  try { action(); } finally { Math.random = random; }
}

function extraction(game, red, random) {
  const server = game.servers[0];
  server.extractor = red.name;
  server.extractionId = "session";
  red.extraction = { server: server.id, sessionId: server.extractionId };
  select(random, () => game.startServerChallenge(red));
  game.act(red, { a: "server_ready", id: red.extraction.challengeId });
  return server;
}

test("objective completion starts a new challenge without granting extra extraction progress", () => {
  for (const random of [0.2, 0.45, 0.6]) {
    const { game, red, messages } = setup();
    const server = extraction(game, red, random);
    const id = red.extraction.challengeId;
    game.t += 2;
    game.tickServers(2, game.t);
    assert.equal(server.done, false);
    select(0.01, () => game.act(red, { a: "server_result", id, ok: true }));
    assert.equal(server.done, false);
    assert.equal(server.progress, 2);
    assert.equal(red.extraction.readyAt, null);
    assert.notEqual(red.extraction.challengeId, id);
    const next = messages.findLast((entry) => entry.message.t === "minigame").message;
    assert.equal(next.game, "flappy");
    assert.equal(next.seconds, C.serverChallengeSeconds);
    game.t += 3;
    game.tickServers(3, game.t);
    assert.equal(server.progress, 2);
    game.act(red, { a: "server_result", id, ok: false });
    assert.ok(red.extraction);

    const failed = setup();
    const failedServer = extraction(failed.game, failed.red, random);
    failed.game.t += 2;
    failed.game.tickServers(2, failed.game.t);
    failed.game.act(failed.red, { a: "server_result", id: failed.red.extraction.challengeId, ok: false });
    assert.equal(failedServer.done, false);
    assert.equal(failedServer.progress, 2);
  }
});

test("objective extraction cannot advance to the next challenge before ready", () => {
  const { game, red } = setup();
  const server = extraction(game, red, 0.2);
  red.extraction.readyAt = null;
  const id = red.extraction.challengeId;
  game.act(red, { a: "server_result", id, ok: true });
  assert.equal(server.done, false);
  game.act(red, { a: "server_ready", id });
  game.act(red, { a: "server_result", id, ok: true });
  assert.equal(server.done, false);
  assert.notEqual(red.extraction.challengeId, id);
  assert.equal(server.progress, 0);
});

test("counterhack objective does not auto-complete and accepts early completion", () => {
  for (const random of [0.2, 0.45, 0.6]) {
    const { game, red, blue } = setup();
    const server = extraction(game, red, 0.01);
    server.progress = 10;
    select(random, () => game.blueAct(blue, { a: "counter", id: server.id }));
    const id = blue.counter.id;
    game.blueAct(blue, { a: "cm_result", id, ok: true });
    assert.ok(blue.counter);
    game.blueAct(blue, { a: "cm_ready", id });
    game.t += C.counterhackSeconds + 1;
    game.tickBlue(blue, game.t);
    assert.ok(blue.counter);
    game.blueAct(blue, { a: "cm_result", id, ok: true });
    assert.equal(blue.counter, null);
    assert.equal(server.progress, 5);
    assert.equal(server.extractor, null);

    const early = setup();
    const earlyServer = extraction(early.game, early.red, 0.01);
    earlyServer.progress = 10;
    select(random, () => early.game.blueAct(early.blue, { a: "counter", id: earlyServer.id }));
    const earlyId = early.blue.counter.id;
    early.game.blueAct(early.blue, { a: "cm_ready", id: earlyId });
    early.game.blueAct(early.blue, { a: "cm_result", id: earlyId, ok: true });
    assert.equal(earlyServer.progress, 5);
  }
});

test("objective respawn waits for completion but automatic respawn remains available", () => {
  for (const random of [0.2, 0.45, 0.6]) {
    const { game, red } = setup();
    red.alive = false;
    red.deadAt = game.t;
    select(random, () => game.act(red, { a: "respawn_start", request: 1 }));
    const id = red.respawnGame.id;
    game.act(red, { a: "respawn_result", id, ok: true });
    assert.equal(red.alive, false);
    game.act(red, { a: "respawn_ready", id, spawn: 0 });
    game.t += C.counterhackSeconds + 1;
    game.tickRed(red, 0, game.t);
    assert.equal(red.alive, false);
    game.act(red, { a: "respawn_result", id, ok: true });
    assert.equal(red.alive, true);

    red.alive = false;
    red.deadAt = game.t;
    select(random, () => game.act(red, { a: "respawn_start", request: 3 }));
    const earlyId = red.respawnGame.id;
    game.act(red, { a: "respawn_ready", id: earlyId, spawn: 0 });
    game.act(red, { a: "respawn_result", id: earlyId, ok: true });
    assert.equal(red.alive, true);

    red.alive = false;
    red.deadAt = game.t;
    select(random, () => game.act(red, { a: "respawn_start", request: 2 }));
    game.act(red, { a: "respawn_ready", id: red.respawnGame.id, spawn: 0 });
    game.t += C.respawnMaxSeconds;
    game.tickRed(red, 0, game.t);
    assert.equal(red.alive, true);
  }
});

test("timed challenges still auto-complete only after their duration", () => {
  const { game, red, blue } = setup();
  const server = extraction(game, red, 0.01);
  select(0.01, () => game.blueAct(blue, { a: "counter", id: server.id }));
  const id = blue.counter.id;
  game.blueAct(blue, { a: "cm_ready", id });
  game.blueAct(blue, { a: "cm_result", id, ok: true });
  assert.ok(blue.counter);
  game.t += C.counterhackSeconds;
  game.tickBlue(blue, game.t);
  assert.equal(blue.counter, null);
  assert.equal(server.extractor, null);
});

test("timed extraction challenges repeat until the full active extraction duration", () => {
  const { game, red } = setup();
  const server = extraction(game, red, 0.01);
  const id = red.extraction.challengeId;
  game.act(red, { a: "server_result", id, ok: true });
  assert.equal(server.done, false);
  for (let n = 0; n < C.serverHackSeconds / C.serverChallengeSeconds; n++) {
    game.t += C.serverChallengeSeconds;
    select(0.01, () => game.tickServers(C.serverChallengeSeconds, game.t));
    if (server.done) break;
    assert.equal(server.progress, (n + 1) * C.serverChallengeSeconds);
    assert.equal(red.extraction.readyAt, null);
    game.t += 2;
    game.tickServers(2, game.t);
    assert.equal(server.progress, (n + 1) * C.serverChallengeSeconds);
    game.act(red, { a: "server_ready", id: red.extraction.challengeId });
  }
  assert.equal(server.done, true);
  assert.equal(server.progress, C.serverHackSeconds);
});

test("timed respawn retains its original duration", () => {
  const { game, red } = setup();
  red.alive = false;
  red.deadAt = game.t;
  select(0.01, () => game.act(red, { a: "respawn_start" }));
  const respawnId = red.respawnGame.id;
  game.act(red, { a: "respawn_ready", id: respawnId, spawn: 0 });
  game.act(red, { a: "respawn_result", id: respawnId, ok: true });
  assert.equal(red.alive, false);
  game.t += C.counterhackSeconds;
  game.tickRed(red, 0, game.t);
  assert.equal(red.alive, true);
});

test("active objective challenges can complete extraction by reaching total play time", () => {
  const { game, red } = setup();
  const server = extraction(game, red, 0.2);
  server.progress = C.serverHackSeconds - 1;
  game.t += 1;
  game.tickServers(1, game.t);
  assert.equal(server.done, true);
});

test("timed challenge progress is capped at its duration and entry timeouts preserve progress", () => {
  const { game, red } = setup();
  const server = extraction(game, red, 0.01);
  game.t += C.serverChallengeSeconds + 2;
  game.tickServers(C.serverChallengeSeconds + 2, game.t);
  assert.equal(server.progress, C.serverChallengeSeconds);
  assert.equal(red.extraction.readyAt, null);
  game.t += C.serverChallengeEntrySeconds + 3;
  game.tickServers(C.serverChallengeEntrySeconds + 3, game.t);
  assert.equal(red.extraction, null);
  assert.equal(server.progress, C.serverChallengeSeconds);
  assert.equal(server.done, false);
});

test("each new extraction challenge alerts guards in both difficulty modes", () => {
  for (const hardMode of [false, true]) {
    const { game, red } = setup();
    game.hardMode = hardMode;
    const server = extraction(game, red, 0.2);
    const guard = game.guards[0];
    guard.state = "patrol";
    guard.possessedBy = null;
    guard.alive = true;
    red.x = server.x;
    red.y = server.y;
    const id = red.extraction.challengeId;
    select(0.01, () => game.act(red, { a: "server_result", id, ok: true }));
    red.x += 50;
    red.y += 25;
    game.act(red, { a: "server_ready", id: red.extraction.challengeId });
    assert.deepEqual(guard.target, { x: red.x, y: red.y });
    assert.equal(guard.state, "investigate");
    const target = { ...guard.target };
    red.x += 20;
    game.act(red, { a: "server_ready", id: red.extraction.challengeId });
    assert.deepEqual(guard.target, target);
  }
});

test("bot extraction keeps its uninterrupted timer", () => {
  const { game, red } = setup();
  const server = extraction(game, red, 0.01);
  red.bot = true;
  game.t += C.serverHackSeconds;
  game.tickServers(C.serverHackSeconds, game.t);
  assert.equal(server.done, true);
  assert.equal(server.progress, C.serverHackSeconds);
});
