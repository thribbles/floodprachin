begin;

alter table public.assistance_points drop constraint if exists assistance_points_status_check;
alter table public.assistance_points add constraint assistance_points_status_check
  check (status in ('available', 'unavailable', 'depleted', 'closed'));

commit;
