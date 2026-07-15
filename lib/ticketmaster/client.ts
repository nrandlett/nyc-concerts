// Ticketmaster Discovery API client.
//
// A thin, typed wrapper over the three Discovery API endpoints our pipeline
// needs. Docs: https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/
//
// ---------------------------------------------------------------------------
// Quota & rate limits (READ THIS before adding new calls)
// ---------------------------------------------------------------------------
// Ticketmaster's default plan allows:
//   * 5,000 API calls PER DAY  (a hard daily quota — resets at midnight UTC)
//   * 5 requests PER SECOND    (short-term rate limit; over it returns HTTP 429)
//
// The Discovery API is enormous, but we deliberately use only a tiny subset:
//   1. searchVenues(query)                 — find a venue's Ticketmaster ID by name
//   2. getEventsInMetro(dmaId, start, end) — list music events in a metro/date range
//   3. getVenueDetails(venueId)            — fetch one venue's full record
//
// Typical daily usage is well under 200 calls (a one-time 74-venue backfill,
// then a handful of paged event requests per ingestion run), so the 5,000/day
// quota is not a concern — but keep it in mind before writing any loop that
// calls the API per-item over a large list.
//
// Every request goes through request() below, which is the single place that
// attaches the API key, throttles to stay under 5 req/sec, and handles errors.

import type {
  TmVenue,
  TmEvent,
  TmVenueSearchResponse,
  TmEventSearchResponse,
} from "./types";

const BASE_URL = "https://app.ticketmaster.com/discovery/v2";

// Minimum spacing between requests. The 5 req/sec limit is enforced by a strict
// "spike arrest" that dislikes bursting, so we pace well under it (~3.3 req/sec)
// rather than riding the 200ms boundary.
const MIN_REQUEST_SPACING_MS = 300;

// On a 429 (rate limit), retry a few times with exponential backoff before
// giving up. This keeps a long backfill from dying on a transient spike.
const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 1000;

function getApiKey(): string {
  const key = process.env.TICKETMASTER_API_KEY;
  if (!key) {
    throw new Error(
      "Missing TICKETMASTER_API_KEY. Add it to .env.local (see .env.example)."
    );
  }
  return key;
}

// ---------------------------------------------------------------------------
// Throttling
// ---------------------------------------------------------------------------
// A dead-simple serial throttle. We track when the last request went out and,
// if the next one comes too soon, we sleep for the remaining gap. Because JS is
// single-threaded and we await this before every fetch, requests are naturally
// serialized — good enough for our scripts, which are not highly concurrent.

let lastRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestAt;
  if (elapsed < MIN_REQUEST_SPACING_MS) {
    await sleep(MIN_REQUEST_SPACING_MS - elapsed);
  }
  lastRequestAt = Date.now();
}

// ---------------------------------------------------------------------------
// Core request helper
// ---------------------------------------------------------------------------

/**
 * Perform a GET against a Discovery API endpoint.
 *
 * @param endpoint  Path under the API base, e.g. "/venues.json".
 * @param params    Query params (the API key is added automatically).
 */
async function request<T>(
  endpoint: string,
  params: Record<string, string | number | undefined>
): Promise<T> {
  const url = new URL(`${BASE_URL}${endpoint}`);
  url.searchParams.set("apikey", getApiKey());
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  for (let attempt = 0; ; attempt++) {
    await throttle();
    const res = await fetch(url);

    if (res.ok) {
      return (await res.json()) as T;
    }

    // 429 = rate limited. Back off and retry a few times before giving up.
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
      console.warn(
        `  ⚠ 429 from ${endpoint}; backing off ${delay}ms (retry ${
          attempt + 1
        }/${MAX_RETRIES})`
      );
      await sleep(delay);
      continue;
    }

    // Any other error (or retries exhausted): surface the body for context.
    // Ticketmaster returns a JSON error object with useful detail.
    const body = await res.text();
    throw new Error(
      `Ticketmaster ${endpoint} failed: ${res.status} ${res.statusText}\n${body}`
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Search venues by free-text keyword (typically a venue name). Used during the
 * backfill to discover a venue's Ticketmaster ID.
 *
 * We constrain to US results and return the raw list so the caller can decide
 * which match is correct (venue names are often ambiguous).
 *
 * @param query  Venue name, optionally with city, e.g. "Bowery Ballroom".
 * @param size   Max results to return (default 10).
 */
export async function searchVenues(
  query: string,
  size = 10
): Promise<TmVenue[]> {
  const data = await request<TmVenueSearchResponse>("/venues.json", {
    keyword: query,
    countryCode: "US",
    size,
  });
  return data._embedded?.venues ?? [];
}

/**
 * Fetch the full record for a single venue by its Ticketmaster ID.
 */
export async function getVenueDetails(venueId: string): Promise<TmVenue> {
  return request<TmVenue>(`/venues/${venueId}.json`, {});
}

/**
 * List music events in a metro area (DMA) within a date range.
 *
 * NYC's DMA ID is 345. Dates must be ISO-8601 UTC WITHOUT milliseconds, e.g.
 * "2026-07-14T00:00:00Z" — the API rejects the millisecond form. Use
 * toTicketmasterDate() below to format a Date correctly.
 *
 * This handles pagination internally: it walks every result page and returns
 * the combined list. classificationName=music restricts to music events.
 *
 * @param dmaId      Designated Market Area id (NYC = 345).
 * @param startDate  Inclusive start of the window (UTC ISO, no ms).
 * @param endDate    Inclusive end of the window (UTC ISO, no ms).
 */
export async function getEventsInMetro(
  dmaId: number,
  startDate: string,
  endDate: string
): Promise<TmEvent[]> {
  const events: TmEvent[] = [];
  let page = 0;

  // Ticketmaster caps deep paging (size * page must stay under ~1000), so a
  // page size of 100 with a sane page ceiling is safe for a 7-day window.
  const PAGE_SIZE = 100;
  const MAX_PAGES = 10;

  while (page < MAX_PAGES) {
    const data = await request<TmEventSearchResponse>("/events.json", {
      dmaId,
      classificationName: "music",
      startDateTime: startDate,
      endDateTime: endDate,
      size: PAGE_SIZE,
      page,
      sort: "date,asc",
    });

    const batch = data._embedded?.events ?? [];
    events.push(...batch);

    const totalPages = data.page?.totalPages ?? 1;
    page += 1;
    if (page >= totalPages) break;
  }

  return events;
}

/**
 * Format a Date as a Ticketmaster-compatible UTC timestamp (no milliseconds).
 * e.g. new Date() -> "2026-07-14T18:30:00Z".
 */
export function toTicketmasterDate(date: Date): string {
  // toISOString() gives "...T18:30:00.000Z"; strip the ".000" milliseconds.
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
