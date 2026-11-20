const C = require("./config");

const SMG_PATTERN = [
  0, 0.025, 0.06, 0.105, 0.15, 0.195,
  0.225, 0.25, 0.235, 0.2, 0.16, 0.11,
  0.055, 0, -0.055, -0.11, -0.165, -0.215,
  -0.245, -0.22, -0.17, -0.105, -0.04, 0.025,
];

// Keep recoil on the entity so a pause or weapon switch can reset its pattern.
function weaponRecoil(entity, weapon, time) {
  const reset = weapon === "smg" ? C.smgRecoilResetSeconds : C.pistolRecoilResetSeconds;
  if (entity.recoilWeapon !== weapon || time >= (entity.recoilResetAt || 0)) {
    entity.recoilWeapon = weapon;
    entity.recoilShots = 0;
  }
  const shot = entity.recoilShots++;
  entity.recoilResetAt = time + reset;
  const moving = entity.input && Math.hypot(entity.input.mx, entity.input.my) > 0;
  const running = moving && entity.input.run;

  if (weapon === "smg") {
    const pattern = SMG_PATTERN[Math.min(shot, SMG_PATTERN.length - 1)];
    const spread = running ? C.smgRunningSpread : moving ? C.smgMovingSpread : 0;
    return pattern + (Math.random() - 0.5) * spread * 2;
  }
  const bloom = Math.min(0.28, Math.max(0, shot - 0.25) * C.pistolBloomPerShot);
  const spread = bloom + (running ? C.pistolRunningSpread : moving ? C.pistolMovingSpread : 0);
  return (Math.random() - 0.5) * spread * 2;
}

module.exports = { weaponRecoil };
