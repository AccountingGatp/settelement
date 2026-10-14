-- Run once in Supabase: SQL Editor -> New query -> paste -> Run
create table if not exists public.kv (
  key text primary key,
  value jsonb,
  expires_at timestamptz
);
-- Only the server (service key) may read or write. No public access.
alter table public.kv enable row level security;
