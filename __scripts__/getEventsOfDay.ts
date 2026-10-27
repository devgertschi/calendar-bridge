#!/usr/bin/env -S npx tsx

import { loadConfig } from "../src/config.js";
import { fetchIcs, parseIcs, type IcsRange } from "../src/ics.js";
import type { SourceEvent } from "../src/domain.js";

const args = process.argv.slice(2);
const configFlag = args.indexOf("--config");
const jsonOutput = args.includes("--json");
const configPath = configFlag >= 0 ? args[configFlag + 1] : "config.yaml";
const date = configFlag >= 0
  ? args.find((arg, index) => !arg.startsWith("-") && index !== configFlag + 1)
  : args.find((arg) => !arg.startsWith("-"));

if (!configPath || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !isValidDate(date)) {
  console.error("Usage: tsx __scripts__/getEventsOfDay.ts YYYY-MM-DD [--json] [--config path/to/config.yaml]");
  process.exitCode = 1;
} else {
  try {
    const config = await loadConfig(configPath);
    const range = dayRange(date, config.source.timezone);
    const input = await fetchIcs(config.source.icsUrl);
    const events = parseIcs(input, {
      timezone: config.source.timezone,
      lookaheadDays: 1,
      onlyBusy: config.sync.onlyBusy
    }, range.start, range);

    if (jsonOutput) console.log(JSON.stringify(events, null, 2));
    else printEvents(date, config.source.timezone, events);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

function dayRange(date: string, timezone: string): IcsRange {
  const nextDate = new Date(`${date}T00:00:00Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  return {
    start: localMidnight(date, timezone),
    end: localMidnight(nextDate.toISOString().slice(0, 10), timezone)
  };
}

function localMidnight(date: string, timezone: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const utcMidnight = Date.UTC(year, month - 1, day);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(utcMidnight));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const zonedAsUtc = Date.UTC(
    Number(values.year), Number(values.month) - 1, Number(values.day),
    Number(values.hour), Number(values.minute), Number(values.second)
  );
  return new Date(utcMidnight - (zonedAsUtc - utcMidnight));
}

function printEvents(date: string, timezone: string, events: SourceEvent[]): void {
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: timezone }).format(new Date(`${date}T12:00:00Z`));
  const headingDate = new Intl.DateTimeFormat("en-US", {
    day: "numeric", month: "long", year: "numeric", timeZone: timezone
  }).format(new Date(`${date}T12:00:00Z`));

  console.log(`${weekday}, ${headingDate} (${timezone})`);
  console.log(`${events.length} event${events.length === 1 ? "" : "s"}`);

  for (const event of events) {
    console.log(`\n- ${formatTime(event, timezone)} ${event.summary}`);
    if (event.location) console.log(`  Location: ${event.location}`);
    const availability = event.outOfOffice ? "out of office" : event.busy ? "busy" : "free";
    console.log(`  Status: ${event.status} (${availability})`);
    if (event.description.trim()) console.log(`  Description: ${event.description.trim()}`);
  }
}

function formatTime(event: SourceEvent, timezone: string): string {
  if (event.allDay) return "All day —";
  const format = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  return `${format.format(event.start as Date)}–${format.format(event.end as Date)} —`;
}

function isValidDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(`${value}T`);
}
