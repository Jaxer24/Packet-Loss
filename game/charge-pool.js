// Each spent charge has a time when it becomes available again.
// Charges recharge one after another, not all at the same time.
function availableCharges(pool, time) {
  pool.cds = pool.cds.filter((readyAt) => readyAt > time);
  return pool.max - pool.cds.length;
}

function useCharge(pool, seconds, time) {
  if (availableCharges(pool, time) <= 0) return false;

  const previousReady = pool.cds.length ? Math.max(...pool.cds) : time;
  pool.cds.push(Math.max(time, previousReady) + seconds);
  return true;
}

function chargeStatus(pool, time) {
  const available = availableCharges(pool, time);
  const recharge = pool.recharge || 1;
  const cooldowns = pool.cds.slice().sort((a, b) => a - b);
  const progress = cooldowns.map((readyAt, index) => {
    const startedAt = index === 0 ? readyAt - recharge : cooldowns[index - 1];
    return Math.max(0, Math.min(1, (time - startedAt) / recharge));
  });

  // These short field names are used by the client snapshot.
  return {
    a: available,
    m: pool.max,
    n: cooldowns.length ? Math.ceil(cooldowns[0] - time) : 0,
    p: [...Array(available).fill(1), ...progress],
  };
}

function teamChargePool(baseCharges, teamSize, multiplier, recharge) {
  const extraPlayers = Math.max(1, teamSize) - 1;
  const max = Math.max(1, Math.round(baseCharges * (1 + multiplier * extraPlayers)));
  return { max, cds: [], recharge };
}

module.exports = { availableCharges, useCharge, chargeStatus, teamChargePool };
