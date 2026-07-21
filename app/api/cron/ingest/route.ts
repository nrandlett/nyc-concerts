// Vercel Cron entry point for the ingestion pipeline.
//
// Vercel Cron runs jobs by making an HTTP request to a URL on a schedule (see
// vercel.json). So the "job" is just this route: a daily GET to
// /api/cron/ingest triggers the same runIngestion() the CLI uses.
//
// Security model — why the secret matters even though only Vercel Cron is meant
// to call this:
//   * This endpoint is a public HTTPS URL. Anyone who guesses the path can hit
//     it. Without a gate, a stranger (or a bot crawling for /api/cron/*) could
//     trigger our ingestion at will — burning Ticketmaster API quota, running
//     up Supabase writes, and hammering our function minutes.
//   * So we require a shared secret. When CRON_SECRET is set as a Vercel env
//     var, Vercel Cron automatically attaches it as "Authorization: Bearer
//     <secret>" on every scheduled request. We compare that header to our env
//     var; anything that doesn't match gets a 401 and does no work.
//   * The secret lives only in env vars (Vercel + .env.local), never in the URL
//     or the client bundle, so it isn't exposed to browsers or logs.
//   * The comparison is constant-time (timingSafeEqual) so an attacker can't
//     recover the secret byte-by-byte by measuring how long a wrong guess takes.

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runIngestion, IngestionError } from "../../../../lib/ingestion";

// This route needs the Node.js runtime (not Edge): it uses the Supabase
// service-role client and node:crypto. force-dynamic keeps it from being cached
// or statically evaluated at build time. maxDuration gives the throttled
// Ticketmaster paging room to finish well within the serverless limit.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Constant-time string compare that never throws on length mismatch. */
function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual requires equal-length buffers; unequal length => no match,
  // and we still burn a compare against `a` itself to keep timing uniform.
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export async function GET(request: Request): Promise<Response> {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    // Misconfiguration, not an attack: refuse rather than run wide open.
    console.error("[cron/ingest] CRON_SECRET is not set; refusing to run.");
    return NextResponse.json(
      { ok: false, error: "Server not configured" },
      { status: 500 }
    );
  }

  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : "";
  if (!token || !secretsMatch(token, cronSecret)) {
    console.warn("[cron/ingest] Rejected request with missing/invalid bearer token.");
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  console.log("[cron/ingest] Starting ingestion run.");

  try {
    // Forward pipeline progress into the function logs with a stable prefix so
    // it's easy to find in the Vercel dashboard.
    const result = await runIngestion((msg) => console.log(`[cron/ingest] ${msg}`));
    const durationMs = Date.now() - startedAt;

    console.log(
      `[cron/ingest] Success in ${durationMs}ms — ` +
        `events=${result.eventsUpserted} artists=${result.artistsUpserted} ` +
        `links=${result.linksUpserted} cleaned=${result.staleEventsDeleted}`
    );

    return NextResponse.json({ ok: true, durationMs, result });
  } catch (err) {
    const durationMs = Date.now() - startedAt;

    if (err instanceof IngestionError) {
      // Log rich, structured context. This is what shows up in the Vercel
      // failure email / function logs, so make it diagnosable at a glance:
      // which step broke and what the upstream API/DB actually returned.
      console.error(
        `[cron/ingest] FAILED at step "${err.step}" after ${durationMs}ms: ${err.message}` +
          (err.detail ? `\n  detail: ${err.detail}` : "")
      );
      return NextResponse.json(
        { ok: false, step: err.step, error: err.message, detail: err.detail ?? null },
        { status: 500 }
      );
    }

    // Unexpected error (bug, network blip, etc.) — log the whole thing.
    console.error(`[cron/ingest] FAILED (unexpected) after ${durationMs}ms:`, err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
