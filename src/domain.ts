import { createHash } from "node:crypto";

export type Temporal = Date | string;

export interface SourceEvent {
  key: string;
  uid: string;
  summary: string;
  start: Temporal;
  end: Temporal;
  allDay: boolean;
  location: string;
  description: string;
  status: string;
  busy: boolean;
}

export interface SyncOptions {
  copyDescription: boolean;
  copyLocation: boolean;
  visibility: string;
  summaryPrefix: string;
}

export interface ManagedGoogleEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  visibility?: string;
  transparency?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  extendedProperties?: { private?: Record<string, string> };
}

export interface GoogleEventBody {
  summary: string;
  description?: string;
  location?: string;
  visibility: string;
  transparency: "opaque";
  start: { date: string } | { dateTime: string };
  end: { date: string } | { dateTime: string };
  extendedProperties: { private: Record<string, string> };
}

export const managedProperty = "calendar_sync_managed";
export const eventProperty = "calendar_sync_event";
export const fingerprintProperty = "calendar_sync_fingerprint";

export function sourceKey(uid: string, start: Temporal, recurring: boolean, recurrenceId?: Temporal, timezone = "UTC"): string {
  if (!recurring) return `${uid}|single`;
  return `${uid}|${temporalKey(recurrenceId ?? start, timezone)}`;
}

export function temporalKey(value: Temporal, timezone = "UTC"): string {
  return typeof value === "string" ? value : formatInTimeZone(value, timezone);
}

export function legacyFingerprint(event: SourceEvent): string {
  return [event.uid, event.key, event.summary, temporalKey(event.start), temporalKey(event.end), event.allDay, event.location, event.description, event.status].join("|");
}

function formatInTimeZone(value: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" }).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const rawOffset = values.timeZoneName === "GMT" ? "+00:00" : values.timeZoneName.replace("GMT", "");
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}${rawOffset}`;
}

export function fingerprint(event: SourceEvent): string {
  return createHash("sha256").update(legacyFingerprint(event)).digest("hex");
}

export function googleBody(event: SourceEvent, options: SyncOptions): GoogleEventBody {
  const body: GoogleEventBody = {
    summary: `${options.summaryPrefix}${event.summary}`,
    visibility: options.visibility,
    transparency: "opaque",
    start: event.allDay ? { date: temporalDate(event.start) } : { dateTime: temporalDateTime(event.start) },
    end: event.allDay ? { date: temporalDate(event.end) } : { dateTime: temporalDateTime(event.end) },
    extendedProperties: {
      private: {
        [managedProperty]: "true",
        calendar_sync_source: "ics",
        [eventProperty]: event.key,
        calendar_sync_uid: event.uid,
        [fingerprintProperty]: fingerprint(event)
      }
    }
  };
  if (options.copyDescription && event.description) body.description = event.description;
  if (options.copyLocation && event.location) body.location = event.location;
  return body;
}

export function temporalDate(value: Temporal): string {
  return typeof value === "string" ? value : value.toISOString().slice(0, 10);
}

export function temporalDateTime(value: Temporal): string {
  if (typeof value === "string") throw new Error("Timed events require a Date");
  return value.toISOString();
}

export function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
}

export function temporalMatches(actual: ManagedGoogleEvent["start"], expected: { date: string } | { dateTime: string }): boolean {
  if ("date" in expected) return actual?.date === expected.date;
  if (!actual?.dateTime) return false;
  return Date.parse(actual.dateTime) === Date.parse(expected.dateTime);
}

export function visibleFieldsMatch(actual: ManagedGoogleEvent, event: SourceEvent, options: SyncOptions): boolean {
  const expected = googleBody(event, options);
  if (actual.summary !== expected.summary) return false;
  if (actual.visibility !== expected.visibility) return false;
  if (actual.transparency !== undefined && actual.transparency !== expected.transparency) return false;
  if (options.copyLocation && normalizeText(actual.location ?? "") !== normalizeText(expected.location ?? "")) return false;
  if (options.copyDescription && normalizeText(actual.description ?? "") !== normalizeText(expected.description ?? "")) return false;
  return temporalMatches(actual.start, expected.start) && temporalMatches(actual.end, expected.end);
}
