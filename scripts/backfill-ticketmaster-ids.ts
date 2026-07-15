// Backfill Ticketmaster venue IDs onto our venues table.
//
// Many of our 74 curated venues exist on Ticketmaster; the ~40 smallest do not.
// This script finds a Ticketmaster ID for each venue by searching its name, and
// records the best match so we can later pull that venue's events. Venues with
// no confident Ticketmaster match keep ticketmaster_id = null (they'll be
// handled by custom scrapers in a future session).
//
// Venue names are ambiguous ("The Broadway" the Bushwick bar vs. the Broadway
// theatre district), so this runs in TWO phases with a human in the loop:
//
//   PHASE 1 — PREVIEW (default):
//     node --env-file=.env.local --import tsx scripts/backfill-ticketmaster-ids.ts
//   Searches Ticketmaster for every venue, scores candidates, and writes a
//   reviewable proposal to data/ticketmaster-venue-matches.json. NO DB WRITES.
//   Review that file: fix any wrong pick (each entry lists all candidates), or
//   set "chosen" to null to skip a venue.
//
//   PHASE 2 — COMMIT:
//     node --env-file=.env.local --import tsx scripts/backfill-ticketmaster-ids.ts --write
//   Reads the (reviewed) proposal file and writes ticketmaster_id onto venues.
//
// It uses the SERVER client (service_role key) so it can write past RLS.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { supabaseAdmin } from "../lib/db/server";
import { searchVenues } from "../lib/ticketmaster/client";
import type { TmVenue } from "../lib/ticketmaster/types";

const PROPOSAL_PATH = path.join(
  process.cwd(),
  "data",
  "ticketmaster-venue-matches.json"
);

type VenueRow = {
  id: string;
  slug: string;
  name: string;
  borough: string;
};

type Confidence = "high" | "medium" | "low" | "none";

type Candidate = {
  ticketmaster_id: string;
  tm_name: string;
  tm_city: string | null;
  tm_state: string | null;
};

type Proposal = {
  slug: string;
  venue_name: string;
  borough: string;
  confidence: Confidence;
  // The match we'll write. Reviewer may edit this (or set to null to skip).
  chosen: string | null;
  // All NY candidates, so a reviewer can swap in a different one by hand.
  candidates: Candidate[];
};

// --- matching helpers -------------------------------------------------------

// Normalize a venue name for comparison: lowercase, drop a leading "the",
// strip punctuation, collapse whitespace. "The Bowery Ballroom" -> "bowery
// ballroom".
function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/['".,&]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function toCandidate(v: TmVenue): Candidate {
  return {
    ticketmaster_id: v.id,
    tm_name: v.name,
    tm_city: v.city?.name ?? null,
    tm_state: v.state?.stateCode ?? null,
  };
}

// Score the Ticketmaster results for one of our venues and pick the best match.
function evaluate(
  venue: VenueRow,
  results: TmVenue[]
): { confidence: Confidence; chosen: string | null; candidates: Candidate[] } {
  // Only trust candidates in New York state — our venues are all NYC.
  const nyResults = results.filter((r) => r.state?.stateCode === "NY");
  const candidates = nyResults.map(toCandidate);

  if (nyResults.length === 0) {
    return { confidence: "none", chosen: null, candidates: [] };
  }

  const target = normalize(venue.name);

  // Prefer an exact normalized-name match.
  const exact = nyResults.find((r) => normalize(r.name) === target);
  if (exact) {
    return { confidence: "high", chosen: exact.id, candidates };
  }

  // Next, a partial match where one name contains the other.
  const partial = nyResults.find((r) => {
    const n = normalize(r.name);
    return n.includes(target) || target.includes(n);
  });
  if (partial) {
    return { confidence: "medium", chosen: partial.id, candidates };
  }

  // Otherwise there are NY candidates but none matches by name well — take the
  // first but flag it low-confidence so the reviewer looks closely.
  return { confidence: "low", chosen: nyResults[0].id, candidates };
}

// --- phase 1: preview -------------------------------------------------------

async function preview() {
  const { data: venues, error } = await supabaseAdmin
    .from("venues")
    .select("id, slug, name, borough")
    .order("name");

  if (error) {
    console.error("Could not read venues:", error.message);
    process.exit(1);
  }

  const rows = (venues ?? []) as VenueRow[];
  console.log(`Searching Ticketmaster for ${rows.length} venues...\n`);

  const proposals: Proposal[] = [];
  for (const venue of rows) {
    // Searching by name alone; the NY-state filter in evaluate() does the
    // geographic narrowing. (Adding the borough to the query tended to hurt
    // recall more than it helped precision.)
    const results = await searchVenues(venue.name);
    const { confidence, chosen, candidates } = evaluate(venue, results);
    proposals.push({
      slug: venue.slug,
      venue_name: venue.name,
      borough: venue.borough,
      confidence,
      chosen,
      candidates,
    });

    const chosenCand = candidates.find((c) => c.ticketmaster_id === chosen);
    const label = chosenCand
      ? `${chosenCand.tm_name} (${chosenCand.tm_city ?? "?"})`
      : "— no match —";
    console.log(
      `[${confidence.padEnd(6)}] ${venue.name.padEnd(32)} -> ${label}`
    );
  }

  writeFileSync(PROPOSAL_PATH, JSON.stringify(proposals, null, 2) + "\n");

  // Summary.
  const byConf = (c: Confidence) =>
    proposals.filter((p) => p.confidence === c).length;
  const matched = proposals.filter((p) => p.chosen !== null).length;
  console.log("\n--- Summary ---");
  console.log(`  high:   ${byConf("high")}`);
  console.log(`  medium: ${byConf("medium")}`);
  console.log(`  low:    ${byConf("low")}   <- review these closely`);
  console.log(`  none:   ${byConf("none")}   (left null, scraped later)`);
  console.log(`\nProposed matches for ${matched} of ${rows.length} venues.`);
  console.log(`\nWrote proposal to ${PROPOSAL_PATH}`);
  console.log(
    "Review it (especially low/medium), then commit with:\n" +
      "  node --env-file=.env.local --import tsx scripts/backfill-ticketmaster-ids.ts --write"
  );
}

// --- phase 2: commit --------------------------------------------------------

async function commit() {
  if (!existsSync(PROPOSAL_PATH)) {
    console.error(
      `No proposal file at ${PROPOSAL_PATH}.\n` +
        "Run the script with no flags first to generate one, then review it."
    );
    process.exit(1);
  }

  const proposals = JSON.parse(readFileSync(PROPOSAL_PATH, "utf8")) as Proposal[];
  const toWrite = proposals.filter((p) => p.chosen !== null);

  console.log(
    `Writing ticketmaster_id for ${toWrite.length} venues (from reviewed proposal)...\n`
  );

  let updated = 0;
  for (const p of toWrite) {
    const { error } = await supabaseAdmin
      .from("venues")
      .update({ ticketmaster_id: p.chosen })
      .eq("slug", p.slug);

    if (error) {
      console.error(`  ✗ ${p.slug}: ${error.message}`);
      continue;
    }
    updated += 1;
    console.log(`  ✓ ${p.slug} -> ${p.chosen}`);
  }

  console.log(
    `\nMatched ${updated} of ${proposals.length} venues on Ticketmaster.`
  );
}

// --- entry ------------------------------------------------------------------

const isWrite = process.argv.includes("--write");
(isWrite ? commit() : preview());
