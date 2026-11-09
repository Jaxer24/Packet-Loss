// The facility map. The level data (walls, doors, servers, ...) is generated from the GDD artwork
// by tools/build_map.py and stored in facility.json. This file loads it and adds the helpers the
// game needs: collision lookups and the path finder used by guards.
// Coordinates: x right, y down. The artwork is public/facility.png, drawn at world size.

const data = require("./facility.json");
const { walls: generatedWalls } = require("./walls.json");
const { segHitsRect } = require("./geom");
const { playerRadius } = require("./config");
const { carve } = require("../public/wall-destruction");

const WORLD = data.WORLD;
// Manual tweaks live in map-edits.json so regenerating facility.json never erases them.
// "addWalls": rectangles to make solid. "removeWalls": rectangles to carve out of existing walls.
let walls = generatedWalls;
let edits = { addWalls: [], removeWalls: [] };
try {
  edits = { ...edits, ...require("./map-edits.json") };
} catch (e) {
  /* no edits file: fine */
}

// Cut the rectangle `cut` out of wall `w`; returns the leftover pieces (up to 4)
function subtractRect(w, cut) {
  const x0 = Math.max(w.x, cut.x),
    y0 = Math.max(w.y, cut.y);
  const x1 = Math.min(w.x + w.w, cut.x + cut.w),
    y1 = Math.min(w.y + w.h, cut.y + cut.h);
  if (x0 >= x1 || y0 >= y1) {
    return [w];
  } // no overlap
  const out = [];
  if (y0 > w.y) {
    out.push({ x: w.x, y: w.y, w: w.w, h: y0 - w.y });
  }
  if (y1 < w.y + w.h) {
    out.push({ x: w.x, y: y1, w: w.w, h: w.y + w.h - y1 });
  }
  if (x0 > w.x) {
    out.push({ x: w.x, y: y0, w: x0 - w.x, h: y1 - y0 });
  }
  if (x1 < w.x + w.w) {
    out.push({ x: x1, y: y0, w: w.x + w.w - x1, h: y1 - y0 });
  }
  return out;
}
for (const cut of edits.removeWalls) {
  walls = walls.flatMap((w) => subtractRect(w, cut));
}
walls = walls.concat(edits.addWalls);
const obstacles = [];
const serverBlocks = []; // servers are consoles you stand next to, not solid blocks
const { servers, doors, lasers, cameras, lockers, redSpawns, routes } = data;
const solids = walls;

// ---------- Spatial index: bucket the walls so we only test the ones near a point/segment ----------
// Each query stamps visited walls so a wall spanning multiple buckets is only tested once.
const B = 100;
const BC = Math.ceil(WORLD.w / B),
  BR = Math.ceil(WORLD.h / B);
const buckets = Array.from({ length: BC * BR }, () => []);
for (const s of solids) {
  s.q = 0; // "last query" stamp used to skip duplicates
  const c0 = Math.floor(s.x / B),
    c1 = Math.floor((s.x + s.w) / B);
  const r0 = Math.floor(s.y / B),
    r1 = Math.floor((s.y + s.h) / B);
  for (let r = Math.max(0, r0); r <= Math.min(BR - 1, r1); r++) {
    for (let c = Math.max(0, c0); c <= Math.min(BC - 1, c1); c++) {
      buckets[r * BC + c].push(s);
    }
  }
}
let stamp = 0;
const bc = (v) => Math.max(0, Math.min(BC - 1, Math.floor(v / B)));
const br = (v) => Math.max(0, Math.min(BR - 1, Math.floor(v / B)));

// Walls inside the box (used for movement collision)
function solidsNear(x, y, rad) {
  stamp++;
  const out = [];
  for (let r = br(y - rad); r <= br(y + rad); r++) {
    for (let c = bc(x - rad); c <= bc(x + rad); c++) {
      for (const s of buckets[r * BC + c]) {
        if (s.q !== stamp) {
          s.q = stamp;
          out.push(s);
        }
      }
    }
  }
  return out;
}

