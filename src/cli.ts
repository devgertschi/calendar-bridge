import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { loadConfig, relativeToConfig } from "./config.js";
import { assertSourceIsSafe, fetchIcs, parseIcs } from "./ics.js";
import { authorize, createCalendarClient, GoogleSink } from "./google.js";
import { reconcile, type ReconcileResult } from "./reconcile.js";

const configPath = process.argv.includes("--config") ? process.argv[process.argv.indexOf("--config") + 1] : "config.yaml";
const command = process.argv[2] ?? "sync";
const dryRun = process.argv.includes("--dry-run");

export async function main(): Promise<void> {
  const config = await loadConfig(configPath);
  const credentialsFile = relativeToConfig(configPath, config.sync.credentialsFile);
  const tokenFile = relativeToConfig(configPath, config.sync.tokenFile);
  if (command === "authorize") {
    await authorize(credentialsFile, tokenFile);
    return;
  }
  if (command !== "sync") throw new Error(`Unknown command: ${command}`);
  const lockFile = dryRun ? undefined : relativeToConfig(configPath, config.sync.lockFile);
  if (lockFile && existsSync(lockFile)) throw new Error(`Lock file exists: ${lockFile}`);
  if (lockFile) await writeFile(lockFile, `${process.pid}\n`, { flag: "wx" });
  try {
    const input = await fetchIcs(config.source.icsUrl);
    const events = parseIcs(input, { timezone: config.source.timezone, lookaheadDays: config.sync.lookaheadDays, onlyBusy: config.sync.onlyBusy });
    assertSourceIsSafe(events, config.sync.allowEmptySource);
    const result: ReconcileResult = { created: 0, updated: 0, deleted: 0, unchanged: 0 };
    if (config.destinations.length > 0) {
      // Dry-run still reads Google so it can calculate the complete reconciliation,
      // but reconcile() receives dryRun=true and performs no writes.
      const client = await createCalendarClient(credentialsFile, tokenFile);
      for (const destination of config.destinations) {
        const current = await reconcile(events, new GoogleSink(client, destination.calendarId, config.sync.writeDelayMs), config.sync, config.sync.deleteRemovedEvents, dryRun);
        for (const key of Object.keys(result) as Array<keyof ReconcileResult>) result[key] += current[key];
      }
    }
    if (!dryRun) {
      await writeFile(relativeToConfig(configPath, config.sync.stateFile), JSON.stringify({ lastSuccess: new Date().toISOString(), eventCount: events.length, result }, null, 2) + "\n");
    }
    console.log(`sync complete: ${JSON.stringify(dryRun ? { ...result, eventCount: events.length, dryRun: true } : result)}`);
  } finally {
    if (lockFile) await import("node:fs/promises").then(({ unlink }) => unlink(lockFile).catch(() => undefined));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => { console.error(error); process.exitCode = 1; });
