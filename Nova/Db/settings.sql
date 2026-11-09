-- Site settings the admin changes in the admin panel (2026-11-06): for now only "entrance",
-- the essay word that starts the Google sign-in ({word, section}). Its own small function,
-- public.nova_setting(), with the same key check as public.nova(); the twin site has
-- mf_settings / mf_setting() with its own key (perl s/\bnova_/mf_/g and swap the hash).
create table if not exists public.nova_settings (key text primary key, value jsonb not null, by text, updated_at timestamptz not null default now());
alter table public.nova_settings enable row level security;

create or replace function public.nova_setting(k text, key text, val jsonb default null, by text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if k is null or encode(sha256(convert_to(k, 'UTF8')), 'hex') <> '1c3de736e4e8c431cd2d375684f194dc72cf9a0c4a9854896a1470334e518970' then
    raise exception 'denied' using errcode = '42501';
  end if;
  if val is not null then
    insert into public.nova_settings as s (key, value, by) values (key, val, by)
      on conflict (key) do update set value = excluded.value, by = excluded.by, updated_at = now();
  end if;
  return coalesce((select jsonb_build_object('value', s.value, 'by', s.by, 'at', s.updated_at) from public.nova_settings s where s.key = nova_setting.key), '{}'::jsonb);
end;
$function$;
revoke all on function public.nova_setting(text, text, jsonb, text) from public, authenticated;
grant execute on function public.nova_setting(text, text, jsonb, text) to anon;
