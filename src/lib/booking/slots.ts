// Pure slot generation for booking (Phase 4.3). No DB and no imports, so it
// can be unit-tested across timezones and DST changes (slots.test.ts).
//
// Availability windows are local wall-clock times in an IANA timezone. Each
// candidate start is converted from local time to a UTC instant; a slot's
// length is real elapsed minutes, so a session never silently stretches or
// shrinks across a DST change. Local start times that don't exist (skipped by
// spring-forward) are never offered; ambiguous fall-back times use the earlier
// instant.

export type SlotSessionType = {
  id: string;
  duration_minutes: number;
  min_notice_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  max_bookings_per_day: number | null;
};

export type SlotWindow = {
  weekday: number; // 0 = Sunday
  start_time: string; // "HH:MM" or "HH:MM:SS", local to `timezone`
  end_time: string;
  timezone: string;
  session_type_id: string | null; // null = applies to every type
};

// An existing booking or busy calendar interval. Every interval blocks
// overlapping slots; session_type_id is only used for the per-day spot limit.
export type BusyInterval = {
  start: Date;
  end: Date;
  session_type_id?: string | null;
};

export type Slot = { start: Date; end: Date };

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

// The wall-clock reading of a UTC instant in `timeZone`, expressed as if that
// reading were itself UTC. (local - instant) is the zone's offset.
function wallClock(ms: number, timeZone: string): number {
  const p: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

function offsetAt(ms: number, timeZone: string): number {
  return wallClock(ms, timeZone) - (ms - (((ms % 1000) + 1000) % 1000));
}

// Resolve a local wall-clock time (encoded as if UTC) to real instants.
// `exact` is the earliest instant that actually reads as that wall-clock time,
// or null if the time was skipped by a DST change. `earliest` is the earliest
// candidate either way (a conservative stand-in for a skipped time).
function resolveLocal(local: number, timeZone: string): { exact: number | null; earliest: number } {
  const candidates = [
    local - offsetAt(local - DAY, timeZone),
    local - offsetAt(local + DAY, timeZone),
  ];
  const exact = candidates.filter((t) => wallClock(t, timeZone) === local);
  return {
    exact: exact.length > 0 ? Math.min(...exact) : null,
    earliest: Math.min(...candidates),
  };
}

// Calendar date (as a UTC-midnight key) of an instant in `timeZone`.
function localDateKey(ms: number, timeZone: string): number {
  const local = wallClock(ms, timeZone);
  return local - (((local % DAY) + DAY) % DAY);
}

export function parseTimeOfDay(value: string): number {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid time "${value}"`);
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (Number(match[2]) > 59 || minutes > 24 * 60) throw new Error(`Invalid time "${value}"`);
  return minutes;
}

// The real instant for a wall-clock date ("YYYY-MM-DD") and time ("HH:MM") in
// `timeZone`, for a time David types in by hand. Null if the input is
// malformed or the time doesn't exist (skipped by a spring-forward change).
// An ambiguous fall-back time resolves to the earlier instant, the same rule
// the slot generator uses.
export function zonedTimeToInstant(date: string, time: string, timeZone: string): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!d || !isValidTimeZone(timeZone)) return null;
  const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  let minutes: number;
  try {
    minutes = parseTimeOfDay(time);
  } catch {
    return null;
  }
  if (minutes >= 24 * 60) return null;
  const local = Date.UTC(y, m - 1, day, 0, minutes);
  // Rejects dates like 2026-02-31, which Date.UTC would roll over.
  const check = new Date(local);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== day) return null;
  const { exact } = resolveLocal(local, timeZone);
  return exact === null ? null : new Date(exact);
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

// Bookable slot starts in [range.start, range.end), sorted, as UTC instants.
// Candidate starts step through each window every `stepMinutes` of local time
// (default: the session's duration, i.e. back-to-back sessions).
export function generateSlots(
  sessionType: SlotSessionType,
  windows: SlotWindow[],
  busy: BusyInterval[],
  range: { start: Date; end: Date },
  now: Date,
  stepMinutes: number = sessionType.duration_minutes,
): Slot[] {
  if (!Number.isInteger(stepMinutes) || stepMinutes <= 0) throw new Error("stepMinutes must be a positive integer");

  const durationMin = sessionType.duration_minutes;
  const duration = durationMin * MINUTE;
  const bufferBefore = sessionType.buffer_before_minutes * MINUTE;
  const bufferAfter = sessionType.buffer_after_minutes * MINUTE;
  const earliestStart = now.getTime() + sessionType.min_notice_minutes * MINUTE;
  const rangeStart = range.start.getTime();
  const rangeEnd = range.end.getTime();
  const busyMs = busy.map((b) => ({
    start: b.start.getTime(),
    end: b.end.getTime(),
    sameType: b.session_type_id === sessionType.id,
  }));

  const found = new Map<number, Slot>();

  for (const w of windows) {
    if (w.session_type_id !== null && w.session_type_id !== sessionType.id) continue;
    const startMin = parseTimeOfDay(w.start_time);
    const endMin = parseTimeOfDay(w.end_time);
    const tz = w.timezone;

    // Per-day spot limit counts this type's bookings on each local date.
    const bookedPerDay = new Map<number, number>();
    if (sessionType.max_bookings_per_day !== null) {
      for (const b of busyMs) {
        if (!b.sameType) continue;
        const key = localDateKey(b.start, tz);
        bookedPerDay.set(key, (bookedPerDay.get(key) ?? 0) + 1);
      }
    }

    // Walk local dates covering the range, padded a day each side.
    const lastDay = localDateKey(rangeEnd + DAY, tz);
    for (let day = localDateKey(rangeStart - DAY, tz); day <= lastDay; day += DAY) {
      if (new Date(day).getUTCDay() !== w.weekday) continue;
      if (
        sessionType.max_bookings_per_day !== null &&
        (bookedPerDay.get(day) ?? 0) >= sessionType.max_bookings_per_day
      ) {
        continue;
      }

      const windowEnd = resolveLocal(day + endMin * MINUTE, tz);
      const windowEndMs = windowEnd.exact ?? windowEnd.earliest;

      for (let m = startMin; m + durationMin <= endMin; m += stepMinutes) {
        const start = resolveLocal(day + m * MINUTE, tz).exact;
        if (start === null) continue;
        const end = start + duration;
        if (end > windowEndMs) continue;
        if (start < rangeStart || start >= rangeEnd || start < earliestStart) continue;
        if (busyMs.some((b) => b.start < end + bufferAfter && b.end > start - bufferBefore)) continue;
        found.set(start, { start: new Date(start), end: new Date(end) });
      }
    }
  }

  return [...found.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
}