// Does the straight line cross any wall? (bullets, line of sight)
function segBlocked(x1, y1, x2, y2) {
  stamp++;
  for (let r = br(Math.min(y1, y2)); r <= br(Math.max(y1, y2)); r++) {
    for (let c = bc(Math.min(x1, x2)); c <= bc(Math.max(x1, x2)); c++) {
      for (const s of buckets[r * BC + c]) {
        if (s.q === stamp) {
          continue;
        }
        s.q = stamp;
        if (segHitsRect(x1, y1, x2, y2, s)) {
          return true;
        }
      }
    }
  }
  return false;
}

// ---------- Grid path finding for guards ----------
const CELL = 10;
const COLS = Math.ceil(WORLD.w / CELL);
const ROWS = Math.ceil(WORLD.h / CELL);
const GUARD_CLEARANCE = playerRadius;
const blocked = new Uint8Array(COLS * ROWS);
for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    const cx = c * CELL + CELL / 2,
      cy = r * CELL + CELL / 2;
    // a cell is blocked if a guard-sized circle placed there would touch a wall
    blocked[r * COLS + c] = solidsNear(cx, cy, GUARD_CLEARANCE).some((s) => {
      const nx = Math.max(s.x, Math.min(cx, s.x + s.w));
      const ny = Math.max(s.y, Math.min(cy, s.y + s.h));
      return Math.hypot(cx - nx, cy - ny) < GUARD_CLEARANCE;
    })
      ? 1
      : 0;
  }
}

const cellOf = (x, y) => ({
  c: Math.max(0, Math.min(COLS - 1, Math.floor(x / CELL))),
  r: Math.max(0, Math.min(ROWS - 1, Math.floor(y / CELL))),
});

function nearestFree(cell, grid = blocked) {
  if (!grid[cell.r * COLS + cell.c]) {
    return cell;
  }
  for (let rad = 1; rad < 20; rad++) {
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        const r = cell.r + dr,
          c = cell.c + dc;
        if (r >= 0 && c >= 0 && r < ROWS && c < COLS && !grid[r * COLS + c]) {
          return { c, r };
        }
      }
    }
  }
  return cell;
}

// Breadth-first search over the grid. Returns a list of world points to walk through.
function findPath(sx, sy, tx, ty, avoid = [], grid = blocked) {
  const start = nearestFree(cellOf(sx, sy), grid);
  const goal = nearestFree(cellOf(tx, ty), grid);
  const startI = start.r * COLS + start.c;
  const goalI = goal.r * COLS + goal.c;
  const avoidBlocked = (r, c) => {
    if (!avoid.length) return false;
    const x = c * CELL + CELL / 2;
    const y = r * CELL + CELL / 2;
    return avoid.some((zone) => {
      const startDistance = Math.hypot(sx - zone.x, sy - zone.y);
      return Math.hypot(x - zone.x, y - zone.y) < zone.radius &&
        (startDistance >= zone.radius ||
          Math.hypot(x - zone.x, y - zone.y) < startDistance - CELL);
    });
  };
  const prev = new Int32Array(COLS * ROWS).fill(-2);
  prev[startI] = -1;
  const queue = [startI];
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];
  for (let qi = 0; qi < queue.length && prev[goalI] === -2; qi++) {
    const cur = queue[qi];
    const cr = Math.floor(cur / COLS),
      cc = cur % COLS;
    for (const [dc, dr] of dirs) {
      const r = cr + dr,
        c = cc + dc;
      if (r < 0 || c < 0 || r >= ROWS || c >= COLS) {
        continue;
      }
      const i = r * COLS + c;
      if (prev[i] !== -2 || grid[i] || avoidBlocked(r, c)) {
        continue;
      }
      // no cutting corners diagonally
      if (dc !== 0 && dr !== 0 && (grid[cr * COLS + c] || grid[r * COLS + cc])) {
        continue;
      }
      prev[i] = cur;
      queue.push(i);
    }
  }
  if (prev[goalI] === -2) {
    return [];
  }
  const pts = [];
  for (let i = goalI; i !== -1; i = prev[i]) {
    pts.push({
      x: (i % COLS) * CELL + CELL / 2,
      y: Math.floor(i / COLS) * CELL + CELL / 2,
    });
  }
  pts.reverse();
  pts.shift(); // we are already in the first cell
  // keep every 2nd point (and the last) so guards follow smoother, shorter paths
  return pts.filter((_, i) => i % 2 === 1 || i === pts.length - 1);
}

