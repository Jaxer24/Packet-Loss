const C = require("./config");
const M = require("./map");
const { dist, segHitsRect } = require("./geom");

const GUARD_AVOID_RADIUS = 150;
const FLEE_DISTANCE = 350;

function expanded(rect, amount) {
  return { x: rect.x - amount, y: rect.y - amount, w: rect.w + amount * 2, h: rect.h + amount * 2 };
}

function tickRedBot(game, bot, t) {
  bot.input = { mx: 0, my: 0, ax: bot.x + 1, ay: bot.y, fire: false, use: false, dispose: false };
  if (!bot.alive) return;

  const threat = t < (bot.botFleeUntil || 0)
    ? game.guards.find((guard) => guard.id === bot.botThreat && guard.alive)
    : null;
  if (threat) {
    bot.input.ax = threat.x;
    bot.input.ay = threat.y;
    if (bot.guns.pistol > 0) bot.cur = "pistol";
    else if (bot.guns.smg > 0) bot.cur = "smg";
    bot.input.fire = bot.guns[bot.cur] > 0 && game.los(bot.x, bot.y, threat.x, threat.y);
  }

  const target = game.servers
    .filter((server) => !server.done && !server.extractor && server.lockoutUntil <= t)
    .sort((a, b) => dist(bot.x, bot.y, a.x, a.y) - dist(bot.x, bot.y, b.x, b.y))[0];
  if (!threat && !bot.extraction && target &&
      dist(bot.x, bot.y, target.x, target.y) < C.serverHackRange &&
      !game.empBlocksExtraction(bot, target) && game.availableCharges(game.redPool) > 0) {
    game.startServerExtraction(bot, target.id);
  }

  let destination = null;
  if (threat) {
    const angle = Math.atan2(bot.y - threat.y, bot.x - threat.x);
    destination = {
      x: Math.max(C.playerRadius, Math.min(M.WORLD.w - C.playerRadius, bot.x + Math.cos(angle) * FLEE_DISTANCE)),
      y: Math.max(C.playerRadius, Math.min(M.WORLD.h - C.playerRadius, bot.y + Math.sin(angle) * FLEE_DISTANCE)),
    };
  } else if (!bot.extraction && target) {
    destination = target;
  }

  if (destination) {
    const targetKey = threat ? "flee:" + threat.id : destination.id;
    if (bot.botPathTarget !== targetKey || t >= (bot.botRepathAt || 0)) {
      const avoid = game.guards.filter((guard) => guard.alive).map((guard) => ({
        x: guard.x, y: guard.y, radius: GUARD_AVOID_RADIUS,
      }));
      bot.botPath = game.findWallPath(bot.x, bot.y, destination.x, destination.y, avoid);
      if (!bot.botPath.length) bot.botPath = game.findWallPath(bot.x, bot.y, destination.x, destination.y);
      bot.botPathTarget = targetKey;
      bot.botRepathAt = t + 1;
    }
    while (bot.botPath && bot.botPath.length && dist(bot.x, bot.y, bot.botPath[0].x, bot.botPath[0].y) < 20) {
      bot.botPath.shift();
    }
    const waypoint = bot.botPath && bot.botPath[0];
    if (waypoint) {
      const angle = Math.atan2(waypoint.y - bot.y, waypoint.x - bot.x);
      bot.input.mx = Math.cos(angle);
      bot.input.my = Math.sin(angle);
    }
  } else {
    bot.botPath = [];
    bot.botPathTarget = null;
  }

  const aheadX = bot.x + bot.input.mx * (C.playerRadius + C.redSpeed * 0.1);
  const aheadY = bot.y + bot.input.my * (C.playerRadius + C.redSpeed * 0.1);
  const intersects = (rect) => segHitsRect(bot.x, bot.y, aheadX, aheadY, expanded(rect, C.playerRadius));
  const devices = [
    ...game.doors.filter((door) => game.doorClosed(door) && intersects(door)),
    ...game.cams.filter((cam) => game.camActive(cam) &&
      (game.camSees(cam, bot) || game.camSees(cam, { x: aheadX, y: aheadY }))),
    ...game.lasers.filter((laser) => game.laserActive(laser) && intersects(laser)),
  ];
  for (const device of devices) {
    if (!game.availableCharges(game.redPool)) break;
    if (game.empContainsPoint(bot.x, bot.y) || game.empIntersectsDevice(device)) continue;
    game.remoteHack(bot, device.id);
  }
}

module.exports = { tickRedBot };
