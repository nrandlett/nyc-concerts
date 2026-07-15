// Ingest the next 7 days of NYC music events from Ticketmaster into our DB.
//
// Run it with:
//   node --env-file=.env.local --import tsx scripts/ingest-events.ts
//
// Pipeline:
//   1. Load our venues that have a ticketmaster_id -> map TM venue id -> our id.
//   2. Pull the next 7 days of NYC (DMA 345) music events from Ticketmaster.
//   3. Keep only events at a venue we track; skip the rest.
//   4. Bulk-upsert artists, then events, then the event_artists join rows.
//
// Upserts make re-running safe: existing rows update in place instead of
// duplicating. It uses the SERVER client (service_role key) to write past RLS.
//
// Depends on the artists/events/event_artists tables from the
// 20260714000000_create_events_schema.sql migration — run that first.

import { supabaseAdmin } from "../lib/db/server";
import {
  getEventsInMetro,
  toTicketmasterDate,
} from "../lib/ticketmaster/client";
import type { TmEvent } from "../lib/ticketmaster/types";

const NYC_DMA_ID = 345;
const DAYS_AHEAD = 7;

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

async function main() {
  // 1. Venue lookup: TM venue id -> our venue uuid.
  const { data: venues, error: venuesError } = await supabaseAdmin
    .from("venues")
    .select("id, name, ticketmaster_id")
    .not("ticketmaster_id", "is", null);

  if (venuesError) {
    console.error("Could not read venues:", venuesError.message);
    process.exit(1);
  }

  const venueIdByTm = new Map<string, string>();
  const venueNameByTm = new Map<string, string>();
  for (const v of venues ?? []) {
    if (v.ticketmaster_id) {
      venueIdByTm.set(v.ticketmaster_id, v.id);
      venueNameByTm.set(v.ticketmaster_id, v.name);
    }
  }
  console.log(`Tracking ${venueIdByTm.size} venues with a Ticketmaster ID.`);

  if (venueIdByTm.size === 0) {
    console.error(
      "No venues have a ticketmaster_id yet. Run backfill-ticketmaster-ids.ts first."
    );
    process.exit(1);
  }

  // 2. Pull events for the next 7 days.
  const now = new Date();
  const end = new Date(now.getTime() + DAYS_AHEAD * 24 * 3600 * 1000);
  console.log(
    `\nFetching NYC music events ${now.toISOString().slice(0, 10)} -> ${end
      .toISOString()
      .slice(0, 10)}...`
  );
  const allEvents = await getEventsInMetro(
    NYC_DMA_ID,
    toTicketmasterDate(now),
    toTicketmasterDate(end)
  );
  console.log(`Ticketmaster returned ${allEvents.length} music events in metro.`);

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
  console.log(
    `Kept ${kept.size} events at tracked venues ` +
      `(skipped ${skippedUntracked} at untracked venues, ${skippedNoVenue} with no venue).`
  );

  if (kept.size === 0) {
    console.log("\nNothing to ingest. Done.");
    return;
  }

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
      console.error("Artist upsert failed:", error.message);
      process.exit(1);
    }
    for (const row of data ?? []) {
      if (row.ticketmaster_id) artistIdByTm.set(row.ticketmaster_id, row.id);
    }
  }
  console.log(`\nUpserted ${artistIdByTm.size} artists.`);

  // 4b. Build and bulk-upsert event rows.
  const eventInserts: EventInsert[] = [];
  let skippedNoDate = 0;
  for (const ev of kept.values()) {
    const start = ev.dates?.start;
    // local_date is NOT NULL in our schema; derive from dateTime if needed.
    const localDate =
      start?.localDate ??
      (start?.dateTime ? start.dateTime.slice(0, 10) : null);
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
      console.error("Event upsert failed:", error.message);
      process.exit(1);
    }
    for (const row of data ?? []) {
      eventIdByTm.set(row.ticketmaster_id, row.id);
    }
  }
  console.log(`Upserted ${eventIdByTm.size} events.`);
  if (skippedNoDate > 0) {
    console.log(`  (skipped ${skippedNoDate} events with no date)`);
  }

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
        joinByKey.set(key, {
          event_id: eventId,
          artist_id: artistId,
          billing_order: index,
        });
      }
    });
  }

  let joinCount = 0;
  if (joinByKey.size > 0) {
    const { data, error } = await supabaseAdmin
      .from("event_artists")
      .upsert([...joinByKey.values()], { onConflict: "event_id,artist_id" })
      .select("event_id");
    if (error) {
      console.error("event_artists upsert failed:", error.message);
      process.exit(1);
    }
    joinCount = data?.length ?? 0;
  }
  console.log(`Upserted ${joinCount} event_artist links.`);

  // --- summary --------------------------------------------------------------
  console.log("\n--- Ingestion summary ---");
  console.log(`  events from Ticketmaster:  ${allEvents.length}`);
  console.log(`  at tracked venues:         ${kept.size}`);
  console.log(`  events upserted:           ${eventIdByTm.size}`);
  console.log(`  artists upserted:          ${artistIdByTm.size}`);
  console.log(`  event_artist links:        ${joinCount}`);
}

main();
