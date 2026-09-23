-- Crochet Buddy cloud sync
-- Run this once in Supabase > SQL Editor.

create table if not exists public.user_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_data enable row level security;

create policy "Users can read their own Crochet Buddy data"
on public.user_data for select
to authenticated
using (auth.uid() = user_id);

create policy "Users can insert their own Crochet Buddy data"
on public.user_data for insert
to authenticated
with check (auth.uid() = user_id);

create policy "Users can update their own Crochet Buddy data"
on public.user_data for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "Users can delete their own Crochet Buddy data"
on public.user_data for delete
to authenticated
using (auth.uid() = user_id);
