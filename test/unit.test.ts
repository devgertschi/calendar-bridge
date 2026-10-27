import { describe, expect, it } from "vitest";
import { fingerprint, googleBody, sourceKey, temporalMatches, visibleFieldsMatch, type ManagedGoogleEvent, type SourceEvent } from "../src/domain.js";
import { reconcile } from "../src/reconcile.js";
import { assertSourceIsSafe } from "../src/ics.js";

const event = (summary = "Meeting"): SourceEvent => ({ key: "uid|single", uid: "uid", summary, start: new Date("2026-01-01T10:00:00Z"), end: new Date("2026-01-01T11:00:00Z"), allDay: false, location: "Room 1", description: "Details", status: "CONFIRMED", busy: true });
const options = { copyDescription: true, copyLocation: true, visibility: "private", summaryPrefix: "" };

describe("event mapping", () => {
  it("creates a Google event with title, location, description and time", () => {
    const body = googleBody(event(), options);
    expect(body.summary).toBe("Meeting");
    expect(body.location).toBe("Room 1");
    expect(body.description).toBe("Details");
    expect(body.start).toEqual({ dateTime: "2026-01-01T10:00:00.000Z" });
    expect(body.extendedProperties.private.calendar_sync_event).toBe("uid|single");
  });

  it("marks out-of-office source events in the summary", () => {
    expect(googleBody({ ...event(), outOfOffice: true }, options).summary).toBe("📴 Meeting");
  });

  it("creates stable keys for single and recurring events", () => {
    expect(sourceKey("uid", new Date("2026-01-01T10:00:00Z"), false)).toBe("uid|single");
    expect(sourceKey("uid", new Date("2026-01-01T10:00:00Z"), true)).toContain("uid|");
  });

  it("normalizes Google default transparency and time zones", () => {
    const current: ManagedGoogleEvent = { id: "g", summary: "Meeting", visibility: "private", start: { dateTime: "2026-01-01T11:00:00+01:00" }, end: { dateTime: "2026-01-01T12:00:00+01:00" }, location: "Room 1", description: "Details" };
    expect(visibleFieldsMatch(current, event(), options)).toBe(true);
    expect(temporalMatches(current.start, { dateTime: "2026-01-01T10:00:00.000Z" })).toBe(true);
  });

  it("updates a managed event when its out-of-office marker changes the summary", async () => {
    const calls: string[] = [];
    const source = { ...event(), outOfOffice: true };
    const sink = {
      managedEvents: async () => ({ [source.key]: { id: "old-id", summary: "Meeting", visibility: "private", extendedProperties: { private: { calendar_sync_fingerprint: fingerprint(source) } } } as ManagedGoogleEvent }),
      create: async () => "new",
      update: async () => { calls.push("update"); },
      delete: async () => { calls.push("delete"); }
    };
    const result = await reconcile([source], sink, options, true, false);
    expect(result.updated).toBe(1);
    expect(calls).toEqual(["update"]);
  });
});

describe("reconciliation", () => {
  it("creates, updates, deletes and skips unchanged events", async () => {
    const calls: string[] = [];
    const sink = {
      managedEvents: async () => ({ old: { id: "old-id", summary: "Old" } as ManagedGoogleEvent }),
      create: async () => { calls.push("create"); return "new"; },
      update: async () => { calls.push("update"); },
      delete: async () => { calls.push("delete"); }
    };
    const result = await reconcile([event()], sink, options, true, false);
    expect(result).toEqual({ created: 1, updated: 0, deleted: 1, unchanged: 0 });
    expect(calls).toEqual(["create", "delete"]);
  });

  it("does not write in dry-run mode", async () => {
    const calls: string[] = [];
    const sink = { managedEvents: async () => ({}), create: async () => { calls.push("create"); return "new"; }, update: async () => { calls.push("update"); }, delete: async () => { calls.push("delete"); } };
    const result = await reconcile([event()], sink, options, true, true);
    expect(result.created).toBe(1);
    expect(calls).toEqual([]);
  });

  it("can preserve removed events when deletion is disabled", async () => {
    const calls: string[] = [];
    const sink = { managedEvents: async () => ({ old: { id: "old-id" } as ManagedGoogleEvent }), create: async () => "new", update: async () => {}, delete: async () => { calls.push("delete"); } };
    const result = await reconcile([event()], sink, options, false, false);
    expect(result.deleted).toBe(0);
    expect(calls).toEqual([]);
  });

  it("preserves managed events that ended before the sync", async () => {
    const calls: string[] = [];
    const sink = {
      managedEvents: async () => ({ old: { id: "old-id", end: { dateTime: "2026-01-01T11:00:00Z" } } as ManagedGoogleEvent }),
      create: async () => "new",
      update: async () => {},
      delete: async () => { calls.push("delete"); }
    };
    const result = await reconcile([], sink, options, true, false, new Date("2026-01-02T00:00:00Z"));
    expect(result.deleted).toBe(0);
    expect(calls).toEqual([]);
  });

  it("still deletes removed events that have not ended", async () => {
    const calls: string[] = [];
    const sink = {
      managedEvents: async () => ({ old: { id: "old-id", end: { dateTime: "2026-01-03T11:00:00Z" } } as ManagedGoogleEvent }),
      create: async () => "new",
      update: async () => {},
      delete: async () => { calls.push("delete"); }
    };
    const result = await reconcile([], sink, options, true, false, new Date("2026-01-02T00:00:00Z"));
    expect(result.deleted).toBe(1);
    expect(calls).toEqual(["delete"]);
  });
});

describe("source safety", () => {
  it("rejects an empty source by default", () => {
    expect(() => assertSourceIsSafe([], false)).toThrow(/no events/);
    expect(() => assertSourceIsSafe([], true)).not.toThrow();
  });
});
