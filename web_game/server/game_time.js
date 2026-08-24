// Lazy game clock, same pattern as relationships.js's applyDecay: no ticking timer, just
// compute how much game-time has elapsed since the last read/write and fold it in on access.
function currentTime(db) {
  const row = db.prepare("SELECT game_hour, game_day, time_scale_seconds_per_hour, time_paused, time_last_tick_at FROM game_state WHERE id = 1").get();
  const now = new Date();

  if (!row.time_last_tick_at) {
    db.prepare("UPDATE game_state SET time_last_tick_at = ? WHERE id = 1").run(now.toISOString());
    return { hour: row.game_hour, day: row.game_day };
  }

  if (row.time_paused) return { hour: row.game_hour, day: row.game_day };

  const elapsedSeconds = (now.getTime() - new Date(row.time_last_tick_at).getTime()) / 1000;
  const elapsedHours = elapsedSeconds / row.time_scale_seconds_per_hour;

  let hour = row.game_hour + elapsedHours;
  let day = row.game_day;
  while (hour >= 24) {
    hour -= 24;
    day += 1;
  }

  db.prepare("UPDATE game_state SET game_hour = ?, game_day = ?, time_last_tick_at = ? WHERE id = 1").run(hour, day, now.toISOString());
  return { hour, day };
}

function fullState(db) {
  const { hour, day } = currentTime(db);
  const row = db.prepare("SELECT time_scale_seconds_per_hour, time_paused FROM game_state WHERE id = 1").get();
  return { hour, day, time_scale_seconds_per_hour: row.time_scale_seconds_per_hour, paused: !!row.time_paused };
}

function setTime(db, { hour, day, time_scale_seconds_per_hour, paused }) {
  currentTime(db); // fold in elapsed time under the OLD settings before applying overrides

  const updates = {};
  if (hour != null) updates.game_hour = Math.max(0, Math.min(24, hour));
  if (day != null) updates.game_day = Math.max(1, Math.round(day));
  if (time_scale_seconds_per_hour != null) updates.time_scale_seconds_per_hour = Math.max(1, time_scale_seconds_per_hour);
  if (paused != null) updates.time_paused = paused ? 1 : 0;

  const keys = Object.keys(updates);
  if (keys.length > 0) {
    db.prepare(`UPDATE game_state SET ${keys.map((k) => `${k} = @${k}`).join(", ")}, time_last_tick_at = @now WHERE id = 1`).run({
      ...updates,
      now: new Date().toISOString(),
    });
  }

  return fullState(db);
}

// Ranges can wrap past midnight (e.g. 22 -> 6 for an overnight sleep block).
function hourInRange(hour, start, end) {
  if (start <= end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

module.exports = { currentTime, fullState, setTime, hourInRange };
