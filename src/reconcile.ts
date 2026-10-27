import type { ManagedGoogleEvent, SourceEvent, SyncOptions } from "./domain.js";
import { eventProperty, fingerprint, googleBody, legacyFingerprint, managedProperty, temporalMatches, visibleFieldsMatch } from "./domain.js";

export interface CalendarSink {
  managedEvents(): Promise<Record<string, ManagedGoogleEvent>>;
  create(event: SourceEvent, options: SyncOptions): Promise<string>;
  update(id: string, event: SourceEvent, options: SyncOptions): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface ReconcileResult {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
}

export async function reconcile(
  events: SourceEvent[],
  sink: CalendarSink,
  options: SyncOptions,
  deleteRemoved: boolean,
  dryRun: boolean,
  now = new Date(),
  timezone = "UTC"
): Promise<ReconcileResult> {
  const existing = await sink.managedEvents();
  const desired = new Map(events.map((event) => [event.key, event]));
  const result: ReconcileResult = { created: 0, updated: 0, deleted: 0, unchanged: 0 };
  const matchedKeys = new Set<string>();

  for (const [key, event] of desired) {
    let current = existing[key];
    let currentKey = key;
    if (!current) {
      const expected = googleBody(event, options);
      const fallback = Object.entries(existing).find(([candidateKey, candidate]) => {
        if (matchedKeys.has(candidateKey)) return false;
        const properties = candidate.extendedProperties?.private ?? {};
        return properties.calendar_sync_uid === event.uid &&
          temporalMatches(candidate.start, expected.start) &&
          temporalMatches(candidate.end, expected.end);
      });
      if (fallback) {
        currentKey = fallback[0];
        current = fallback[1];
      }
    }
    if (!current) {
      result.created++;
      if (!dryRun) await sink.create(event, options);
      continue;
    }
    matchedKeys.add(currentKey);
    const props = current.extendedProperties?.private ?? {};
    const metadataMatches = [fingerprint(event), legacyFingerprint(event)].includes(props.calendar_sync_fingerprint);
    if (metadataMatches || visibleFieldsMatch(current, event, options)) {
      result.unchanged++;
      continue;
    }
    result.updated++;
    if (!dryRun) await sink.update(current.id, event, options);
  }

  if (deleteRemoved) {
    for (const [key, event] of Object.entries(existing)) {
      if (desired.has(key) || matchedKeys.has(key)) continue;
      // The source feed is intentionally limited to now..lookahead. An event
      // that ended before this sync must not be mistaken for a removed event.
      if (endedBefore(event, now, timezone)) continue;
      result.deleted++;
      if (!dryRun) await sink.delete(event.id);
    }
  }
  return result;
}

function endedBefore(event: ManagedGoogleEvent, now: Date, timezone: string): boolean {
  const end = event.end;
  if (end?.date) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(now);
    return end.date <= today;
  }
  if (end?.dateTime) {
    const endTime = Date.parse(end.dateTime);
    return Number.isFinite(endTime) && endTime <= now.getTime();
  }
  return false;
}

export function isManaged(event: ManagedGoogleEvent): boolean {
  return event.extendedProperties?.private?.[managedProperty] === "true" && Boolean(event.extendedProperties?.private?.[eventProperty]);
}
