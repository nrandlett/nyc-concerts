// Shared ingestion pipeline.
//
// This is the single source of truth for "pull NYC music events from
// Ticketmaster into our DB." Both entry points call runIngestion():
//   * scripts/ingest-events.ts  — the CLI, for local/manual runs & debugging
//   * app/api/cron/ingest/route.ts — the HTTPS endpoint Vercel Cron hits daily
//
// Keeping the logic here (not in either caller) means the automated job and the
// local command run byte-for-byte the same pipeline. Fix a bug once, both win.
//
// Pipeline:
//   1. Load our venues that have a ticketmaster_id -> map TM venue id -> our id.
//   2. Pull the next 7 days of NYC (DMA 345) music events from Ticketmaster.
//   3. Keep only events at a venue we track; skip the rest.
//   4. Bulk-upsert artists, then events, then the event_artists join rows.
//   5. Delete events that already happened (starts_at > 24h in the past).
//
// Upserts make re-running safe: existing rows update in place instead of
// duplicating. It uses the SERVER client (service_role key) to write past RLS.
//
// Depends on the artists/events/event_artists tables from the
// 20260714000000_create_events_schema.sql migration.

import { supabaseAdmin } from "../db/server";
import { getEventsInMetro, toTicketmasterDate } from "../ticketmaster/client";
import type { TmEvent } from "../ticketmaster/types";

const NYC_DMA_ID = 345;
const DAYS_AHEAD = 7;

// How far past an event's start time we keep it before cleanup removes it.
const STALE_AFTER_MS = 24 * 3600 * 1000;

// --- row shapes we insert ---------------------------------------------------

type ArtistInsert = {
  name: string;
  ticketmaster_id: string;
  url: string | null;
  genre: string | null;
};

type EventInsert = {
  ticketmaster_id: string;
  name: string;
  venue_id: string;
  starts_at: string | null;
  local_date: string;
  local_time: string | null;
  status: string | null;
  url: string | null;
  price_min: number | null;
  price_max: number | null;
  price_currency: string | null;
};

// --- result & error types ---------------------------------------------------

/** Everything a caller might want to log or return as JSON. */
export type IngestionResult = {
  venuesTracked: number;
  eventsFromTicketmaster: number;
  keptAtTrackedVenues: number;
  skippedUntracked: number;
  skippedNoVenue: number;
  skippedNoDate: number;
  artistsUpserted: number;
  eventsUpserted: number;
  linksUpserted: number;
  staleEventsDeleted: number;
};

/**
 * Thrown when a pipeline step fails. Carries which `step` broke and the raw
 * `detail` (e.g. a Postgres/Ticketmaster error message) so the API route can
 * put useful context into logs — and therefore into Vercel's failure email.
 */
export class IngestionError extends Error {
  step: string;
  detail?: string;
  constructor(step: string, message: string, detail?: string) {
    super(message);
    this.name = "IngestionError";
    this.step = step;
    this.detail = detail;
  }
}

// A logger the caller can supply. Defaults to a no-op so the API route stays
// quiet unless it wants progress lines; the CLI passes console.log.
type Logger = (msg: string) => void;
const noop: Logger = () => {};

// ---------------------------------------------------------------------------
// runIngestion
// ---------------------------------------------------------------------------

