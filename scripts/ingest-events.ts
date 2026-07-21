// CLI entry point for the ingestion pipeline.
//
// Run it with:
//   npm run ingest:events
//   (= node --env-file=.env.local --import tsx scripts/ingest-events.ts)
//
// The actual pipeline lives in lib/ingestion so this CLI and the Vercel Cron
// API route (app/api/cron/ingest/route.ts) run the exact same code. This file
// just wires up console logging, prints a summary, and sets the exit code —
// the things a command-line run wants but a serverless request does not.

import { runIngestion, IngestionError } from "../lib/ingestion";

async function main() {
  try {
    const result = await runIngestion((msg) => console.log(msg));

    console.log("\n--- Ingestion summary ---");
    console.log(`  events from Ticketmaster:  ${result.eventsFromTicketmaster}`);
    console.log(`  at tracked venues:         ${result.keptAtTrackedVenues}`);
    console.log(`  events upserted:           ${result.eventsUpserted}`);
    console.log(`  artists upserted:          ${result.artistsUpserted}`);
    console.log(`  event_artist links:        ${result.linksUpserted}`);
    console.log(`  stale events cleaned up:   ${result.staleEventsDeleted}`);
  } catch (err) {
    if (err instanceof IngestionError) {
      console.error(`\n✗ Ingestion failed at step "${err.step}": ${err.message}`);
      if (err.detail) console.error(`  detail: ${err.detail}`);
    } else {
      console.error("\n✗ Ingestion failed:", err);
    }
    process.exit(1);
  }
}

main();
