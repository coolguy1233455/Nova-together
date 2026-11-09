-- 2026-11-07 chat extras, for nova (brezmerch) and mf (mathisfuns): anonymous messages in the
-- members chat (only the admin can look up who sent one, op msg-who), "is typing" (nova_typing,
-- returned by ping for 6 seconds), and update requests the admin can approve or deny (status),
-- which their sender sees (op my-suggestions). Patches nova()/mf() in place by anchors.
do $mig$
declare
  p text;
  def text;
  fn oid;
  anchors text[];
  repls text[];
  i int;
  a text;
  b text;
begin
  foreach p in array array['nova', 'mf'] loop
    execute format('alter table public.%I_messages add column if not exists anon boolean not null default false', p);
    execute format('create table if not exists public.%I_typing (email text primary key, room text not null, anon boolean not null default false, at timestamptz not null default now())', p);
    execute format('alter table public.%I_typing enable row level security', p);
    execute format('alter table public.%I_suggestions add column if not exists status text not null default ''new''', p);
    execute format('alter table public.%I_suggestions add column if not exists answered_at timestamptz', p);

    execute replace($f$
create or replace function public.nova_msg(m public.nova_messages, viewer text)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('id', m.id, 'rev', m.rev, 'room', m.room, 'email', m.email, 'anon', m.anon,
    'name', (select u.name from public.nova_users u where u.email = m.email),
    'avatar', (select u.avatar_v from public.nova_users u where u.email = m.email),
    'body', m.body, 'deleted', m.deleted, 'created_at', m.created_at, 'image', m.image,
    'reply', (select jsonb_build_object('id', q.id, 'email', q.email, 'anon', q.anon, 'body', left(q.body, 140), 'image', q.image is not null,
                       'name', (select u.name from public.nova_users u where u.email = q.email))
                from public.nova_messages q where q.id = m.reply_to and not q.deleted),
    'likes', (select count(*) from public.nova_likes l where l.message_id = m.id),
    'liked', exists (select 1 from public.nova_likes l where l.message_id = m.id and l.email = viewer));
$$;$f$, 'nova_', p || '_');

    select o.oid into fn from pg_proc o join pg_namespace n on n.oid = o.pronamespace where n.nspname = 'public' and o.proname = p;
    def := pg_get_functiondef(fn);
    if position('_typing' in def) > 0 then continue; end if; -- already patched

    anchors := array[
      $a$returning * into msg;
    insert into public.nova_counts as t (email, day, kind, n) values (e, today, 'chat_msg', 1)$a$,
      $a$'name', u.name, 'body', s.body, 'at', s.at)$a$,
      $a$'rooms', coalesce(($a$,
      $a$  elsif op = 'suggestions' then$a$
    ];
    repls := array[
      $a$returning * into msg;
    if a->>'anon' = 'true' and msg.room = 'members' then
      update public.nova_messages set anon = true where id = msg.id returning * into msg;
    end if;
    delete from public.nova_typing where email = e;
    insert into public.nova_counts as t (email, day, kind, n) values (e, today, 'chat_msg', 1)$a$,
      $a$'name', u.name, 'body', s.body, 'at', s.at, 'status', s.status)$a$,
      $a$'typing', coalesce((
        select jsonb_agg(jsonb_build_object('email', t.email, 'room', t.room, 'anon', t.anon, 'name', u.name, 'avatar', u.avatar_v))
          from public.nova_typing t left join public.nova_users u on u.email = t.email
         where t.at > now() - interval '6 seconds' and t.email <> e and t.room = any(my_rooms)), '[]'::jsonb),
      'rooms', coalesce(($a$,
      $a$  -- Typing: this account is writing in a room (anonymously, in the members chat), or stopped.
  elsif op = 'typing' then
    if shut or not (coalesce(a->>'room', '') = any(my_rooms)) then return jsonb_build_object('ok', false); end if;
    if a->>'stop' = 'true' then
      delete from public.nova_typing where email = e;
    else
      insert into public.nova_typing as t (email, room, anon, at)
        values (e, a->>'room', a->>'anon' = 'true' and a->>'room' = 'members', now())
        on conflict (email) do update set room = excluded.room, anon = excluded.anon, at = now();
    end if;
    return jsonb_build_object('ok', true);
  -- Admin only (lib/members.js checks): who sent an anonymous message in the members chat.
  elsif op = 'msg-who' then
    return coalesce((select jsonb_build_object('email', m.email, 'name', u.name)
                       from public.nova_messages m left join public.nova_users u on u.email = m.email
                      where m.id = nullif(coalesce(a->>'id', ''), '')::bigint and m.room = 'members' and m.anon), '{}'::jsonb);
  -- A member's own update requests and what the admin said (Update requests box).
  elsif op = 'my-suggestions' then
    return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'body', s.body, 'at', s.at, 'status', s.status, 'answeredAt', s.answered_at) order by s.at desc)
                       from (select * from public.nova_suggestions where email = e order by at desc limit 50) s), '[]'::jsonb);
  -- Admin only: approve or deny an update request (or set it back to waiting).
  elsif op = 'suggestion-answer' then
    if coalesce(a->>'status', '') not in ('approved', 'denied', 'new') then return jsonb_build_object('ok', false); end if;
    update public.nova_suggestions set status = a->>'status', answered_at = case when a->>'status' = 'new' then null else now() end
     where id = nullif(coalesce(a->>'id', ''), '')::bigint;
    return jsonb_build_object('ok', found);
  elsif op = 'suggestions' then$a$
    ];
    for i in 1 .. array_length(anchors, 1) loop
      a := replace(anchors[i], 'nova_', p || '_');
      b := replace(repls[i], 'nova_', p || '_');
      if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
        raise exception '% anchor % found % times', p, i, (length(def) - length(replace(def, a, ''))) / length(a);
      end if;
      def := replace(def, a, b);
    end loop;
    execute def;
  end loop;
end
$mig$;
