// Single Supabase client for auth (email OTP) + saved season history.
//
// The anon key is SAFE to expose in the browser — it's the public key, and all
// data is protected by row-level security (see supabase/schema.sql). Configured
// via Vite env vars (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).
//
// `authEnabled` lets the whole app run as a pure guest experience when the keys
// aren't set (e.g. a local checkout without .env.local) instead of crashing —
// login is optional by design.
import { createClient } from "@supabase/supabase-js";

const url  = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const authEnabled = Boolean(url && anon);
export const supabase = authEnabled ? createClient(url, anon) : null;
