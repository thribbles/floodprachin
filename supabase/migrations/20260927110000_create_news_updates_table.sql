-- Create news_updates table for staff announcements and alerts
create table if not exists public.news_updates (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  url text not null,
  source text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

alter table public.news_updates enable row level security;

-- Everyone can read news updates
drop policy if exists news_select_all on public.news_updates;
create policy news_select_all on public.news_updates
  for select to public
  using (true);

-- Authenticated staff/rescuers/admins can insert news
drop policy if exists news_insert_staff on public.news_updates;
create policy news_insert_staff on public.news_updates
  for insert to authenticated
  with check ((select auth.jwt()->'app_metadata'->>'role') in ('rescuer', 'admin', 'staff') or auth.uid() is not null);

-- Authenticated staff/rescuers/admins can delete news
drop policy if exists news_delete_staff on public.news_updates;
create policy news_delete_staff on public.news_updates
  for delete to authenticated
  using ((select auth.jwt()->'app_metadata'->>'role') in ('rescuer', 'admin', 'staff') or auth.uid() is not null);

grant select on public.news_updates to anon, authenticated;
grant insert, delete on public.news_updates to authenticated;
