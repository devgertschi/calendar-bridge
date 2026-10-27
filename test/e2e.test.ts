import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseIcs } from "../src/ics.js";
import { reconcile } from "../src/reconcile.js";

describe("calendar fixture", () => {
  it("parses an anonymized source calendar into unique normalized events", async () => {
    const fixture = await readFile(resolve(import.meta.dirname, "fixtures/calendar.ics"), "utf8");
    const events = parseIcs(fixture, { timezone: "Europe/Vienna", lookaheadDays: 90, onlyBusy: true }, new Date("2026-10-25T00:00:00Z"));
    expect(events.length).toBeGreaterThan(0);
    expect(new Set(events.map((event) => event.key)).size).toBe(events.length);
    expect(events.every((event) => event.summary.length > 0)).toBe(true);
    expect(events.find((event) => event.summary === "Österreichischer Nationalfeiertag")).toMatchObject({ start: "2026-10-26", end: "2026-10-27", allDay: true });
    const calls: string[] = [];
    const sink = {
      managedEvents: async () => ({}),
      create: async () => { calls.push("create"); return "new"; },
      update: async () => { calls.push("update"); },
      delete: async () => { calls.push("delete"); }
    };
    const result = await reconcile(events, sink, { copyDescription: true, copyLocation: true, visibility: "private", summaryPrefix: "" }, true, true);
    expect(result).toEqual({ created: events.length, updated: 0, deleted: 0, unchanged: 0 });
    expect(calls).toEqual([]);
    expect({
      eventCount: events.length,
      timed: events.filter((event) => !event.allDay).length,
      allDay: events.filter((event) => event.allDay).length,
      withLocation: events.filter((event) => event.location.length > 0).length,
      withDescription: events.filter((event) => event.description.length > 0).length
    }).toMatchSnapshot();
  });
});
