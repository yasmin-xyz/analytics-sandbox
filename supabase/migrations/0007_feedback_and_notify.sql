-- Feedback form submissions and "notify me" email signups (see
-- app/api/feedback/route.ts and app/api/notify-signup/route.ts).
--
-- Written idempotently (IF NOT EXISTS) since these tables were already
-- created directly against the live project before this file was
-- committed to the repo — this just brings the migration history back
-- in sync with what's actually deployed.

create table if not exists public.feedback_submissions (
  id bigint generated always as identity primary key,
  name text,
  email text,
  category text not null,
  message text not null,
  client_ip text,
  created_at timestamptz not null default now()
);

create table if not exists public.event_notify_signups (
  id bigint generated always as identity primary key,
  email text not null,
  client_ip text,
  created_at timestamptz not null default now(),
  -- Set once a "next event data is live" email has actually been sent for
  -- this signup, so a future send job can select only rows still pending
  -- (and never re-notify the same address).
  notified_at timestamptz
);

-- Same posture as the other tables in 0003_enable_rls.sql: the browser
-- never talks to Supabase directly, every read/write goes through a
-- Next.js API route using the service-role client (which bypasses RLS) —
-- so RLS-enabled-with-no-policies just closes off the direct public-Data-
-- API path these tables have no legitimate use for.
alter table public.feedback_submissions enable row level security;
alter table public.event_notify_signups enable row level security;

drop policy if exists "public read" on public.feedback_submissions;
drop policy if exists "public read" on public.event_notify_signups;
