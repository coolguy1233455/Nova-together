-- Passkey devices (2026-11-06): a phone or computer that asked to come in with a passkey from the
-- essay (lib/passkey.js). Each row is one passkey: its public key (the private half never leaves
-- the device), who it says it belongs to, and whether the admin approved it. Only an approved
-- device opens Nova, and only while its email is allowed and not banned or kicked.
-- Its own small function, public.nova_passkey(), with the same key check as public.nova(); the
-- twin site has mf_passkeys / mf_passkey() with its own key (perl s/\bnova_/mf_/g and swap the hash).
create table if not exists public.nova_passkeys (
  id text primary key,                 -- the credential id (base64url)
  email text not null,
  name text not null default '',
  device text not null default '',
  alg integer not null,                -- COSE algorithm: -7 ES256, -8 Ed25519, -257 RS256
  spki text not null,                  -- public key, SubjectPublicKeyInfo DER, base64url
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  sign_count bigint not null default 0,
  created_at timestamptz not null default now(),
  answered_by text,
  answered_at timestamptz,
  last_used timestamptz
);
alter table public.nova_passkeys enable row level security;

create or replace function public.nova_passkey(k text, op text, a jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  r jsonb;
begin
  if k is null or encode(sha256(convert_to(k, 'UTF8')), 'hex') <> '1c3de736e4e8c431cd2d375684f194dc72cf9a0c4a9854896a1470334e518970' then
    raise exception 'denied' using errcode = '42501';
  end if;
  if op = 'add' then
    if (select count(*) from public.nova_passkeys where status = 'pending') >= 100 then
      return jsonb_build_object('full', true);
    end if;
    insert into public.nova_passkeys (id, email, name, device, alg, spki)
      values (a->>'id', lower(a->>'email'), left(coalesce(a->>'name', ''), 40), left(coalesce(a->>'device', ''), 60), (a->>'alg')::int, a->>'spki')
      on conflict (id) do nothing;
    return jsonb_build_object('ok', found);
  elsif op = 'get' then
    select to_jsonb(p) into r from public.nova_passkeys p where p.id = a->>'id';
    return coalesce(r, '{}'::jsonb);
  elsif op = 'used' then
    update public.nova_passkeys set sign_count = greatest(sign_count, coalesce((a->>'count')::bigint, 0)), last_used = now() where id = a->>'id';
    return jsonb_build_object('ok', found);
  elsif op = 'list' then
    return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'email', p.email, 'name', p.name, 'device', p.device, 'status', p.status,
      'at', p.created_at, 'answeredAt', p.answered_at, 'lastUsed', p.last_used) order by p.created_at desc) from public.nova_passkeys p), '[]'::jsonb);
  elsif op = 'answer' then
    if a->>'status' not in ('approved', 'denied') then raise exception 'bad status'; end if;
    update public.nova_passkeys set status = a->>'status', answered_by = a->>'by', answered_at = now() where id = a->>'id';
    return jsonb_build_object('ok', found);
  elsif op = 'remove' then
    delete from public.nova_passkeys where id = a->>'id';
    return jsonb_build_object('ok', found);
  end if;
  raise exception 'unknown op %', op;
end;
$function$;
revoke all on function public.nova_passkey(text, text, jsonb) from public, authenticated;
grant execute on function public.nova_passkey(text, text, jsonb) to anon;
