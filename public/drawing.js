(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.Drawing = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  // The configuration arrives with the match, after the canvas is created.
  function create(ctx, getConfig) {
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

    function body(x, y, angle, fill, ring) {
      const radius = getConfig().playerRadius;
      circle(x, y, radius, fill, ring, 3);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(angle) * radius * 1.5, y + Math.sin(angle) * radius * 1.5);
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
        ctx.fillRect(x - 17, y - 24, 34 * Math.min(1, armor / getConfig().maxArmor), 3);
      }
    }

    function text(message, x, y, color, size) {
      ctx.fillStyle = color || "#fff";
      ctx.font = (size || 14) + "px Consolas, monospace";
      ctx.textAlign = "center";
      ctx.fillText(message, x, y);
    }

    return { circle, body, healthBar, text };
  }

  return { create };
});
