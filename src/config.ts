import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const schema = z.object({
  source: z.object({ icsUrl: z.string().url(), timezone: z.string().min(1) }),
  destinations: z.array(z.object({ calendarId: z.string().min(1), name: z.string().optional() })).min(1),
  sync: z.object({
    lookaheadDays: z.number().int().positive().default(90),
    onlyBusy: z.boolean().default(true),
    copyDescription: z.boolean().default(true),
    copyLocation: z.boolean().default(true),
    visibility: z.string().default("private"),
    summaryPrefix: z.string().default(""),
    deleteRemovedEvents: z.boolean().default(true),
    allowEmptySource: z.boolean().default(false),
    writeDelayMs: z.number().nonnegative().default(1000),
    credentialsFile: z.string().default("credentials.json"),
    tokenFile: z.string().default("token.json"),
    stateFile: z.string().default("state.json"),
    lockFile: z.string().default("sync.lock")
  }).strict().default({})
});

export type AppConfig = z.infer<typeof schema>;

export async function loadConfig(path: string): Promise<AppConfig> {
  const raw = parse(await readFile(path, "utf8")) as Record<string, any>;
  const supportedSyncKeys = new Set([
    "lookaheadDays", "lookahead_days", "onlyBusy", "only_busy", "copyDescription", "copy_description",
    "copyLocation", "copy_location", "visibility", "summaryPrefix", "summary_prefix",
    "deleteRemovedEvents", "delete_removed_events", "allowEmptySource", "allow_empty_source",
    "writeDelayMs", "write_delay_seconds", "credentialsFile", "credentials_file", "tokenFile", "token_file",
    "stateFile", "state_file", "lockFile", "lock_file"
  ]);
  const unknownSyncKeys = Object.keys(raw.sync ?? {}).filter((key) => !supportedSyncKeys.has(key));
  if (unknownSyncKeys.length > 0) throw new Error(`Unsupported sync configuration: ${unknownSyncKeys.join(", ")}`);
  const normalized = {
    source: {
      icsUrl: raw.source?.icsUrl ?? raw.source?.ics_url,
      timezone: raw.source?.timezone
    },
    destinations: (raw.destinations ?? []).map((destination: Record<string, any>) => ({
      calendarId: destination.calendarId ?? destination.calendar_id,
      name: destination.name
    })),
    sync: {
      lookaheadDays: raw.sync?.lookaheadDays ?? raw.sync?.lookahead_days,
      onlyBusy: raw.sync?.onlyBusy ?? raw.sync?.only_busy,
      copyDescription: raw.sync?.copyDescription ?? raw.sync?.copy_description,
      copyLocation: raw.sync?.copyLocation ?? raw.sync?.copy_location,
      visibility: raw.sync?.visibility,
      summaryPrefix: raw.sync?.summaryPrefix ?? raw.sync?.summary_prefix,
      deleteRemovedEvents: raw.sync?.deleteRemovedEvents ?? raw.sync?.delete_removed_events,
      allowEmptySource: raw.sync?.allowEmptySource ?? raw.sync?.allow_empty_source,
      writeDelayMs: raw.sync?.writeDelayMs ?? (raw.sync?.write_delay_seconds === undefined ? undefined : raw.sync.write_delay_seconds * 1000),
      credentialsFile: raw.sync?.credentialsFile ?? raw.sync?.credentials_file,
      tokenFile: raw.sync?.tokenFile ?? raw.sync?.token_file,
      stateFile: raw.sync?.stateFile ?? raw.sync?.state_file,
      lockFile: raw.sync?.lockFile ?? raw.sync?.lock_file
    }
  };
  return schema.parse(normalized);
}

export function relativeToConfig(configPath: string, configuredPath: string): string {
  return resolve(configPath, "..", configuredPath);
}
