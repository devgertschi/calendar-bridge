import IcalExpander from "ical-expander";
import type { SourceEvent, Temporal } from "./domain.js";
import { sourceKey } from "./domain.js";

export interface IcsOptions {
  timezone: string;
  lookaheadDays: number;
  onlyBusy: boolean;
}

export interface IcsRange {
  start: Date;
  end: Date;
}

export async function fetchIcs(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`ICS request failed: ${response.status} ${response.statusText}`);
  return response.text();
}

export function assertSourceIsSafe(events: SourceEvent[], allowEmptySource: boolean): void {
  if (events.length === 0 && !allowEmptySource) {
    throw new Error("Source calendar produced no events; refusing to reconcile or delete managed events. Set sync.allowEmptySource=true to allow this.");
  }
}

export function parseIcs(input: string, options: IcsOptions, now = new Date(), range?: IcsRange): SourceEvent[] {
  const start = range?.start ?? now;
  const end = range?.end ?? new Date(now.getTime() + options.lookaheadDays * 24 * 60 * 60 * 1000);
  const expander = new IcalExpander({ ics: input, maxIterations: 10_000 });
  const expanded = expander.between(start, end);
  const events: SourceEvent[] = [];
  const allEvents = (expander as unknown as { events: any[] }).events;
  
  const rawExceptions = allEvents
    .filter((item) => item.recurrenceId)
    .filter((item) => {
      const itemStart = item.startDate?.toJSDate?.() as Date | undefined;
      const itemEnd = item.endDate?.toJSDate?.() as Date | undefined;
      return Boolean(itemStart && itemEnd && itemEnd >= start && itemStart <= end);
    });
  const entries = [
    ...expanded.events.map((item) => ({ item, occurrence: undefined })),
    ...expanded.occurrences.map((occurrence) => ({ item: occurrence.item, occurrence })),
    // ical-expander can omit an exception when its parent series does not
    // itself emit an occurrence in the requested range. Include raw exception
    // components so moved occurrences remain mirrorable.
    ...rawExceptions.map((item) => ({ item, occurrence: undefined }))
  ];
  for (const entry of entries) {
    const event = entry.item as unknown as Record<string, unknown>;
    const item = entry.item as any;
    const occurrence = entry.occurrence as any;
    const uid = text(item.uid);
    const startValue = temporal(occurrence?.startDate ?? item.startDate);
    const endValue = temporal(occurrence?.endDate ?? item.endDate);
    if (!uid || !startValue || !endValue) continue;
    const allDay = Boolean((occurrence?.startDate ?? item.startDate).isDate);
    const recurrenceId = temporal(occurrence?.recurrenceId ?? item.recurrenceId ?? propertyValue(item, "recurrence-id"));
    // Use occurrence-start identity for every expanded item, including
    // one-off events returned by the expander.
    const recurring = true;
    const source: SourceEvent = {
      key: sourceKey(uid, startValue, recurring, recurrenceId, options.timezone),
      uid,
      summary: text(item.summary) || "(untitled)",
      start: allDay ? dateOnly(startValue) : asDate(startValue),
      end: allDay ? dateOnly(endValue) : asDate(endValue),
      allDay,
      location: text(item.location),
      description: text(item.description),
      status: text(propertyValue(item, "status")).toUpperCase() || "CONFIRMED",
      busy: isBusy(event)
    };
    if (source.status !== "CANCELLED" && (!options.onlyBusy || source.busy)) events.push(source);
  }

  const unique = new Map(events.map((event) => [event.key, event]));
  return [...unique.values()].sort((a, b) => temporalSort(a.start, b.start));
}

export function previousDaysRange(days: number, now: Date, timezone: string): IcsRange {
  if (!Number.isInteger(days) || days <= 0) throw new Error("Backfill days must be a positive integer");
  const today = localDate(now, timezone);
  const end = localMidnight(today, timezone);
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  const start = localMidnight(date.toISOString().slice(0, 10), timezone);
  return { start, end };
}

function text(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value);
}

function temporal(value: unknown): Temporal | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value;
  if (typeof value === "object" && value !== null && "isDate" in value && value.isDate && "toString" in value && typeof value.toString === "function") return String(value);
  if (typeof value === "object" && value !== null && "toJSDate" in value && typeof value.toJSDate === "function") return value.toJSDate();
  if (typeof value === "object" && value !== null && "toString" in value) return String(value);
  return undefined;
}

function asDate(value: unknown): Date {
  if (value instanceof Date) return value;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid ICS date: ${String(value)}`);
  return parsed;
}

function dateOnly(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function isBusy(event: Record<string, unknown>): boolean {
  const transparency = text(propertyValue(event, "transp")).toUpperCase() || "OPAQUE";
  const busyStatus = text(propertyValue(event, "X-MICROSOFT-CDO-BUSYSTATUS")).toUpperCase() || "BUSY";
  return transparency !== "TRANSPARENT" && !["FREE", "AVAILABLE"].includes(busyStatus);
}

function propertyValue(event: Record<string, unknown>, name: string): unknown {
  const component = event.component as { getFirstPropertyValue?: (property: string) => unknown } | undefined;
  return component?.getFirstPropertyValue?.(name);
}

function temporalSort(a: SourceEvent["start"], b: SourceEvent["start"]): number {
  return String(a).localeCompare(String(b));
}

function localDate(value: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
}

function localMidnight(date: string, timezone: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const utcMidnight = Date.UTC(year, month - 1, day);
  const zonedParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(utcMidnight));
  const values = Object.fromEntries(zonedParts.map((part) => [part.type, part.value]));
  const zonedAsUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second));
  return new Date(utcMidnight - (zonedAsUtc - utcMidnight));
}
