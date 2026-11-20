(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.CameraVisibility = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  // Find where a ray first hits a wall or closed door.
  function rayDistance(x, y, angle, range, obstacles) {
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

  function visibilityPoints(camera, angle, obstacles) {
    const range = 380;
    const halfAngle = 0.6;
    const nearby = obstacles.filter((rect) =>
      rect.x <= camera.x + range && rect.x + rect.w >= camera.x - range &&
      rect.y <= camera.y + range && rect.y + rect.h >= camera.y - range);
    const angles = [];
    for (let i = 0; i <= 48; i++) {
      angles.push(-halfAngle + 2 * halfAngle * i / 48);
    }
    // Rays just either side of corners keep the edge of the vision cone sharp.
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
      const distance = rayDistance(camera.x, camera.y, rayAngle, range, nearby);
      return { x: camera.x + Math.cos(rayAngle) * distance, y: camera.y + Math.sin(rayAngle) * distance };
    });
  }

  function createCache() {
    let currentMap = null;
    let entries = new Map();

    return function (map, camera, state, obstacles, doorStates, wallRevision) {
      if (currentMap !== map) {
        currentMap = map;
        entries = new Map();
      }
      const cached = entries.get(state.id);
      if (cached && cached.angle === state.a && cached.doors === doorStates &&
          cached.walls === wallRevision) return cached.points;
      const points = visibilityPoints(camera, state.a, obstacles);
      entries.set(state.id, { angle: state.a, doors: doorStates, walls: wallRevision, points });
      return points;
    };
  }

  return { rayDistance, visibilityPoints, createCache };
});