const isFree = (x, y) => !blocked[cellOf(x, y).r * COLS + cellOf(x, y).c];

// Each match owns its altered walls, spatial index, and navigation grid.
function createWallState(initialWalls = walls) {
  let current = initialWalls.map(({ x, y, w, h }) => ({ x, y, w, h }));
  let index;
  const grid = initialWalls === walls ? new Uint8Array(blocked) : new Uint8Array(COLS * ROWS);

  function rebuildIndex() {
    index = Array.from({ length: BC * BR }, () => []);
    for (const wall of current) {
      const c0 = bc(wall.x), c1 = bc(wall.x + wall.w);
      const r0 = br(wall.y), r1 = br(wall.y + wall.h);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) index[r * BC + c].push(wall);
      }
    }
  }
  function near(x, y, radius) {
    const result = new Set();
    for (let r = br(y - radius); r <= br(y + radius); r++) {
      for (let c = bc(x - radius); c <= bc(x + radius); c++) {
        for (const wall of index[r * BC + c]) result.add(wall);
      }
    }
    return [...result];
  }
  function updateGrid(x0, y0, x1, y1) {
    const min = cellOf(x0 - GUARD_CLEARANCE - CELL, y0 - GUARD_CLEARANCE - CELL);
    const max = cellOf(x1 + GUARD_CLEARANCE + CELL, y1 + GUARD_CLEARANCE + CELL);
    for (let r = min.r; r <= max.r; r++) {
      for (let c = min.c; c <= max.c; c++) {
        const x = c * CELL + CELL / 2, y = r * CELL + CELL / 2;
        grid[r * COLS + c] = near(x, y, GUARD_CLEARANCE).some((wall) => {
          const nx = Math.max(wall.x, Math.min(x, wall.x + wall.w));
          const ny = Math.max(wall.y, Math.min(y, wall.y + wall.h));
          return Math.hypot(x - nx, y - ny) < GUARD_CLEARANCE;
        }) ? 1 : 0;
      }
    }
  }
  rebuildIndex();
  if (initialWalls !== walls) updateGrid(0, 0, WORLD.w, WORLD.h);

  return {
    solidsNear: near,
    segBlocked(x1, y1, x2, y2) {
      const candidates = new Set();
      for (let r = br(Math.min(y1, y2)); r <= br(Math.max(y1, y2)); r++) {
        for (let c = bc(Math.min(x1, x2)); c <= bc(Math.max(x1, x2)); c++) {
          for (const wall of index[r * BC + c]) candidates.add(wall);
        }
      }
      return [...candidates].some((wall) => segHitsRect(x1, y1, x2, y2, wall));
    },
    findPath(sx, sy, tx, ty, avoid = []) {
      return findPath(sx, sy, tx, ty, avoid, grid);
    },
    destroy(blast) {
      const result = carve(current, blast);
      if (!result.removed.length) return false;
      current = result.walls;
      rebuildIndex();
      updateGrid(blast.x - blast.radius, blast.y - blast.radius,
        blast.x + blast.radius, blast.y + blast.radius);
      return true;
    },
  };
}

// The part of the map sent to browsers (the artwork is loaded separately as /facility.png)
const clientMap = {
  WORLD,
  walls,
  obstacles: [],
  servers,
  doors,
  lasers,
  cameras,
  lockers,
  redSpawns,
};

module.exports = {
  WORLD,
  walls,
  obstacles,
  servers,
  serverBlocks,
  doors,
  lasers,
  cameras,
  lockers,
  redSpawns,
  routes,
  solids,
  solidsNear,
  segBlocked,
  findPath,
  isFree,
  clientMap,
  createWallState,
};
