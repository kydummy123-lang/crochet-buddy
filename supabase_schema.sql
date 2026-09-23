-- Crochet Buddy cloud sync + image storage
-- Run this once in Supabase > SQL Editor.

create table if not exists public.user_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_data enable row level security;

drop policy if exists "Users can read their own Crochet Buddy data" on public.user_data;
drop policy if exists "Users can insert their own Crochet Buddy data" on public.user_data;
drop policy if exists "Users can update their own Crochet Buddy data" on public.user_data;
drop policy if exists "Users can delete their own Crochet Buddy data" on public.user_data;

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

-- Image storage for pattern covers, round screenshots, and Learn photos.
-- The bucket is public so the app can display image URLs on every device.
-- Upload/update/delete are still restricted to the signed-in user's own folder.
insert into storage.buckets (id, name, public)
values ('crochet-images', 'crochet-images', true)
on conflict (id) do update set public = true;

drop policy if exists "Crochet Buddy users can upload images" on storage.objects;
drop policy if exists "Crochet Buddy users can update images" on storage.objects;
drop policy if exists "Crochet Buddy users can delete images" on storage.objects;

create policy "Crochet Buddy users can upload images"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'crochet-images'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "Crochet Buddy users can update images"
on storage.objects for update
to authenticated
using (
  bucket_id = 'crochet-images'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'crochet-images'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "Crochet Buddy users can delete images"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'crochet-images'
  and (storage.foldername(name))[1] = auth.uid()::text
);
