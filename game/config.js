// All tunable numbers live here (GDD section 14). Change a value, restart, done.
module.exports = {
  tickRate: 30,
  matchSeconds: 900,

  // Guards: how many exist depending on the number of Red players (GDD: 1 Red = 5, 2 Red = 8)
  guardCountByRedPlayers: { 0: 5, 1: 5, 2: 8, 3: 8 },
  guardRouteShiftSeconds: 300,
  guardLostSightSeconds: 20,
  guardInvestigationSeconds: 10,
  guardRespawnSeconds: 20,
  guardHp: 6,
  guardPatrolSpeed: 350,
  guardChaseSpeed: 450,
  guardFovDegrees: 100,
  guardSightRange: 420,

  // Red team
  playerRadius: 12,
  redHp: 10,
  redMaxArmor: 10,
  redSpeed: 400,
  respawnMaxSeconds: 30,
  serverHackSeconds: 20,
  serverChallengeEntrySeconds: 10,
  serverHackRange: 95,
  serverCounterLockoutSeconds: 5,
  serverCounterCooldownSeconds: 20,
  remoteHackCharges: 3, // for a one-player team
  remoteHackRechargeSeconds: 60, // each charge recharges on its own timer
  cameraHackSeconds: 45, // unused: camera hacks now last until Blue restores them
  doorHackSeconds: 120, // unused: doors now remain open until Blue closes them
  laserHackSeconds: 60, // unused: laser hacks now last until Blue restores them
  corpseDisposeSeconds: 3,
  corpseDoorMalfunctionAlertSeconds: 30, // unused: corpses no longer affect doors
  lockerRestockSeconds: 120,

  // Blue team
  blueSecurityCharges: 2,
  blueSecurityRechargeSeconds: 60,
  blueSecurityActivationSeconds: 120, // unused: lasers are active until hacked
  possessionCooldownSeconds: 0,
  possessedSpeed: 400,
  possessedRedTrackingSeconds: 10,
  lightsBlackoutSeconds: 60,
  lightsCooldownSeconds: 120,
  gunshotMarkerSeconds: 10,
  counterhackSeconds: 5,
  minigameEntrySeconds: 10,
  alertRange: 3000,
  alertSeconds: 10,
  alertCooldownSeconds: 30,
  empRadius: 500,
  empSeconds: 10,
  empCooldownSeconds: 100,

  // Extra charges when a team has more than one player: charges * (1 + mult * (players - 1))
  teamChargeMultiplier: 0.5,

  // Combat
  pistolAmmo: 300,
  smgAmmo: 200,
  maxGrenades: 5,
  pistolDamage: 2,
  smgDamage: 1,
  knifeDamage: 8,
  grenadeDamage: 8,
  grenadeRadius: 90,
  laserDamage: 2,
  bulletSpeed: 600,

  // Vision (pixels)
  visionRadiusLit: 650,
  visionRadiusDark: 90,
  visionConeRange: 420,
  visionConeDegrees: 70,
};
