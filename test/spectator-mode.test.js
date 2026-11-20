const test = require("node:test");
const assert = require("node:assert/strict");
const { Game } = require("../game/game");
const C = require("../game/config");
const M = require("../game/map");

function setup() {
  const messages = [];
  const game = new Game((name, message) => messages.push({ name, message }));
  game.connect("red");
  game.connect("blue");
  game.startMatch();
  return { game, red: game.players.get("red"), blue: game.players.get("blue"), messages };
}

test("Red can spectate and return to a fresh spawn on the same team", () => {
  const { game, red, messages } = setup();
  red.hp = 1;
  red.guns.pistol = 1;
  red.pad = { x: 10, y: 10 };
  red.input.fire = true;
  const oldPosition = { x: red.x, y: red.y };
  game.handle("red", { t: "spectator_mode", enabled: true });
  assert.equal(red.team, "spectator");
  assert.equal(red.returnTeam, "red");
  assert.equal(red.input.fire, false);
  assert.deepEqual({ x: red.x, y: red.y }, oldPosition);
  assert.ok(!game.livingReds().includes(red));
  const role = messages.findLast((entry) => entry.name === "red" && entry.message.t === "role_changed").message;
  assert.equal(role.returnTeam, "red");
  assert.equal(role.snapshot.me.x, Math.round(oldPosition.x));
  game.handle("red", { t: "act", a: "weapon_select", weapon: "smg" });
  assert.equal(red.cur, "pistol");
  game.handle("red", { t: "spectator_mode", enabled: true });
  assert.equal(red.team, "spectator");
  game.handle("red", { t: "spectator_mode", enabled: false });
  assert.equal(red.team, "red");
  assert.equal(red.returnTeam, null);
  assert.equal(red.alive, true);
  assert.equal(red.hp, C.redHp);
  assert.equal(red.guns.pistol, C.pistolAmmo);
  assert.equal(red.pad, null);
  assert.ok(game.livingReds().includes(red));
});

test("switching to spectator interrupts extraction, counterhack, and reboot", () => {
  const { game, red, blue, messages } = setup();
  const server = game.servers[0];
  server.extractor = red.name;
  server.extractionId = "session";
  server.progress = 6;
  red.extraction = { server: server.id, sessionId: "session", challengeId: "extract" };
  blue.counter = { id: "counter", sessionId: "session", server: server.id };
  game.handle("red", { t: "spectator_mode", enabled: true });
  assert.equal(red.extraction, null);
  assert.equal(blue.counter, null);
  assert.equal(server.extractor, null);
  assert.equal(server.progress, 6);
  assert.ok(messages.some((entry) => entry.name === "red" && entry.message.id === "extract" && entry.message.t === "minigame_cancel"));
  assert.ok(messages.some((entry) => entry.name === "blue" && entry.message.id === "counter" && entry.message.t === "minigame_cancel"));
  game.handle("red", { t: "spectator_mode", enabled: false });
  red.alive = false;
  red.deadAt = game.t;
  red.respawnGame = { id: "reboot" };
  game.handle("red", { t: "spectator_mode", enabled: true });
  assert.equal(red.respawnGame, null);
  assert.ok(messages.some((entry) => entry.message.id === "reboot" && entry.message.t === "minigame_cancel"));
  game.handle("red", { t: "spectator_mode", enabled: false });
  assert.equal(red.alive, true);
});

test("Blue releases a guard and abandons counterhack before returning to radar", () => {
  const { game, blue, messages } = setup();
  const guard = game.guards[0];
  guard.possessedBy = blue.name;
  blue.possessed = guard.id;
  blue.view = "shooter";
  blue.counter = { id: "counter" };
  game.handle("blue", { t: "spectator_mode", enabled: true });
  assert.equal(blue.team, "spectator");
  assert.equal(guard.possessedBy, null);
  assert.equal(blue.counter, null);
  assert.equal(blue.x, guard.x);
  assert.ok(messages.some((entry) => entry.message.id === "counter" && entry.message.t === "minigame_cancel"));
  game.handle("blue", { t: "spectator_mode", enabled: false });
  assert.equal(blue.team, "blue");
  assert.equal(blue.view, "radar");
  assert.equal(blue.possessed, null);
});

test("reconnect retains the original team and late spectators cannot join a team", () => {
  const { game, red, messages } = setup();
  game.handle("red", { t: "spectator_mode", enabled: true });
  game.disconnect("red");
  game.connect("red");
  const init = messages.findLast((entry) => entry.name === "red" && entry.message.t === "init").message;
  assert.equal(init.team, "spectator");
  assert.equal(init.returnTeam, "red");
  game.connect("late");
  const late = game.players.get("late");
  game.handle("late", { t: "spectator_mode", enabled: false });
  assert.equal(late.team, "spectator");
  game.handle("late", { t: "team", team: "red" });
  assert.equal(late.team, "spectator");
  game.backToLobby();
  assert.equal(red.team, "red");
  assert.equal(red.returnTeam, null);
  assert.equal(late.team, "spectator");
});

test("spectator mode is unavailable outside an active match", () => {
  const { game } = setup();
  game.backToLobby();
  game.handle("red", { t: "spectator_mode", enabled: true });
  assert.equal(game.players.get("red").team, "red");
  game.phase = "ended";
  game.handle("red", { t: "spectator_mode", enabled: true });
  assert.equal(game.players.get("red").team, "red");
});

test("spectators move faster with run input while retaining normalized movement and bounds", () => {
  const { game, red } = setup();
  game.handle("red", { t: "spectator_mode", enabled: true });
  const x = M.WORLD.w / 2;
  const y = M.WORLD.h / 2;
  function move(mx, my, run) {
    red.x = x;
    red.y = y;
    game.handle("red", { t: "input", mx, my, run });
    game.tick();
    return Math.hypot(red.x - x, red.y - y);
  }
  const walking = move(1, 0, false);
  const running = move(1, 0, true);
  let spectator = game.snapshot(red).me;
  assert.equal(spectator.d, 1);
  assert.ok(spectator.dx < spectator.x);
  assert.equal(spectator.dy, spectator.y);
  const diagonal = move(1, 1, true);
  spectator = game.snapshot(red).me;
  assert.equal(spectator.d, 1);
  assert.ok(spectator.dx < spectator.x && spectator.dy < spectator.y);
  assert.ok(Math.abs(walking - C.redSpeed / C.tickRate) < 1e-8);
  assert.ok(Math.abs(running - walking * C.runSpeedMultiplier) < 1e-8);
  assert.ok(Math.abs(diagonal - running) < 1e-8);
  red.x = M.WORLD.w - 1;
  red.y = M.WORLD.h - 1;
  game.handle("red", { t: "input", mx: 1, my: 1, run: true });
  game.tick();
  assert.equal(red.x, M.WORLD.w);
  assert.equal(red.y, M.WORLD.h);
  game.handle("red", { t: "input", mx: 0, my: 0, run: true });
  assert.equal(game.snapshot(red).me.d, 0);
  game.handle("red", { t: "input", mx: 1, my: 0, run: false });
  assert.equal(game.snapshot(red).me.d, 0);
});
