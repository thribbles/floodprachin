begin;

-- Allow anon to insert status column on assistance_points
grant insert (status) on public.assistance_points to anon;
grant insert on public.assistance_points to anon;

commit;
