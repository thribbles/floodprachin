grant update (type, description, people, status, helped_by) on public.flood_reports to authenticated;
grant delete on public.flood_reports to authenticated;
grant update (name, category, description, status) on public.assistance_points to authenticated;
grant delete on public.assistance_points to authenticated;

drop policy if exists reports_delete on public.flood_reports;
create policy reports_delete on public.flood_reports for delete to authenticated
  using (owner_id = (select auth.uid()) or (select auth.jwt()->'app_metadata'->>'role') in ('rescuer', 'admin'));

drop policy if exists assistance_points_delete on public.assistance_points;
create policy assistance_points_delete on public.assistance_points for delete to authenticated
  using (owner_id = (select auth.uid()) or (select auth.jwt()->'app_metadata'->>'role') in ('rescuer', 'admin'));

create or replace function public.validate_flood_report() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' and not exists (
    select 1 from public.province_boundaries b where b.province_code = '25'
    and extensions.st_covers(b.boundary, extensions.st_setsrid(extensions.st_makepoint(new.longitude, new.latitude), 4326))
  ) then raise exception 'outside_prachinburi' using errcode = '23514'; end if;
  if tg_op = 'UPDATE' and (new.id, new.owner_id, new.latitude, new.longitude, new.province_code, new.created_at)
    is distinct from (old.id, old.owner_id, old.latitude, old.longitude, old.province_code, old.created_at) then
    raise exception 'Only report content and status can be updated' using errcode = '42501';
  end if;
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.validate_assistance_point() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' and not exists (
    select 1 from public.province_boundaries b where b.province_code = '25'
    and extensions.st_covers(b.boundary, extensions.st_setsrid(extensions.st_makepoint(new.longitude, new.latitude), 4326))
  ) then raise exception 'outside_prachinburi' using errcode = '23514'; end if;
  if tg_op = 'UPDATE' and (new.id, new.owner_id, new.latitude, new.longitude, new.province_code, new.created_at)
    is distinct from (old.id, old.owner_id, old.latitude, old.longitude, old.province_code, old.created_at) then
    raise exception 'Only assistance content and status can be updated' using errcode = '42501';
  end if;
  new.updated_at = now();
  return new;
end;
$$;
