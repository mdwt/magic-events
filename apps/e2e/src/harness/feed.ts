import { send, type Call, type Client } from "./api.ts";
import { show } from "./checks.ts";
import type { ApiServer } from "./server.ts";
import { client, mainServer } from "./state.ts";

// The feed as a client sees it: the answers of search and changed-since, typed as the OpenAPI document describes
// them, and the stays docs/end-to-end.md uses throughout.

export interface Session {
  startDate: string;
  endDate: string;
  precision: "day" | "month" | "year";
  startTime: string | null;
  endTime: string | null;
  label: string | null;
  soldOut: boolean;
}

export interface Experience {
  id: string;
  title: string;
  slug: string;
  type: "single" | "run" | "recurring";
  status: string;
  booking: string;
  venue: { name: string | null; address: string | null; city: string | null; position: { lat: number; lng: number } | null };
  distanceKm: number;
  price: { min: number | null; max: number | null; currency: string | null };
  bookingUrl: string | null;
  pageUrl: string | null;
  attributes: Record<string, (string | number | boolean)[]>;
  tags: string[];
  sessions: Session[];
  bookable: boolean;
  version: number;
  updatedAt: string;
}

export interface SearchResult {
  items: Experience[];
  total: number;
  limit: number;
  offset: number;
}

export interface ChangeItem {
  experience: Experience;
  movedOut: boolean;
  change: { kind: string; at: string };
  changes: { kind: string; at: string }[];
}

export interface ChangesResult {
  items: ChangeItem[];
  total: number;
  limit: number;
  offset: number;
}

export type Body = Record<string, unknown>;

export const WINTER: Body = { location: "hermanus", from: "2027-06-20", to: "2027-06-30" };
export const DECEMBER: Body = { location: "hermanus", from: "2026-12-07", to: "2026-12-20" };

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addMonths(day: string, months: number, days = 0): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function expectOk(call: Call, what: string): void {
  if (call.status !== 200) throw new Error(`${what} answered ${call.status}: ${show(call.json ?? call.text)}`);
}

export async function search(
  body: Body,
  who: Client = client("agency person"),
  server: ApiServer = mainServer(),
): Promise<{ call: Call; result: SearchResult }> {
  const call = await send(server, { method: "POST", path: "/v1/experiences/search", client: who, body });
  expectOk(call, `search ${show(body)}`);
  return { call, result: call.json as SearchResult };
}

// Every item of a search, page after page of 100.
export async function searchAll(body: Body, who: Client = client("agency person")): Promise<Experience[]> {
  const items: Experience[] = [];
  for (let offset = 0; ; offset += 100) {
    const { result } = await search({ ...body, limit: 100, offset }, who);
    items.push(...result.items);
    if (result.items.length < 100 || items.length >= result.total) return items;
  }
}

export async function changes(
  body: Body,
  who: Client = client("agency person"),
): Promise<{ call: Call; result: ChangesResult }> {
  const call = await send(mainServer(), { method: "POST", path: "/v1/experiences/changes", client: who, body });
  expectOk(call, `changes ${show(body)}`);
  return { call, result: call.json as ChangesResult };
}

export function titled(items: Experience[], title: string): Experience[] {
  return items.filter((item) => item.title === title);
}

export function titles(items: { title: string }[]): string[] {
  return items.map((item) => item.title);
}

export function ids(items: { id: string }[]): string[] {
  return items.map((item) => item.id);
}

// An experience in a few words, for the evidence of a scenario.
export function brief(item: Experience | undefined): string {
  if (item === undefined) return "not returned";
  const days = item.sessions.map((s) =>
    `${s.startDate === s.endDate ? s.startDate : `${s.startDate}..${s.endDate}`}${s.precision === "day" ? "" : ` (${s.precision})`}${s.startTime ? ` ${s.startTime.slice(0, 5)}` : ""}`,
  );
  return `"${item.title}" ${item.status}, booking ${item.booking}${item.bookable ? ", bookable" : ""}, ${days.join(", ")}`;
}

export function hhmm(time: string | null): string | null {
  return time === null ? null : time.slice(0, 5);
}

export function sessionDays(item: Experience): string[] {
  return item.sessions.map((session) =>
    session.startDate === session.endDate ? session.startDate : `${session.startDate}..${session.endDate}`,
  );
}

export function overlaps(session: Session, from: string, to: string): boolean {
  return session.startDate <= to && session.endDate >= from;
}

// Great-circle distance in kilometres.
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
