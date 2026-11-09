// Tiny geometry helpers used by the server simulation.

const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

// Smallest signed difference between two angles (radians), in [-PI, PI].
function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) {
    d -= Math.PI * 2;
  }
  while (d < -Math.PI) {
    d += Math.PI * 2;
  }
  return d;
}

// Push a circle {x,y} of radius r out of a rectangle. Returns true if it moved.
function pushOutOfRect(c, r, rect) {
  const nx = Math.max(rect.x, Math.min(c.x, rect.x + rect.w));
  const ny = Math.max(rect.y, Math.min(c.y, rect.y + rect.h));
  const dx = c.x - nx;
  const dy = c.y - ny;
  const d2 = dx * dx + dy * dy;
  if (d2 >= r * r) {
    return false;
  }
  if (d2 > 0.0001) {
    const d = Math.sqrt(d2);
    c.x = nx + (dx / d) * r;
    c.y = ny + (dy / d) * r;
  } else {
    // Circle centre is inside the rectangle: leave through the nearest side.
    const l = c.x - rect.x,
      rr = rect.x + rect.w - c.x;
    const t = c.y - rect.y,
      b = rect.y + rect.h - c.y;
    const m = Math.min(l, rr, t, b);
    if (m === l) {
      c.x = rect.x - r;
    } else if (m === rr) {
      c.x = rect.x + rect.w + r;
    } else if (m === t) {
      c.y = rect.y - r;
    } else {
      c.y = rect.y + rect.h + r;
    }
  }
  return true;
}

// Does the segment (x1,y1)-(x2,y2) touch the rectangle? (Liang-Barsky clipping)
function segHitsRect(x1, y1, x2, y2, rect) {
  let t0 = 0,
    t1 = 1;
  const dx = x2 - x1,
    dy = y2 - y1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - rect.x, rect.x + rect.w - x1, y1 - rect.y, rect.y + rect.h - y1];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) {
        return false;
      }
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) {
          return false;
        }
        if (t > t0) {
          t0 = t;
        }
      } else {
        if (t < t0) {
          return false;
        }
        if (t < t1) {
          t1 = t;
        }
      }
    }
  }
  return true;
}

function distPointToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1,
    dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

module.exports = { dist, angleDiff, pushOutOfRect, segHitsRect, distPointToSegment };
