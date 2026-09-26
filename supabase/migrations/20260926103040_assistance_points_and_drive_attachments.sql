begin;

create table public.assistance_points (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  category text not null check (category in ('shelter', 'food', 'medical', 'transport', 'other')),
  description text not null check (char_length(btrim(description)) between 1 and 500),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  province_code text not null default '25' references public.province_boundaries(province_code) check (province_code = '25'),
  status text not null default 'available' check (status in ('available', 'helped')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index assistance_points_created_at_idx on public.assistance_points(created_at desc);
alter table public.assistance_points enable row level security;
revoke all on public.assistance_points from anon, authenticated;
grant select on public.assistance_points to anon, authenticated;
grant insert (name, category, description, latitude, longitude) on public.assistance_points to authenticated;
grant update (status) on public.assistance_points to authenticated;
create policy assistance_points_read on public.assistance_points for select to anon, authenticated using (true);
create policy assistance_points_create on public.assistance_points for insert to authenticated
  with check (owner_id = (select auth.uid()) and status = 'available');
create policy assistance_points_update on public.assistance_points for update to authenticated
  using (owner_id = (select auth.uid()) or (select auth.jwt()->'app_metadata'->>'role') in ('rescuer', 'admin'))
  with check (owner_id = (select auth.uid()) or (select auth.jwt()->'app_metadata'->>'role') in ('rescuer', 'admin'));

create function public.validate_assistance_point() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' and not exists (
    select 1 from public.province_boundaries b where b.province_code = '25'
    and extensions.st_covers(b.boundary, extensions.st_setsrid(extensions.st_makepoint(new.longitude, new.latitude), 4326))
  ) then raise exception 'outside_prachinburi' using errcode = '23514'; end if;
  if tg_op = 'UPDATE' and (new.id, new.owner_id, new.name, new.category, new.description, new.latitude, new.longitude, new.province_code, new.created_at)
    is distinct from (old.id, old.owner_id, old.name, old.category, old.description, old.latitude, old.longitude, old.province_code, old.created_at) then
    raise exception 'Only assistance status can be updated' using errcode = '42501';
  end if;
  new.updated_at = now();
  return new;
end;
$$;
revoke all on function public.validate_assistance_point() from public, anon, authenticated;
create trigger validate_assistance_point before insert or update on public.assistance_points
  for each row execute function public.validate_assistance_point();
grant all on public.assistance_points to service_role;
commit;
