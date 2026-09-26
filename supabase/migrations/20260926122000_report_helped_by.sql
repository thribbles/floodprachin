alter table public.flood_reports
  add column if not exists helped_by text check (helped_by is null or char_length(btrim(helped_by)) between 1 and 120);

grant update (status, helped_by) on public.flood_reports to authenticated;
