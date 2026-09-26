begin;
drop function if exists public.submit_flood_report(text, text, double precision, double precision, integer, text);
create function public.submit_flood_report(p_type text, p_description text, p_latitude double precision,
  p_longitude double precision, p_people integer default null, p_phone text default null) returns uuid
language plpgsql security invoker set search_path = '' as $$
begin
  return public.submit_flood_report(p_type, p_description, p_latitude, p_longitude, p_people, p_phone, null);
end;
$$;
revoke all on function public.submit_flood_report(text, text, double precision, double precision, integer, text) from public, anon, authenticated;
grant execute on function public.submit_flood_report(text, text, double precision, double precision, integer, text) to anon, authenticated;
commit;