export async function runIngestion(log: Logger = noop): Promise<IngestionResult> {
  // 1. Venue lookup: TM venue id -> our venue uuid.
  const { data: venues, error: venuesError } = await supabaseAdmin
    .from("venues")
    .select("id, name, ticketmaster_id")
    .not("ticketmaster_id", "is", null);

  if (venuesError) {
    throw new IngestionError(
      "load-venues",
      "Could not read venues",
      venuesError.message
    );
  }

  const venueIdByTm = new Map<string, string>();
  for (const v of venues ?? []) {
    if (v.ticketmaster_id) venueIdByTm.set(v.ticketmaster_id, v.id);
  }
  log(`Tracking ${venueIdByTm.size} venues with a Ticketmaster ID.`);

  if (venueIdByTm.size === 0) {
    throw new IngestionError(
      "load-venues",
      "No venues have a ticketmaster_id yet. Run backfill-ticketmaster-ids.ts first."
    );
  }

  // 2. Pull events for the next 7 days.
  const now = new Date();
  const end = new Date(now.getTime() + DAYS_AHEAD * 24 * 3600 * 1000);
  log(
    `Fetching NYC music events ${now.toISOString().slice(0, 10)} -> ${end
      .toISOString()
      .slice(0, 10)}...`
  );

  let allEvents: TmEvent[];
  try {
    allEvents = await getEventsInMetro(
      NYC_DMA_ID,
      toTicketmasterDate(now),
      toTicketmasterDate(end)
    );
  } catch (err) {
    throw new IngestionError(
      "fetch-ticketmaster",
      "Ticketmaster event fetch failed",
      err instanceof Error ? err.message : String(err)
    );
  }
  log(`Ticketmaster returned ${allEvents.length} music events in metro.`);

  // 3. Keep only events at a venue we track. Dedupe by TM event id.
  const kept = new Map<string, TmEvent>();
  let skippedNoVenue = 0;
  let skippedUntracked = 0;
  for (const ev of allEvents) {
    const tmVenueId = ev._embedded?.venues?.[0]?.id;
    if (!tmVenueId) {
      skippedNoVenue += 1;
      continue;
    }
    if (!venueIdByTm.has(tmVenueId)) {
      skippedUntracked += 1;
      continue;
    }
    kept.set(ev.id, ev);
  }
  log(
    `Kept ${kept.size} events at tracked venues ` +
      `(skipped ${skippedUntracked} at untracked venues, ${skippedNoVenue} with no venue).`
  );

  // 4a. Collect unique artists across kept events and bulk-upsert them.
  const artistsByTm = new Map<string, ArtistInsert>();
  for (const ev of kept.values()) {
    for (const a of ev._embedded?.attractions ?? []) {
      if (!a.id || artistsByTm.has(a.id)) continue;
      artistsByTm.set(a.id, {
        name: a.name,
        ticketmaster_id: a.id,
        url: a.url ?? null,
        genre: a.classifications?.[0]?.genre?.name ?? null,
      });
    }
  }

  const artistIdByTm = new Map<string, string>();
  if (artistsByTm.size > 0) {
    const { data, error } = await supabaseAdmin
      .from("artists")
      .upsert([...artistsByTm.values()], { onConflict: "ticketmaster_id" })
      .select("id, ticketmaster_id");
    if (error) {
      throw new IngestionError("upsert-artists", "Artist upsert failed", error.message);
    }
    for (const row of data ?? []) {
      if (row.ticketmaster_id) artistIdByTm.set(row.ticketmaster_id, row.id);
    }
  }
  log(`Upserted ${artistIdByTm.size} artists.`);

  // 4b. Build and bulk-upsert event rows.
  const eventInserts: EventInsert[] = [];
  let skippedNoDate = 0;
  for (const ev of kept.values()) {
    const start = ev.dates?.start;
    // local_date is NOT NULL in our schema; derive from dateTime if needed.
    const localDate =
      start?.localDate ?? (start?.dateTime ? start.dateTime.slice(0, 10) : null);
    if (!localDate) {
      skippedNoDate += 1;
      continue;
    }
    const tmVenueId = ev._embedded!.venues![0].id;
    const price = ev.priceRanges?.[0];
    eventInserts.push({
      ticketmaster_id: ev.id,
      name: ev.name,
      venue_id: venueIdByTm.get(tmVenueId)!,
      starts_at: start?.dateTime ?? null,
      local_date: localDate,
      local_time: start?.localTime ?? null,
      status: ev.dates?.status?.code ?? null,
      url: ev.url ?? null,
      price_min: price?.min ?? null,
      price_max: price?.max ?? null,
      price_currency: price?.currency ?? null,
    });
  }

  const eventIdByTm = new Map<string, string>();
  if (eventInserts.length > 0) {
    const { data, error } = await supabaseAdmin
      .from("events")
      .upsert(eventInserts, { onConflict: "ticketmaster_id" })
      .select("id, ticketmaster_id");
    if (error) {
      throw new IngestionError("upsert-events", "Event upsert failed", error.message);
    }
    for (const row of data ?? []) {
      eventIdByTm.set(row.ticketmaster_id, row.id);
    }
  }
  log(`Upserted ${eventIdByTm.size} events.`);
  if (skippedNoDate > 0) log(`  (skipped ${skippedNoDate} events with no date)`);

  // 4c. Build and bulk-upsert the event_artists join rows.
  //     Dedupe by (event_id, artist_id) so we never send the same pair twice.
  const joinByKey = new Map<
    string,
    { event_id: string; artist_id: string; billing_order: number }
  >();
  for (const ev of kept.values()) {
    const eventId = eventIdByTm.get(ev.id);
    if (!eventId) continue; // event was skipped (no date)
    const attractions = ev._embedded?.attractions ?? [];
    attractions.forEach((a, index) => {
      const artistId = artistIdByTm.get(a.id);
      if (!artistId) return;
      const key = `${eventId}:${artistId}`;
      if (!joinByKey.has(key)) {
        joinByKey.set(key, { event_id: eventId, artist_id: artistId, billing_order: index });
      }
    });
  }

  let linksUpserted = 0;
  if (joinByKey.size > 0) {
    const { data, error } = await supabaseAdmin
      .from("event_artists")
      .upsert([...joinByKey.values()], { onConflict: "event_id,artist_id" })
      .select("event_id");
    if (error) {
      throw new IngestionError(
        "upsert-event-artists",
        "event_artists upsert failed",
        error.message
      );
    }
    linksUpserted = data?.length ?? 0;
  }
  log(`Upserted ${linksUpserted} event_artist links.`);

  // 5. Cleanup: delete events whose start time is more than 24h in the past.
  //    event_artists rows for those events go too, via ON DELETE CASCADE
  //    (see the events_schema migration). Artists are intentionally left alone —
  //    an artist with no remaining events is cheap to keep and may tour again.
  //    Note: rows with a NULL starts_at (date known but not exact time) don't
  //    match this filter and are left in place.
  const staleCutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString();
  const { data: deleted, error: cleanupError } = await supabaseAdmin
    .from("events")
    .delete()
    .lt("starts_at", staleCutoff)
    .select("id");
  if (cleanupError) {
    throw new IngestionError(
      "cleanup-stale-events",
      "Stale-event cleanup failed",
      cleanupError.message
    );
  }
  const staleEventsDeleted = deleted?.length ?? 0;
  log(`${staleEventsDeleted} events cleaned up (started >24h ago).`);

  return {
    venuesTracked: venueIdByTm.size,
    eventsFromTicketmaster: allEvents.length,
    keptAtTrackedVenues: kept.size,
    skippedUntracked,
    skippedNoVenue,
    skippedNoDate,
    artistsUpserted: artistIdByTm.size,
    eventsUpserted: eventIdByTm.size,
    linksUpserted,
    staleEventsDeleted,
  };
}
