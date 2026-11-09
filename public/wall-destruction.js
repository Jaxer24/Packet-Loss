(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.WallDestruction = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function subtractRect(wall, cut, removed) {
    const x0 = Math.max(wall.x, cut.x);
    const y0 = Math.max(wall.y, cut.y);
    const x1 = Math.min(wall.x + wall.w, cut.x + cut.w);
    const y1 = Math.min(wall.y + wall.h, cut.y + cut.h);
    if (x0 >= x1 || y0 >= y1) return [wall];
    if (removed) removed.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    const result = [];
    if (y0 > wall.y) result.push({ x: wall.x, y: wall.y, w: wall.w, h: y0 - wall.y });
    if (y1 < wall.y + wall.h) result.push({ x: wall.x, y: y1, w: wall.w, h: wall.y + wall.h - y1 });
    if (x0 > wall.x) result.push({ x: wall.x, y: y0, w: x0 - wall.x, h: y1 - y0 });
    if (x1 < wall.x + wall.w) result.push({ x: x1, y: y0, w: wall.x + wall.w - x1, h: y1 - y0 });
    return result;
  }

  // Two-pixel bands approximate the circle from the inside; they never erase outside the blast.
  function carve(walls, blast) {
    const removed = [];
    let remaining = walls;
    for (let y = blast.y - blast.radius; y < blast.y + blast.radius; y += 2) {
      const bottom = Math.min(y + 2, blast.y + blast.radius);
      const edge = Math.max(Math.abs(y - blast.y), Math.abs(bottom - blast.y));
      const halfWidth = Math.sqrt(Math.max(0, blast.radius * blast.radius - edge * edge));
      if (!halfWidth) continue;
      const cut = { x: blast.x - halfWidth, y, w: 2 * halfWidth, h: bottom - y };
      remaining = remaining.flatMap((wall) => subtractRect(wall, cut, removed));
    }
    return { walls: remaining, removed };
  }
  return { carve };
});
