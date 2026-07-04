/**
 * Google Calendar connector (service-account auth).
 *
 * Setup:
 *   1. Create a Google Cloud service account, enable the Calendar API, and
 *      download its JSON key.
 *   2. Share the target calendar with the service account's email
 *      (…@…​.iam.gserviceaccount.com), giving it "Make changes to events".
 *   3. Set env vars:
 *        GOOGLE_SERVICE_ACCOUNT_JSON = the full key JSON (single line)
 *        GOOGLE_CALENDAR_ID          = the calendar id (e.g. you@gmail.com)
 *   Optional: GOOGLE_CALENDAR_TZ (default Asia/Kolkata).
 *
 * Unconfigured → isCalendarConfigured() is false and callers show setup help.
 */
import { JWT } from "google-auth-library";

const SCOPES = ["https://www.googleapis.com/auth/calendar"];
const CAL_TZ = process.env.GOOGLE_CALENDAR_TZ || "Asia/Kolkata";

function getCreds(): { client_email: string; private_key: string } | null {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const json = JSON.parse(raw);
    if (json.client_email && json.private_key) {
      return {
        client_email: json.client_email,
        private_key: String(json.private_key).replace(/\\n/g, "\n"),
      };
    }
  } catch {
    /* malformed */
  }
  return null;
}

export function isCalendarConfigured(): boolean {
  return !!getCreds() && !!process.env.GOOGLE_CALENDAR_ID;
}

/**
 * Parses `YYYY-MM-DD` or `YYYY-MM-DD HH:MM` (space or T) into a wall-clock
 * "YYYY-MM-DDTHH:MM:SS" (interpreted in the calendar's timezone). Date-only
 * defaults to 09:00. Returns null on unrecognised input.
 */
export function parseWhen(input: string): string | null {
  const s = (input || "").trim();
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m;
  const pad = (v: string | number) => String(v).padStart(2, "0");
  const hour = hh !== undefined ? pad(hh) : "09";
  const min = mm !== undefined ? mm : "00";
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour !== undefined && Number(hour) > 23) return null;
  return `${y}-${pad(mo)}-${pad(d)}T${hour}:${min}:00`;
}

/** Adds `hours` to a wall-clock datetime string (no DST — India-safe). */
export function addHours(dateTime: string, hours: number): string {
  const [datePart, timePart] = dateTime.split("T");
  const [y, mo, d] = datePart.split("-").map(Number);
  const [h, mi] = timePart.split(":").map(Number);
  const plus = new Date(Date.UTC(y, mo - 1, d, h, mi, 0) + hours * 3600000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${plus.getUTCFullYear()}-${pad(plus.getUTCMonth() + 1)}-${pad(plus.getUTCDate())}T${pad(plus.getUTCHours())}:${pad(plus.getUTCMinutes())}:00`;
}

async function getAccessToken(): Promise<string | null> {
  const creds = getCreds();
  if (!creds) return null;
  const client = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: SCOPES,
  });
  const { access_token } = await client.authorize();
  return access_token || null;
}

function calendarId(): string {
  return encodeURIComponent(process.env.GOOGLE_CALENDAR_ID || "primary");
}

export interface CreateEventInput {
  summary: string;
  startDateTime: string; // "YYYY-MM-DDTHH:MM:SS" (wall clock in CAL_TZ)
  endDateTime: string;
  description?: string;
}

export async function createCalendarEvent(
  input: CreateEventInput,
): Promise<{ ok: boolean; htmlLink?: string; error?: string }> {
  try {
    const token = await getAccessToken();
    if (!token) return { ok: false, error: "Calendar auth failed." };

    const fetchFn = (globalThis as any).fetch ?? (await import("node-fetch")).default;
    const res = await fetchFn(
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId()}/events`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          summary: input.summary,
          description: input.description || undefined,
          start: { dateTime: input.startDateTime, timeZone: CAL_TZ },
          end: { dateTime: input.endDateTime, timeZone: CAL_TZ },
        }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => String(res.status));
      return { ok: false, error: `Calendar API ${res.status}: ${body.slice(0, 200)}` };
    }
    const data = await res.json();
    return { ok: true, htmlLink: data.htmlLink };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface UpcomingEvent {
  summary: string;
  start: string;
  htmlLink?: string;
}

export async function listUpcomingEvents(
  max = 10,
): Promise<{ ok: boolean; events?: UpcomingEvent[]; error?: string }> {
  try {
    const token = await getAccessToken();
    if (!token) return { ok: false, error: "Calendar auth failed." };

    const fetchFn = (globalThis as any).fetch ?? (await import("node-fetch")).default;
    const now = new Date().toISOString();
    const url =
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId()}/events` +
      `?timeMin=${encodeURIComponent(now)}&singleEvents=true&orderBy=startTime&maxResults=${max}`;
    const res = await fetchFn(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => String(res.status));
      return { ok: false, error: `Calendar API ${res.status}: ${body.slice(0, 200)}` };
    }
    const data = await res.json();
    const events: UpcomingEvent[] = (data.items || []).map((e: any) => ({
      summary: e.summary || "(no title)",
      start: e.start?.dateTime || e.start?.date || "",
      htmlLink: e.htmlLink,
    }));
    return { ok: true, events };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
