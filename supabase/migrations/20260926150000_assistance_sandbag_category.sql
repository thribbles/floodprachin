begin;

alter table public.assistance_points drop constraint if exists assistance_points_category_check;
alter table public.assistance_points add constraint assistance_points_category_check
  check (category in ('shelter', 'food', 'medical', 'transport', 'sandbag', 'other'));

update public.assistance_points
  set category = 'sandbag'
  where name ilike '%ทราย%' or name ilike '%กระสอบ%' or description ilike '%ทราย%' or description ilike '%กระสอบ%';

commit;
