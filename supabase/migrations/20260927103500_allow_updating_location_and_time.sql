-- Grant update permissions for new fields
grant update (latitude, longitude, created_at, attachment_path) on public.flood_reports to authenticated;
grant update (latitude, longitude, created_at, attachment_path) on public.assistance_points to authenticated;

-- Update trigger for flood_reports to allow location and created_at updates
create or replace function public.validate_flood_report() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' and not exists (
    select 1 from public.province_boundaries b where b.province_code = '25'
    and extensions.st_covers(b.boundary, extensions.st_setsrid(extensions.st_makepoint(new.longitude, new.latitude), 4326))
  ) then raise exception 'outside_prachinburi' using errcode = '23514'; end if;
  
  if tg_op = 'UPDATE' and (new.id, new.owner_id, new.province_code)
    is distinct from (old.id, old.owner_id, old.province_code) then
    raise exception 'Cannot update id, owner_id, or province_code' using errcode = '42501';
  end if;
  
  new.updated_at = now();
  return new;
end;
$$;

-- Update trigger for assistance_points to allow location and created_at updates
create or replace function public.validate_assistance_point() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' and not exists (
    select 1 from public.province_boundaries b where b.province_code = '25'
    and extensions.st_covers(b.boundary, extensions.st_setsrid(extensions.st_makepoint(new.longitude, new.latitude), 4326))
  ) then raise exception 'outside_prachinburi' using errcode = '23514'; end if;
  
  if tg_op = 'UPDATE' and (new.id, new.owner_id, new.province_code)
    is distinct from (old.id, old.owner_id, old.province_code) then
    raise exception 'Cannot update id, owner_id, or province_code' using errcode = '42501';
  end if;
  
  new.updated_at = now();
  return new;
end;
$$;

-- Ensure 'staff' role is also allowed in policies
drop policy if exists reports_update on public.flood_reports;
create policy reports_update on public.flood_reports for update to authenticated
  using (owner_id = (select auth.uid()) or (select auth.jwt()->'app_metadata'->>'role') in ('rescuer', 'admin', 'staff'))
  with check (owner_id = (select auth.uid()) or (select auth.jwt()->'app_metadata'->>'role') in ('rescuer', 'admin', 'staff'));

drop policy if exists assistance_points_update on public.assistance_points;
create policy assistance_points_update on public.assistance_points for update to authenticated
  using (owner_id = (select auth.uid()) or (select auth.jwt()->'app_metadata'->>'role') in ('rescuer', 'admin', 'staff'))
  with check (owner_id = (select auth.uid()) or (select auth.jwt()->'app_metadata'->>'role') in ('rescuer', 'admin', 'staff'));

drop policy if exists reports_delete on public.flood_reports;
create policy reports_delete on public.flood_reports for delete to authenticated
  using (owner_id = (select auth.uid()) or (select auth.jwt()->'app_metadata'->>'role') in ('rescuer', 'admin', 'staff'));

drop policy if exists assistance_points_delete on public.assistance_points;
create policy assistance_points_delete on public.assistance_points for delete to authenticated
  using (owner_id = (select auth.uid()) or (select auth.jwt()->'app_metadata'->>'role') in ('rescuer', 'admin', 'staff'));
