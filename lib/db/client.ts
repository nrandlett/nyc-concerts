import { createClient } from "@supabase/supabase-js";

// Browser-safe Supabase client.
//
// Uses the PUBLIC "anon" key. This is safe to ship to the browser because every
// query it makes is still filtered by Postgres Row Level Security (RLS) policies
// we define in the database. Both values are exposed to the browser via the
// NEXT_PUBLIC_ prefix.
//
// Use this in React components / client-side code (e.g. reading concert listings).

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
      "Check your .env.local file."
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
