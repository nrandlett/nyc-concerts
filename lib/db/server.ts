import { createClient } from "@supabase/supabase-js";

// SERVER-ONLY Supabase client.
//
// Uses the service_role key, which BYPASSES Row Level Security and has full
// read/write access to every table. It must NEVER reach the browser.
//
// Two things keep it safe:
//   1. SUPABASE_SERVICE_ROLE_KEY has no NEXT_PUBLIC_ prefix, so Next.js will not
//      expose it to client bundles. If a browser file imported this, the key
//      would simply be undefined there.
//   2. We only import this from trusted server-side code: seed scripts, the
//      daily refresh job, and server-side route handlers.
//
// The project URL is read from the same NEXT_PUBLIC_ var the browser client uses
// (a URL is not a secret); only the KEY differs.

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. " +
      "Check your .env.local file."
  );
}

export const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
  // Scripts are stateless — no need to persist or refresh auth sessions.
  auth: { persistSession: false, autoRefreshToken: false },
});
