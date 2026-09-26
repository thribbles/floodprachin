begin;

-- Allow anon and authenticated to create assistance points with or without owner_id
drop policy if exists assistance_points_create on public.assistance_points;
create policy assistance_points_create on public.assistance_points for insert to anon, authenticated
  with check (
    ((auth.uid() is null and owner_id is null) or owner_id = (select auth.uid()))
    and status in ('available', 'unavailable', 'depleted', 'closed')
  );

grant insert on public.assistance_points to anon, authenticated;

commit;
