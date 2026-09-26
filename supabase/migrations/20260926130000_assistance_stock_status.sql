begin;

-- จุดช่วยเหลือใช้สถานะสิ่งของแทนสถานะการช่วยเหลือ
update public.assistance_points set status = 'depleted' where status = 'helped';
alter table public.assistance_points drop constraint if exists assistance_points_status_check;
alter table public.assistance_points add constraint assistance_points_status_check
  check (status in ('available', 'unavailable', 'depleted'));
alter table public.assistance_points alter column status set default 'available';

-- ผู้แจ้งเลือกสถานะเริ่มต้นได้ และเจ้าหน้าที่แก้ไขสถานะได้
grant insert (name, category, description, latitude, longitude, status) on public.assistance_points to authenticated;
grant update (name, category, description, status) on public.assistance_points to authenticated;

drop policy if exists assistance_points_create on public.assistance_points;
create policy assistance_points_create on public.assistance_points for insert to authenticated
  with check (owner_id = (select auth.uid()) and status in ('available', 'unavailable', 'depleted'));

commit;
