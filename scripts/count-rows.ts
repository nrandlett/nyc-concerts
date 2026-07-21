// Quick DB row-count snapshot for the idempotency audit.
//
// Prints exact counts of events, artists, and event_artists so we can compare
// the database state before / between / after ingestion runs.
//
//   node --env-file=.env.local --import tsx scripts/count-rows.ts [label]

import { supabaseAdmin } from "../lib/db/server";

async function count(table: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from(table)
    .select("*", { count: "exact", head: true });
  if (error) {
    console.error(`  count(${table}) failed: ${error.message}`);
    process.exit(1);
  }
  return count ?? 0;
}

async function main() {
  const label = process.argv[2] ?? "";
  const [events, artists, links] = await Promise.all([
    count("events"),
    count("artists"),
    count("event_artists"),
  ]);
  console.log(
    `${label ? `[${label}] ` : ""}events=${events}  artists=${artists}  event_artists=${links}`
  );
}

main();
