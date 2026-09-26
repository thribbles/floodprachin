begin;

alter table public.flood_reports alter column owner_id drop not null;
alter table public.flood_reports add column if not exists attachment_path text check (attachment_path is null or char_length(attachment_path) <= 300);
drop policy if exists reports_create on public.flood_reports;
create policy reports_create on public.flood_reports for insert to anon, authenticated
  with check ((auth.uid() is null and owner_id is null) or owner_id = (select auth.uid()));
grant insert (type, description, people, latitude, longitude, attachment_path) on public.flood_reports to anon, authenticated;

drop policy if exists contacts_create on public.report_contacts;
create policy contacts_create on public.report_contacts for insert to anon, authenticated
  with check (auth.uid() is null and exists (select 1 from public.flood_reports r where r.id = report_id and r.owner_id is null)
    or exists (select 1 from public.flood_reports r where r.id = report_id and r.owner_id = (select auth.uid())));
grant insert on public.report_contacts to anon;

create or replace function public.submit_flood_report(p_type text, p_description text, p_latitude double precision,
  p_longitude double precision, p_people integer default null, p_phone text default null, p_attachment_path text default null) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare report_id uuid;
begin
  insert into public.flood_reports(type, description, latitude, longitude, people, attachment_path)
    values(p_type, btrim(p_description), p_latitude, p_longitude, p_people, nullif(btrim(p_attachment_path), '')) returning id into report_id;
  if nullif(btrim(p_phone), '') is not null then
    insert into public.report_contacts(report_id, phone) values(report_id, btrim(p_phone));
  end if;
  return report_id;
end;
$$;
revoke all on function public.submit_flood_report(text, text, double precision, double precision, integer, text) from public, anon, authenticated;
revoke all on function public.submit_flood_report(text, text, double precision, double precision, integer, text, text) from public, anon, authenticated;
grant execute on function public.submit_flood_report(text, text, double precision, double precision, integer, text, text) to anon, authenticated;

alter table public.assistance_points alter column owner_id drop not null;
alter table public.assistance_points add column if not exists attachment_path text check (attachment_path is null or char_length(attachment_path) <= 300);
drop policy if exists assistance_points_create on public.assistance_points;
create policy assistance_points_create on public.assistance_points for insert to anon, authenticated
  with check ((auth.uid() is null and owner_id is null) or owner_id = (select auth.uid()));
grant insert (name, category, description, latitude, longitude, attachment_path) on public.assistance_points to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('flood-attachments', 'flood-attachments', true, 5242880, array['image/jpeg','image/png','image/webp']::text[])
on conflict (id) do update set public = true, file_size_limit = 5242880, allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists flood_attachments_public_read on storage.objects;
create policy flood_attachments_public_read on storage.objects for select to anon, authenticated
  using (bucket_id = 'flood-attachments');
drop policy if exists flood_attachments_public_upload on storage.objects;
create policy flood_attachments_public_upload on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'flood-attachments');

commit;
