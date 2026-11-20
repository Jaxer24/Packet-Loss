const test = require("node:test");
const assert = require("node:assert/strict");
const { MouseMinigame } = require("../public/minigames");

global.window = { addEventListener() {}, removeEventListener() {} };

function createGame(type) {
  const context = new Proxy({}, { get: (target, key) => target[key] || (() => {}) });
  const canvas = {
    width: 400, height: 240,
    getContext: () => context,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 240 }),
    addEventListener() {},
    removeEventListener() {},
  };
  const results = [];
  const game = new MouseMinigame(canvas, type, 5, (ok, reason) => results.push({ ok, reason }), () => {}, 10);
  const event = (point) => ({ clientX: point.x, clientY: point.y, button: 0 });
  game.onDown(event({ x: 30, y: 120 }));
  return { game, results, move: (point) => game.onMove(event(point)) };
}

test("maze succeeds only after two completed mazes", () => {
  const { game, results, move } = createGame("maze");
  for (let round = 0; round < 2; round++) {
    for (const point of game.maze.slice(1)) move(point);
    if (round === 0) {
      assert.equal(game.completedMazes, 1);
      assert.deepEqual(results, []);
    }
  }
  assert.deepEqual(results, [{ ok: true, reason: "" }]);
});

test("ghost run succeeds on the last dot and still fails on a simultaneous collision", () => {
  const { game, results } = createGame("pacman");
  game.dots.forEach((dot, i) => { dot.taken = i !== 0; });
  game.pointer = { ...game.dots[0] };
  game.draw();
  assert.deepEqual(results, [{ ok: true, reason: "" }]);

  const collision = createGame("pacman");
  collision.game.dots.forEach((dot) => { dot.taken = true; });
  collision.game.dots[0] = { x: 200, y: 200, taken: false };
  collision.game.pointer = { x: 200, y: 200 };
  collision.game.draw();
  assert.equal(collision.results[0].ok, false);
  assert.match(collision.results[0].reason, /ghost/);
});

test("the red ghost follows and catches a stationary cursor in every corner", (t) => {
  let now = 1000;
  t.mock.method(performance, "now", () => now);
  for (const point of [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 0, y: 240 }, { x: 400, y: 240 }]) {
    const { game, results, move } = createGame("pacman");
    move(point);
    const startDistance = Math.hypot(game.chasingGhost.x - point.x, game.chasingGhost.y - point.y);
    now += 1000;
    game.draw();
    const nextDistance = Math.hypot(game.chasingGhost.x - point.x, game.chasingGhost.y - point.y);
    assert.ok(Math.abs(startDistance - nextDistance - 70) < 1e-8);
    assert.deepEqual(results, []);
    for (let i = 0; i < 80 && !game.ended; i++) {
      now += 100;
      game.draw();
    }
    assert.equal(results[0].ok, false);
    assert.match(results[0].reason, /ghost/);
    assert.ok(Math.hypot(game.chasingGhost.x - point.x, game.chasingGhost.y - point.y) < 20);
  }
});

test("the red ghost changes direction toward the cursor and hard mode speeds it up", (t) => {
  let now = 1000;
  t.mock.method(performance, "now", () => now);
  const { game, results, move } = createGame("pacman");
  move({ x: 400, y: 200 });
  now += 1000;
  game.draw();
  assert.equal(game.chasingGhost.x, 270);
  move({ x: 0, y: 200 });
  now += 1000;
  game.draw();
  assert.equal(game.chasingGhost.x, 200);
  assert.deepEqual(results, []);

  const hard = createGame("pacman");
  hard.game.difficulty = 1;
  hard.move({ x: 400, y: 200 });
  now += 1000;
  hard.game.draw();
  assert.equal(hard.game.chasingGhost.x, 319);
  assert.deepEqual(hard.results, []);
});

test("routing requires two randomized, non-overlapping screens", () => {
  const { game, results, move } = createGame("routing");
  for (let round = 0; round < 2; round++) {
    const nodes = game.routeNodes.map((node) => ({ ...node }));
    for (let i = 0; i < nodes.length; i++) {
      assert.ok(nodes[i].x >= 17 && nodes[i].x <= 383);
      assert.ok(nodes[i].y >= 17 && nodes[i].y <= 223);
      for (let j = 0; j < i; j++) {
        assert.ok(Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y) > 40);
      }
    }
    for (const node of nodes) move(node);
    if (round === 0) {
      assert.equal(game.completedRoutes, 1);
      assert.deepEqual(results, []);
      assert.notDeepEqual(game.routeNodes, nodes);
    }
  }
  assert.deepEqual(results, [{ ok: true, reason: "" }]);
});

test("objective games do not succeed just because their play time elapsed", () => {
  for (const type of ["maze", "pacman", "routing"]) {
    const { game, results } = createGame(type);
    game.playStarted -= 6000;
    if (type === "maze") game.mazeStarted = performance.now();
    game.draw();
    assert.deepEqual(results, []);
  }
});

test("scanner stays continuous when it reaches the edge", (t) => {
  let now = 1000;
  t.mock.method(performance, "now", () => now);
  const { game, results } = createGame("scanner");
  game.seconds = 10;
  const elapsedAtEdge = (400 - 30) / 70;
  now += elapsedAtEdge * 1000;
  game.pointer = { x: 400, y: 120 };
  game.draw();
  assert.deepEqual(results, []);

  now += 100;
  game.pointer = { x: 393, y: 120 };
  game.draw();
  assert.deepEqual(results, []);

});

test("scanner succeeds by remaining inside until the deadline, but fails before it outside", (t) => {
  let now = 1000;
  t.mock.method(performance, "now", () => now);
  const { game, results } = createGame("scanner");
  for (let ms = 100; ms <= 5000; ms += 100) {
    now = 1000 + ms;
    const distance = 30 + ms / 1000 * 70;
    game.pointer = { x: distance <= 400 ? distance : 800 - distance, y: 120 };
    game.draw();
    assert.deepEqual(results, []);
  }
  now += 1000;
  game.pointer = { x: 0, y: 120 };
  game.draw();
  assert.deepEqual(results, []);

  const failed = createGame("scanner");
  failed.game.pointer = { x: 200, y: 120 };
  failed.game.draw();
  assert.equal(failed.results[0].ok, false);
  assert.match(failed.results[0].reason, /scanner zone/);
});
