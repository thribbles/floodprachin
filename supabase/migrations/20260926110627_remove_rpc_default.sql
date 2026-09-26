begin;
drop function if exists public.submit_flood_report(text, text, double precision, double precision, integer, text, text);
create function public.submit_flood_report(p_type text, p_description text, p_latitude double precision,
  p_longitude double precision, p_people integer, p_phone text, p_attachment_path text) returns uuid
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
revoke all on function public.submit_flood_report(text, text, double precision, double precision, integer, text, text) from public, anon, authenticated;
grant execute on function public.submit_flood_report(text, text, double precision, double precision, integer, text, text) to anon, authenticated;
commit;
