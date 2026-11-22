// Appointments (aftaler) from the Aftaler app on Min Side, shaped for an AI and
// for a calendar: one flat object per appointment, times as RFC 3339 with the
// Danish offset. The field names read are the ones the Aftaler page itself uses
// (sdk.app.aftaler.js): documentId, title, appointmentType, startTime, endTime,
// endTimeNotDefined, location, performer, anvendGentagneAftaler,
// vejledendeIntervalText, forloebText.
import { clean } from "./data.ts";

const ZONE = "Europe/Copenhagen";
const PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function wallClock(ms: number) {
  const p = Object.fromEntries(PARTS.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

/** Minutes Copenhagen is ahead of UTC at this instant: 60 in winter, 120 in summer. */
function offsetAt(ms: number): number {
  const w = wallClock(ms);
  return Math.round((Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000) / 60_000);
}

const TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * The instant a sundhed.dk time stands for, in ms. A time with Z or an offset
 * is taken as it is; one without is Danish wall-clock time.
 */
export function instantOf(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const m = TIME.exec(value.trim());
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s = "0", frac = "", zone] = m;
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, Math.round(Number(`0${frac || ".0"}`) * 1000));
  if (zone) {
    if (/^z$/i.test(zone)) return wall;
    const sign = zone.startsWith("-") ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    return wall - sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60_000;
  }
  // Twice, so a time near a daylight saving change gets the offset of its own side.
  const guess = wall - offsetAt(wall) * 60_000;
  return wall - offsetAt(guess) * 60_000;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** An instant as RFC 3339 in Danish time, e.g. 2026-12-01T09:30:00+01:00. */
export function copenhagenTime(ms: number): string {
  const w = wallClock(ms);
  const off = offsetAt(ms);
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** The start (or the last millisecond) of a YYYY-MM-DD day in Danish time. */
export function copenhagenDay(day: string, end = false): Date {
  const ms = instantOf(`${day}T${end ? "23:59:59.999" : "00:00:00"}`);
  if (ms === undefined) throw new Error(`Not a date: ${JSON.stringify(day.slice(0, 20))}`);
  return new Date(ms);
}

export interface Place {
  organisation?: string;
  ward?: string;
  unitType?: string;
  sorId?: string;
  phone?: string;
  address?: string;
}

export interface Appointment {
  /** sundhed.dk's documentId. */
  id?: string;
  title?: string;
  /** Kommune, Hospital, Laege og Speciallaege or Ukendt: what the Aftaler page filters by. */
  type?: string;
  start: string;
  /** Missing when sundhed.dk has no end time (endTimeKnown false). */
  end?: string;
  endTimeKnown: boolean;
  /** Where it takes place. */
  location?: Place;
  /** Who is responsible for it (performer). */
  provider?: Place;
  /** The appointment repeats (anvendGentagneAftaler). */
  repeating?: boolean;
  /** Guidance about the time, e.g. that it is only approximate (vejledendeIntervalText). */
  timeNote?: string;
  /** The course of treatment it belongs to (forloebText). */
  course?: string;
}

export interface AppointmentList {
  appointments: Appointment[];
  /** A message sundhed.dk showed with the list (errorText), e.g. that a source did not answer. */
  notice?: string;
  /** Some appointments are hidden because of the person's own consent settings (consentFilterApplied). */
  hiddenByConsent?: boolean;
}

const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : undefined);

function address(a: unknown): string | undefined {
  if (typeof a === "string") return a;
  if (!a || typeof a !== "object") return undefined;
  const r = a as Record<string, unknown>;
  if (str(r.formatted)) return str(r.formatted);
  const town = [str(r.postalCode), str(r.city)].filter(Boolean).join(" ");
  return [str(r.street), town].filter(Boolean).join(", ") || undefined;
}

function place(p: unknown): Place | undefined {
  if (!p || typeof p !== "object") return undefined;
  const r = p as Record<string, unknown>;
  return {
    organisation: str(r.organisation),
    ward: str(r.ward),
    unitType: str(r.unitType),
    sorId: str(r.sorId),
    phone: str(r.phone),
    address: address(r.address),
  };
}

/** One appointment as the Aftaler API returns it, or undefined when it has no start time. */
export function appointmentFrom(raw: unknown): Appointment | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const start = instantOf(r.startTime);
  if (start === undefined) return undefined;
  const endMs = r.endTimeNotDefined === true ? undefined : instantOf(r.endTime);
  const out: Appointment = {
    id: str(r.documentId),
    title: str(r.title),
    type: str(r.appointmentType),
    start: copenhagenTime(start),
    end: endMs === undefined ? undefined : copenhagenTime(endMs),
    endTimeKnown: endMs !== undefined,
    location: place(r.location),
    provider: place(r.performer),
    repeating: typeof r.anvendGentagneAftaler === "boolean" ? r.anvendGentagneAftaler : undefined,
    timeNote: str(r.vejledendeIntervalText),
    course: str(r.forloebText),
  };
  // Drops what is empty, decodes the HTML entities in titles and masks CPR numbers.
  return clean(out) as Appointment;
}

/** The Aftaler API's answer (`{ appointments, errorText, consentFilterApplied }`), oldest first. */
export function appointmentsFrom(raw: unknown): AppointmentList {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(r.appointments) ? r.appointments : [];
  const appointments = list.map(appointmentFrom).filter((a): a is Appointment => a !== undefined);
  const out: AppointmentList = { appointments: sortAppointments(appointments) };
  const notice = clean(r.errorText);
  if (typeof notice === "string") out.notice = notice;
  if (r.consentFilterApplied === true) out.hiddenByConsent = true;
  return out;
}

export function sortAppointments(list: Appointment[]): Appointment[] {
  return [...list].sort((a, b) => (instantOf(a.start) ?? 0) - (instantOf(b.start) ?? 0) || (a.id ?? "").localeCompare(b.id ?? ""));
}

/** Two lists in one, each appointment once (by id, or by start and title when it has none). */
export function mergeAppointments(lists: AppointmentList[]): AppointmentList {
  const seen = new Map<string, Appointment>();
  for (const l of lists) for (const a of l.appointments) seen.set(a.id ?? `${a.start} ${a.title ?? ""}`, a);
  const out: AppointmentList = { appointments: sortAppointments([...seen.values()]) };
  const notices = [...new Set(lists.map((l) => l.notice).filter((n): n is string => !!n))];
  if (notices.length) out.notice = notices.join(" ");
  if (lists.some((l) => l.hiddenByConsent)) out.hiddenByConsent = true;
  return out;
}

export type AppointmentStatus = "upcoming" | "ongoing" | "past";

/**
 * Whether an appointment is ahead, under way or over, at `now`. sundhed.dk
 * gives no status of its own; this is worked out from the times. Without an
 * end time an appointment counts as lasting an hour, as the Aftaler page does.
 */
export function appointmentStatus(a: Pick<Appointment, "start" | "end">, now = Date.now()): AppointmentStatus {
  const start = instantOf(a.start) ?? 0;
  const end = instantOf(a.end) ?? start + 60 * 60_000;
  if (start > now) return "upcoming";
  return end > now ? "ongoing" : "past";
}

/** Only the appointments that overlap [from, to]. */
export function appointmentsBetween(list: Appointment[], from: Date, to: Date): Appointment[] {
  return list.filter((a) => {
    const start = instantOf(a.start) ?? 0;
    const end = instantOf(a.end) ?? start;
    return end >= from.getTime() && start <= to.getTime();
  });
}
