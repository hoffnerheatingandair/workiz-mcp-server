// Converts ISO 8601 datetimes into Workiz's expected job-time format:
// "YYYY-MM-DD HH:MM:SS" (space separator, no "T", no timezone offset).
//
// Workiz stores job times as wall-clock time in the account's business
// timezone, not UTC, so we can't just chop the offset off the ISO string --
// we have to actually convert into that timezone. Defaults to
// America/New_York (this account's timezone, per GHL's get-location), but
// can be overridden via WORKIZ_TIMEZONE.
const DEFAULT_TIMEZONE = process.env.WORKIZ_TIMEZONE || "America/New_York";

function formatInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  // Some ICU versions render midnight as hour "24" under hour12: false.
  const hour = get("hour") === "24" ? "00" : get("hour");

  return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}:${get("second")}`;
}

// Converts a single ISO 8601 datetime string to "YYYY-MM-DD HH:MM:SS" in the
// given (or default) timezone. Returns null for missing/invalid input.
export function toWorkizDateTime(iso, timeZone = DEFAULT_TIMEZONE) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return formatInTimeZone(d, timeZone);
}

// Converts an ISO 8601 start time, plus either an explicit ISO end time or a
// duration in minutes, into Workiz-formatted { start, end } strings.
export function toWorkizDateRange(isoStart, { isoEnd, durationMinutes, timeZone = DEFAULT_TIMEZONE } = {}) {
  const start = toWorkizDateTime(isoStart, timeZone);

  if (isoEnd) {
    return { start, end: toWorkizDateTime(isoEnd, timeZone) };
  }

  if (durationMinutes != null && isoStart) {
    const startMs = new Date(isoStart).getTime();
    if (!Number.isNaN(startMs)) {
      const endIso = new Date(startMs + durationMinutes * 60000).toISOString();
      return { start, end: toWorkizDateTime(endIso, timeZone) };
    }
  }

  return { start, end: null };
}

// Converts a Workiz-format "YYYY-MM-DD HH:MM:SS" string -- wall-clock time
// in the given (or default) timezone -- into a UTC ISO 8601 string, for
// sending to GHL. This is the inverse of toWorkizDateTime, using the same
// Intl-based (DST-aware) approach rather than a hardcoded offset.
//
// Method: guess the instant by treating the wall-clock numbers as UTC, see
// what that guess looks like when formatted back into the target timezone,
// and correct by the difference. This converges in one step outside of the
// ~1hr DST transition window itself (2am-3am on two days a year), which is
// an accepted edge case for job scheduling.
export function fromWorkizDateTime(workizStr, timeZone = DEFAULT_TIMEZONE) {
  if (!workizStr) return null;
  const match = String(workizStr)
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [y, mo, d, h, mi, s] = match.slice(1).map(Number);

  const guessMs = Date.UTC(y, mo - 1, d, h, mi, s);
  const seenMs = parseAsUtcMs(formatInTimeZone(new Date(guessMs), timeZone));
  const correctedMs = guessMs + (guessMs - seenMs);

  return new Date(correctedMs).toISOString();
}

function parseAsUtcMs(workizFormatted) {
  const [datePart, timePart] = workizFormatted.split(" ");
  const [y, mo, d] = datePart.split("-").map(Number);
  const [h, mi, s] = timePart.split(":").map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s);
}
