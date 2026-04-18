-- Run this in Supabase SQL editor

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  age integer,
  height_cm numeric,
  sex text,
  target_weight numeric,
  updated_at timestamptz not null default now()
);

create table if not exists public.entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entry_date date not null,
  weight numeric not null check (weight > 0),
  calories integer,
  steps integer check (steps >= 0),
  updated_at timestamptz not null default now(),
  unique (user_id, entry_date)
);

create table if not exists public.step_ingest_tokens (
  user_id uuid primary key references auth.users(id) on delete cascade,
  token text not null unique,
  is_active boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.entries add column if not exists steps integer check (steps >= 0);

alter table public.profiles enable row level security;
alter table public.entries enable row level security;
alter table public.step_ingest_tokens enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
drop policy if exists "profiles_insert_own" on public.profiles;
drop policy if exists "profiles_update_own" on public.profiles;
drop policy if exists "entries_select_own" on public.entries;
drop policy if exists "entries_insert_own" on public.entries;
drop policy if exists "entries_update_own" on public.entries;
drop policy if exists "entries_delete_own" on public.entries;
drop policy if exists "step_tokens_select_own" on public.step_ingest_tokens;

create policy "profiles_select_own"
  on public.profiles for select
  to authenticated
  using (auth.uid() = user_id);

create policy "profiles_insert_own"
  on public.profiles for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "entries_select_own"
  on public.entries for select
  to authenticated
  using (auth.uid() = user_id);

create policy "entries_insert_own"
  on public.entries for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "entries_update_own"
  on public.entries for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "entries_delete_own"
  on public.entries for delete
  to authenticated
  using (auth.uid() = user_id);

create policy "step_tokens_select_own"
  on public.step_ingest_tokens for select
  to authenticated
  using (auth.uid() = user_id);
