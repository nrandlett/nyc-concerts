// One-time seed script: loads data/venues.json and upserts every venue into the
// Supabase `venues` table.
//
// Run it with:  npm run seed:venues
// (that command loads .env.local and runs this file through tsx)
//
// It uses the SERVER client (service_role key), so it can write even though RLS
// blocks the public anon key. Upserting on `slug` means re-running is safe: it
// updates existing rows instead of creating duplicates.

import { readFileSync } from "node:fs";
import path from "node:path";
import { supabaseAdmin } from "../lib/db/server";

type Venue = {
  slug: string;
  name: string;
  borough: string;
  neighborhood: string;
  capacity_tier: string;
  website_url: string | null;
  ticketmaster_id: string | null;
  vibes: string[];
  notes: string | null;
};

const dataPath = path.join(process.cwd(), "data", "venues.json");
const venues = JSON.parse(readFileSync(dataPath, "utf8")) as Venue[];

async function main() {
  console.log(`Read ${venues.length} venues from ${dataPath}`);

  const { data, error } = await supabaseAdmin
    .from("venues")
    .upsert(venues, { onConflict: "slug" })
    .select("id");

  if (error) {
    console.error("\n✗ Seed failed:", error.message);
    process.exit(1);
  }

  console.log(`✓ Upserted ${data?.length ?? 0} venues.`);

  // Confirm the total now in the table.
  const { count, error: countError } = await supabaseAdmin
    .from("venues")
    .select("*", { count: "exact", head: true });

  if (countError) {
    console.error("Seeded, but could not read back count:", countError.message);
    process.exit(1);
  }

  console.log(`Total venues in table: ${count}`);
}

main();
