import { existsSync } from "node:fs";
import { readFile, writeFile, chmod } from "node:fs/promises";
import { google, calendar_v3 } from "googleapis";
import type { CalendarSink } from "./reconcile.js";
import { eventProperty, fingerprintProperty, googleBody, managedProperty, type ManagedGoogleEvent, type SourceEvent, type SyncOptions } from "./domain.js";

const scopes = ["https://www.googleapis.com/auth/calendar.events"];

export async function authorize(credentialsFile: string, tokenFile: string): Promise<void> {
  const raw = JSON.parse(await readFile(credentialsFile, "utf8"));
  const config = raw.installed ?? raw.web;
  if (!config) throw new Error("credentials.json has no installed or web OAuth configuration");
  const auth = new google.auth.OAuth2(config.client_id, config.client_secret, config.redirect_uris?.[0]);
  const url = auth.generateAuthUrl({ access_type: "offline", scope: scopes, prompt: "consent" });
  console.log(`Open this URL in a browser:\n\n${url}\n`);
  const code = await readStdin("Paste the authorization code: ");
  const { tokens } = await auth.getToken(code.trim());
  await writeFile(tokenFile, JSON.stringify(tokens, null, 2) + "\n", { mode: 0o600 });
}

export async function createCalendarClient(credentialsFile: string, tokenFile: string): Promise<calendar_v3.Calendar> {
  const raw = JSON.parse(await readFile(credentialsFile, "utf8"));
  const config = raw.installed ?? raw.web;
  const token = JSON.parse(await readFile(tokenFile, "utf8"));
  const auth = new google.auth.OAuth2(config.client_id, config.client_secret, config.redirect_uris?.[0]);
  auth.setCredentials(token);
  auth.on("tokens", async (newTokens) => {
    await writeFile(tokenFile, JSON.stringify({ ...token, ...newTokens }, null, 2) + "\n", { mode: 0o600 });
    await chmod(tokenFile, 0o600);
  });
  return google.calendar({ version: "v3", auth });
}

export class GoogleSink implements CalendarSink {
  constructor(private readonly client: calendar_v3.Calendar, private readonly calendarId: string, private readonly writeDelayMs: number) {}

  async managedEvents(): Promise<Record<string, ManagedGoogleEvent>> {
    const result: Record<string, ManagedGoogleEvent> = {};
    let pageToken: string | undefined;
    do {
      const response = await this.client.events.list({ calendarId: this.calendarId, privateExtendedProperty: [`${managedProperty}=true`], showDeleted: false, maxResults: 2500, pageToken });
      for (const event of response.data.items ?? []) {
        const key = event.extendedProperties?.private?.[eventProperty];
        if (key && event.id) result[key] = event as ManagedGoogleEvent;
      }
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);
    return result;
  }

  async create(event: SourceEvent, options: SyncOptions): Promise<string> {
    await this.delay();
    const response = await this.withBackoff(() => this.client.events.insert({ calendarId: this.calendarId, sendUpdates: "none", requestBody: googleBody(event, options) }));
    return response.data.id!;
  }

  async update(id: string, event: SourceEvent, options: SyncOptions): Promise<void> {
    await this.delay();
    await this.withBackoff(() => this.client.events.update({ calendarId: this.calendarId, eventId: id, sendUpdates: "none", requestBody: googleBody(event, options) }));
  }

  async delete(id: string): Promise<void> {
    await this.delay();
    await this.withBackoff(() => this.client.events.delete({ calendarId: this.calendarId, eventId: id }));
  }

  private async delay(): Promise<void> {
    if (this.writeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.writeDelayMs));
  }

  private async withBackoff<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await operation(); }
      catch (error) {
        const status = (error as { response?: { status?: number } }).response?.status;
        if (![403, 429, 500, 502, 503, 504].includes(status ?? 0) || attempt >= 5) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, (2 ** attempt) * 1000 + Math.random() * 1000)));
      }
    }
  }
}

async function readStdin(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise((resolve) => process.stdin.once("data", (chunk) => resolve(String(chunk))));
}
