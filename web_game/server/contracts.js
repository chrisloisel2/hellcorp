const RISK_PENALTY = { low: 0, medium: 0.1, high: 0.2 };

function teamPower(employees) {
  const power = {};
  for (const emp of employees) {
    const stats = JSON.parse(emp.stats);
    for (const [key, value] of Object.entries(stats)) {
      power[key] = (power[key] || 0) + value;
    }
  }
  return power;
}

function powerRatio(requirements, power) {
  const keys = Object.keys(requirements);
  if (keys.length === 0) return 1;
  const ratios = keys.map((k) => (power[k] || 0) / requirements[k]);
  return ratios.reduce((a, b) => a + b, 0) / ratios.length;
}

function resolveContract(contract, employees) {
  const requirements = JSON.parse(contract.requirements);
  const power = teamPower(employees);
  const ratio = powerRatio(requirements, power);
  const cappedRatio = Math.min(ratio, 1.5);

  const riskPenalty = RISK_PENALTY[contract.risk] || 0;
  const successChance = Math.min(0.97, Math.max(0.05, 0.15 + (cappedRatio / 1.5) * 0.8 - riskPenalty));

  const success = Math.random() < successChance;
  const actualMoney = success ? Math.round(contract.reward_money * (0.85 + cappedRatio * 0.15)) : 0;
  const actualReputation = success ? contract.reward_reputation : 0;

  return { success, successChance, ratio, actualMoney, actualReputation };
}

module.exports = { resolveContract };
