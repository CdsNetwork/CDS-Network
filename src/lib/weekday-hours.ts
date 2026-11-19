/**
 * The clock of the shop reminders (Sarah, CDS, 2026-11-19): weekends do not count. A weekend
 * is Saturday 00:00 to Monday 00:00 in Pacific time (CDS works from California), with daylight
 * saving time handled by the time zone. Times are epoch milliseconds.
 */
const TIME_ZONE = "America/Los_Angeles";
const HOUR = 3_600_000;

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  weekday: "short",
});
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

type Parts = { y: number; m: number; d: number; h: number; mi: number; s: number; wd: number };

function parts(ms: number): Parts {
  const p: Record<string, string> = {};
  for (const x of fmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second, wd: WEEKDAY[p.weekday] };
}

/** Pacific local time minus UTC at this instant, in milliseconds (-8 or -7 hours). */
function offset(ms: number): number {
  const p = parts(ms);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - (ms - (((ms % 1000) + 1000) % 1000));
}

/** 00:00 Pacific of a calendar day (month and day may overflow, as with Date.UTC). */
function pacificMidnight(y: number, m: number, d: number): number {
  const local = Date.UTC(y, m - 1, d);
  const guess = local - offset(local);
  return local - offset(guess);
}

const isWeekend = (ms: number) => {
  const wd = parts(ms).wd;
  return wd === 0 || wd === 6;
};

/** Monday 00:00 Pacific after a weekend instant. */
function weekendEnd(ms: number): number {
  const p = parts(ms);
  return pacificMidnight(p.y, p.m, p.d + (p.wd === 6 ? 2 : 1));
}

/** The next Saturday 00:00 Pacific after a weekday instant. */
function nextWeekendStart(ms: number): number {
  const p = parts(ms);
  return pacificMidnight(p.y, p.m, p.d + (6 - p.wd));
}

/** Weekday hours between two instants (0 when the end is not after the start). */
export function weekdayHours(from: number, to: number): number {
  let total = 0;
  let cur = from;
  while (cur < to) {
    if (isWeekend(cur)) {
      cur = weekendEnd(cur);
      continue;
    }
    const boundary = nextWeekendStart(cur);
    total += Math.min(boundary, to) - cur;
    cur = boundary;
  }
  return total / HOUR;
}

/** The instant at which `hours` weekday hours have passed since `from`. */
export function addWeekdayHours(from: number, hours: number): number {
  let remaining = hours * HOUR;
  let cur = from;
  for (;;) {
    if (isWeekend(cur)) cur = weekendEnd(cur);
    const boundary = nextWeekendStart(cur);
    if (cur + remaining <= boundary) return cur + remaining;
    remaining -= boundary - cur;
    cur = boundary;
  }
}
