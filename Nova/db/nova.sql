-- NOTE 2026-11-07: db/chat-extras.sql patches nova()/mf() on top of this file (anonymous messages,
-- typing, update-request answers); apply it after this file when rebuilding.
-- Nova's database (Supabase project "enhancer", schema public). Everything goes through
-- public.nova(k, op, a), which only answers the site's server: k is NOVA_DB_KEY, checked
-- against its SHA-256 below. The tables have row level security on and no policies, so
-- nothing else can read them. lib/members.js is the only caller.
--
-- nova_users     one row per account: username (name, unique), whether its profile was set up
--                (profile_done), photo version (avatar_v, 0 = none), favorite games, ban,
--                kick, mute (muted_until, muted_all), presence (last_seen, last_view)
-- nova_avatars   profile photos, read one at a time (keyed by email, shown by a made-up id)
-- nova_messages  chat: rooms "members" and "p:<id>" (a private chat). The old admins' chat
--                (room "admins") is gone: its rows stay, but nobody can read or post there.
-- nova_rooms     private chats: who made it (owner), who is in them, and each member's powers
--                (perms: email -> ["rename", "add", "remove", "priv"])
-- nova_images    photos posted in the chat (a message's image), read back one at a time
-- nova_likes     likes (thumbs up) on chat messages; nobody can like their own
-- nova_approved  emails the admin approved or removed in the admin panel (on top of NOVA_EMAILS)
-- nova_requests  people turned away at sign-in who asked to be let in, with their note
-- nova_suggestions  members' update requests for the site (admin's Update suggestions)
-- nova_usage     seconds per account, day, section and game
-- nova_counts    counts per account, day and kind: AI chats and prompts, browser tabs and
--                searches, visits, game launches, chat messages
-- nova_hours     seconds per day and hour, everyone together (the busiest hours)
-- nova_poly      each account's best PolyTrack time per track
-- nova_mp_*      multiplayer: ratings, ranked matches, saved worlds (written by the game server)
--
-- Only totals: nothing here keeps what anyone types to the AI, which sites they open, or
-- what they are doing right now. Days and hours are New York time.

create table if not exists public.nova_rooms (
  id bigserial primary key,
  name text not null,
  owner text not null,
  members text[] not null default '{}',
  created_at timestamptz not null default now()
);
create table if not exists public.nova_likes (
  message_id bigint not null,
  email text not null,
  primary key (message_id, email)
);
create table if not exists public.nova_approved (
  email text primary key,
  added_by text not null,
  added_at timestamptz not null default now()
);
alter table public.nova_approved add column if not exists removed boolean not null default false;
create table if not exists public.nova_usage (
  email text not null,
  day date not null,
  section text not null,
  item text not null default '',
  seconds integer not null default 0,
  primary key (email, day, section, item)
);
create table if not exists public.nova_counts (
  email text not null,
  day date not null,
  kind text not null,
  item text not null default '',
  n integer not null default 0,
  primary key (email, day, kind, item)
);
alter table public.nova_usage alter column day set default ((now() at time zone 'America/New_York')::date);
alter table public.nova_counts alter column day set default ((now() at time zone 'America/New_York')::date);
create table if not exists public.nova_hours (
  day date not null,
  hour smallint not null,
  seconds integer not null default 0,
  primary key (day, hour)
);
create table if not exists public.nova_poly (
  email text not null,
  track text not null,
  frames integer not null,
  at timestamptz not null default now(),
  primary key (email, track)
);

alter table public.nova_rooms add column if not exists perms jsonb not null default '{}'::jsonb;
-- Everyone already in a private chat when powers came in (2026-10-29) can add people.
update public.nova_rooms o set perms = coalesce((select jsonb_object_agg(m, '["add"]'::jsonb) from unnest(o.members) m where m <> o.owner), '{}'::jsonb) where o.perms = '{}'::jsonb;
create table if not exists public.nova_images (
  id bigserial primary key,
  room text not null,
  email text not null,
  mime text not null,
  data text not null,
  created_at timestamptz not null default now()
);
alter table public.nova_messages add column if not exists reply_to bigint;
alter table public.nova_messages add column if not exists image bigint;
create table if not exists public.nova_requests (
  email text primary key,
  message text not null default '',
  reason text not null default '',
  at timestamptz not null default now()
);

-- Profiles (2026-11-01): a username nobody else has, a photo, and favorite games.
alter table public.nova_users add column if not exists profile_done boolean not null default false;
alter table public.nova_users add column if not exists avatar_v bigint not null default 0;
alter table public.nova_users add column if not exists favorites text[] not null default '{}';
create table if not exists public.nova_avatars (
  email text primary key,
  mime text not null,
  data text not null,
  updated_at timestamptz not null default now()
);
-- Muting (2026-11-02): until muted_until the account can't post in the members chat, or in
-- any chat at all with muted_all.
alter table public.nova_users add column if not exists muted_until timestamptz;
alter table public.nova_users add column if not exists muted_all boolean not null default false;
-- Two accounts can't hold the same username at once, whatever the capitals. No username
-- (null) is "Unknown user", which any number of accounts can be.
create unique index if not exists nova_users_name_unique on public.nova_users (lower(name)) where name is not null;
-- Reasons (2026-11-04): the admin's note on why someone was banned, kicked or muted, shown to them.
alter table public.nova_users add column if not exists ban_reason text;
alter table public.nova_users add column if not exists kick_reason text;
alter table public.nova_users add column if not exists mute_reason text;
-- Multiplayer (2026-11-04): Elo per account and game ("cards:poker" for a card game), ranked
-- matches already counted (by id, so a result sent twice counts once), saved worlds.
create table if not exists public.nova_mp_ratings (email text not null, game text not null, elo integer not null default 0, games integer not null default 0, wins integer not null default 0, updated_at timestamptz not null default now(), primary key (email, game));
create table if not exists public.nova_mp_matches (id text primary key, game text not null, players jsonb not null default '[]'::jsonb, at timestamptz not null default now());
create table if not exists public.nova_mp_worlds (id text primary key, data text not null, updated_at timestamptz not null default now());
alter table public.nova_mp_ratings enable row level security;
alter table public.nova_mp_matches enable row level security;
alter table public.nova_mp_worlds enable row level security;

-- Update requests (2026-11-05): members' suggestions for the site, from the chat's Update
-- requests box; only the admin reads them (Update suggestions in the admin panel).
create table if not exists public.nova_suggestions (id bigserial primary key, email text not null, body text not null, at timestamptz not null default now());
alter table public.nova_suggestions enable row level security;
-- A denied access request keeps the admin's message (reply) until that person asks again;
-- they see it the next time the sign-in turns them away.
alter table public.nova_requests add column if not exists reply text;
alter table public.nova_requests add column if not exists denied_at timestamptz;

alter table public.nova_avatars enable row level security;
alter table public.nova_rooms enable row level security;
alter table public.nova_images enable row level security;
alter table public.nova_requests enable row level security;
alter table public.nova_likes enable row level security;
alter table public.nova_approved enable row level security;
alter table public.nova_usage enable row level security;
alter table public.nova_counts enable row level security;
alter table public.nova_hours enable row level security;
alter table public.nova_poly enable row level security;
-- Private chats' messages live in rooms "p:<id>".
alter table public.nova_messages drop constraint if exists nova_messages_room_check;
alter table public.nova_messages add constraint nova_messages_room_check check (room in ('members', 'admins') or room ~ '^p:[0-9]{1,12}$');
create index if not exists nova_messages_rev on public.nova_messages (rev);
create index if not exists nova_usage_day on public.nova_usage (day);
create index if not exists nova_counts_day on public.nova_counts (day);

-- One chat message as the server reads it: who wrote it, the message it answers, its photo,
-- its likes, and whether this account liked it.
create or replace function public.nova_msg(m public.nova_messages, viewer text)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('id', m.id, 'rev', m.rev, 'room', m.room, 'email', m.email,
    'name', (select u.name from public.nova_users u where u.email = m.email),
    'avatar', (select u.avatar_v from public.nova_users u where u.email = m.email),
    'body', m.body, 'deleted', m.deleted, 'created_at', m.created_at, 'image', m.image,
    'reply', (select jsonb_build_object('id', p.id, 'email', p.email, 'body', left(p.body, 140), 'image', p.image is not null,
                       'name', (select u.name from public.nova_users u where u.email = p.email))
                from public.nova_messages p where p.id = m.reply_to and not p.deleted),
    'likes', (select count(*) from public.nova_likes l where l.message_id = m.id),
    'liked', exists (select 1 from public.nova_likes l where l.message_id = m.id and l.email = viewer));
$$;

-- Totals for the admin panel's stats and leaderboards: from a.from (a date; all time when
-- empty), for a.who (one email) or everyone.
create or replace function public.nova_stats(a jsonb)
returns jsonb language plpgsql stable set search_path = public, pg_temp as $$
declare
  since date := case when coalesce(a->>'from', '') ~ '^\d{4}-\d{2}-\d{2}$' then (a->>'from')::date else '2000-01-01'::date end;
  who text := nullif(lower(coalesce(a->>'who', '')), '');
  today date := (now() at time zone 'America/New_York')::date;
begin
  return jsonb_build_object(
    -- seconds per account and section
    'people', coalesce((
      select jsonb_agg(jsonb_build_object('email', x.email, 'section', x.section, 'seconds', x.s))
        from (select email, section, sum(seconds) s from public.nova_usage
               where day >= since and (who is null or email = who) group by email, section) x), '[]'::jsonb),
    -- seconds per game
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('section', x.section, 'item', x.item, 'seconds', x.s))
        from (select section, item, sum(seconds) s from public.nova_usage
               where day >= since and item <> '' and (who is null or email = who) group by section, item) x), '[]'::jsonb),
    -- counts per account and kind
    'counts', coalesce((
      select jsonb_agg(jsonb_build_object('email', x.email, 'kind', x.kind, 'n', x.n))
        from (select email, kind, sum(n) n from public.nova_counts
               where day >= since and (who is null or email = who) group by email, kind) x), '[]'::jsonb),
    -- launches per game
    'countItems', coalesce((
      select jsonb_agg(jsonb_build_object('kind', x.kind, 'item', x.item, 'n', x.n))
        from (select kind, item, sum(n) n from public.nova_counts
               where day >= since and item <> '' and (who is null or email = who) group by kind, item) x), '[]'::jsonb),
    -- the last 30 days: time and how many accounts were active
    'days', coalesce((
      select jsonb_agg(jsonb_build_object('day', x.day, 'seconds', x.s, 'users', x.u) order by x.day)
        from (select day, sum(seconds) s, count(distinct email) u from public.nova_usage
               where day >= greatest(since, today - 29) and seconds > 0 and (who is null or email = who) group by day) x), '[]'::jsonb),
    -- the busiest hours of the day, everyone together
    'hours', case when who is null then coalesce((
      select jsonb_agg(jsonb_build_object('hour', x.hour, 'seconds', x.s) order by x.hour)
        from (select hour, sum(seconds) s from public.nova_hours where day >= since group by hour) x), '[]'::jsonb) else '[]'::jsonb end,
    -- accounts that opened Nova for the first time in the period
    'joined', case when who is null then coalesce((
      select jsonb_agg(jsonb_build_object('email', u.email, 'name', u.name, 'at', u.created_at) order by u.created_at desc)
        from public.nova_users u where (u.created_at at time zone 'America/New_York')::date >= since), '[]'::jsonb) else '[]'::jsonb end);
end;
$$;

create or replace function public.nova(k text, op text, a jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  e text := lower(coalesce(a->>'email', ''));
  -- When this account's session signed in (lib/members.js): a kick signs out older sessions.
  iat timestamptz := case when coalesce(a->>'iat', '') ~ '^\d{9,11}$' then to_timestamp((a->>'iat')::bigint) end;
  today date := (now() at time zone 'America/New_York')::date;
  me public.nova_users;
  shut boolean;
  muted boolean;
  my_rooms text[];
  r jsonb;
  since bigint;
  msg public.nova_messages;
  rid bigint;
  x jsonb;
  sect text;
  v_item text;
  amount integer;
  total integer := 0;
  rm public.nova_rooms;
  perm text[];
  who text;
begin
  if k is null or encode(sha256(convert_to(k, 'UTF8')), 'hex') <> '1c3de736e4e8c431cd2d375684f194dc72cf9a0c4a9854896a1470334e518970' then
    raise exception 'denied' using errcode = '42501';
  end if;

  -- Shut out: banned, kicked for some days and not back yet, or kicked after this session
  -- signed in. Such an account can't post or save anything.
  select * into me from public.nova_users u where u.email = e;
  shut := coalesce(me.banned, false)
       or coalesce(me.kicked_at + make_interval(days => coalesce(me.kick_days, 0)) > now(), false)
       or coalesce(me.kicked_at > iat, false);
  muted := coalesce(me.muted_until > now(), false);

  -- The rooms this account may read: the members' chat and its own private chats.
  select array['members'] || coalesce(array_agg('p:' || id), '{}') into my_rooms
    from public.nova_rooms where e = any(members);

  -- Whether this account may be in, without counting it as online.
  if op = 'status' then
    return jsonb_build_object('name', me.name, 'banned', coalesce(me.banned, false),
             'until', me.kicked_at + make_interval(days => coalesce(me.kick_days, 0)), 'kickedAt', me.kicked_at, 'banReason', me.ban_reason, 'kickReason', me.kick_reason);

  -- Nova open: mark the account online (and which section), add the time and counts since
  -- the last ping and any better PolyTrack times, and return its status, who is online, its
  -- private chats and, when a.since is given, the chat changes after that revision.
  elsif op = 'ping' then
    insert into public.nova_users as u (email, last_seen, last_view) values (e, now(), left(a->>'view', 20))
      on conflict (email) do update set last_seen = now(), last_view = excluded.last_view;
    if not shut then
      for x in select * from jsonb_array_elements(case when jsonb_typeof(a->'usage') = 'array' then a->'usage' else '[]'::jsonb end) loop
        sect := x->>'s';
        continue when sect is null or sect not in ('browser', 'games', 'multiplayer', 'ai', 'chat', 'leaderboard');
        v_item := case when sect = 'games' and coalesce(x->>'i', '') ~ '^[a-z0-9-]{1,40}$' then x->>'i' else '' end;
        amount := case when coalesce(x->>'sec', '') ~ '^\d{1,6}$' then least(300, (x->>'sec')::int) else 0 end;
        continue when amount = 0;
        insert into public.nova_usage as t (email, day, section, item, seconds) values (e, today, sect, v_item, amount)
          on conflict (email, day, section, item) do update set seconds = t.seconds + excluded.seconds;
        total := total + amount;
      end loop;
      if total > 0 then
        insert into public.nova_hours as h (day, hour, seconds)
          values (today, extract(hour from now() at time zone 'America/New_York')::smallint, least(total, 600))
          on conflict (day, hour) do update set seconds = h.seconds + excluded.seconds;
      end if;
      for x in select * from jsonb_array_elements(case when jsonb_typeof(a->'counts') = 'array' then a->'counts' else '[]'::jsonb end) loop
        sect := x->>'k';
        continue when sect is null or sect not in ('visit', 'tab', 'search', 'ai_chat', 'ai_prompt', 'game_play');
        v_item := case when sect = 'game_play' and coalesce(x->>'i', '') ~ '^[a-z0-9-]{1,40}$' then x->>'i' else '' end;
        amount := case when coalesce(x->>'n', '') ~ '^\d{1,4}$' then least(200, (x->>'n')::int) else 0 end;
        continue when amount = 0;
        insert into public.nova_counts as t (email, day, kind, item, n) values (e, today, sect, v_item, amount)
          on conflict (email, day, kind, item) do update set n = t.n + excluded.n;
      end loop;
      for x in select * from jsonb_array_elements(case when jsonb_typeof(a->'poly') = 'array' then a->'poly' else '[]'::jsonb end) loop
        continue when coalesce(x->>'t', '') !~ '^[0-9a-f]{64}$' or coalesce(x->>'f', '') !~ '^\d{4,7}$';
        amount := (x->>'f')::int;
        continue when amount < 1000 or amount > 3600000;
        insert into public.nova_poly as t (email, track, frames) values (e, x->>'t', amount)
          on conflict (email, track) do update set frames = excluded.frames, at = now() where excluded.frames < t.frames;
      end loop;
    end if;
    r := jsonb_build_object('name', me.name, 'avatar', coalesce(me.avatar_v, 0), 'done', coalesce(me.profile_done, false),
      'favorites', to_jsonb(coalesce(me.favorites, '{}'::text[])), 'banned', coalesce(me.banned, false),
      'until', me.kicked_at + make_interval(days => coalesce(me.kick_days, 0)), 'kickedAt', me.kicked_at,
      'banReason', me.ban_reason, 'kickReason', me.kick_reason, 'muteReason', case when muted then me.mute_reason end, 'mutedUntil', case when muted then me.muted_until end, 'mutedAll', muted and coalesce(me.muted_all, false),
      'online', coalesce((
        select jsonb_agg(jsonb_build_object('email', u.email, 'name', u.name, 'avatar', u.avatar_v, 'view', u.last_view))
          from public.nova_users u
         where u.last_seen > now() - interval '60 seconds' and not u.banned), '[]'::jsonb),
      'rooms', coalesce((
        select jsonb_agg(jsonb_build_object('id', 'p:' || o.id, 'name', o.name, 'owner', o.owner, 'members', o.members, 'perms', o.perms) order by o.id)
          from public.nova_rooms o where e = any(o.members)), '[]'::jsonb));
    if a ? 'since' then
      since := case when coalesce(a->>'since', '') ~ '^\d{1,15}$' then (a->>'since')::bigint else 0 end;
      r := r || jsonb_build_object('chat', jsonb_build_object(
        'rev', (select coalesce(max(m.rev), 0) from public.nova_messages m),
        'messages', coalesce((
          select jsonb_agg(public.nova_msg(m, e) order by m.id)
            from public.nova_messages m
           where m.room = any(my_rooms)
             and ((since = 0 and not m.deleted and m.id in (
                    select id from public.nova_messages where not deleted and room = any(my_rooms) order by id desc limit 300))
               or (since > 0 and m.rev > since))), '[]'::jsonb)));
    end if;
    return r;

  -- The last 300 messages of a room this account is in (a private chat it was just added to).
  elsif op = 'history' then
    if not (a->>'room' = any(my_rooms)) then return jsonb_build_object('denied', true); end if;
    return coalesce((
      select jsonb_agg(public.nova_msg(m, e) order by m.id)
        from (select * from public.nova_messages
               where room = a->>'room' and not deleted order by id desc limit 300) m), '[]'::jsonb);

  elsif op = 'say' then
    if shut then return jsonb_build_object('blocked', true); end if;
    if not (a->>'room' = any(my_rooms)) then return jsonb_build_object('denied', true); end if;
    -- Muted: not in the members' chat, and not anywhere with muted_all.
    if muted and (me.muted_all or a->>'room' = 'members') then
      return jsonb_build_object('muted', true, 'until', me.muted_until, 'all', me.muted_all, 'reason', me.mute_reason);
    end if;
    -- A photo (a.image: { mime, data } in base64, already shrunk by the page) is kept apart.
    rid := null;
    if jsonb_typeof(a->'image') = 'object' and coalesce(a->'image'->>'mime', '') in ('image/jpeg', 'image/png', 'image/webp', 'image/gif')
       and length(coalesce(a->'image'->>'data', '')) between 16 and 1500000 then
      insert into public.nova_images (room, email, mime, data) values (a->>'room', e, a->'image'->>'mime', a->'image'->>'data') returning id into rid;
    end if;
    if rid is null and btrim(coalesce(a->>'body', '')) = '' then return jsonb_build_object('empty', true); end if;
    insert into public.nova_messages (room, email, body, image, reply_to)
      values (a->>'room', e, left(btrim(coalesce(a->>'body', '')), 2000), rid,
              (select p.id from public.nova_messages p where p.id = nullif(coalesce(a->>'reply', ''), '')::bigint and p.room = a->>'room'))
      returning * into msg;
    insert into public.nova_counts as t (email, day, kind, n) values (e, today, 'chat_msg', 1)
      on conflict (email, day, kind, item) do update set n = t.n + 1;
    return public.nova_msg(msg, e);

  -- The admin removing a message from a chat they can read: the members' chat or a private
  -- chat they're in. Nothing lets the admin read a private chat they aren't in.
  elsif op = 'del' then
    update public.nova_messages set deleted = true, body = '', rev = nextval('public.nova_rev')
     where id = (a->>'id')::bigint and room = any(my_rooms) and (coalesce(a->>'admin', '') = 'true' or email = e);
    return jsonb_build_object('ok', found);

  -- Settings › Chat messages: delete every message this account ever sent, in every chat.
  elsif op = 'del-mine' then
    with gone as (
      update public.nova_messages set deleted = true, body = '', rev = nextval('public.nova_rev')
       where email = e and not deleted returning id)
    select count(*) into total from gone;
    return jsonb_build_object('ok', true, 'deleted', total);

  -- A photo from the chat, for someone who can read its room.
  elsif op = 'img' then
    return coalesce((select jsonb_build_object('mime', i.mime, 'data', i.data) from public.nova_images i
                      where i.id = nullif(coalesce(a->>'id', ''), '')::bigint and i.room = any(my_rooms)), jsonb_build_object('denied', true));

  -- Like or unlike a message this account can read; nobody can like their own.
  elsif op = 'like' then
    select * into msg from public.nova_messages m
     where m.id = (a->>'id')::bigint and not m.deleted and m.room = any(my_rooms) and m.email <> e;
    if msg.id is null then return jsonb_build_object('ok', false); end if;
    if exists (select 1 from public.nova_likes where message_id = msg.id and email = e) then
      delete from public.nova_likes where message_id = msg.id and email = e;
    else
      insert into public.nova_likes (message_id, email) values (msg.id, e);
    end if;
    update public.nova_messages set rev = nextval('public.nova_rev') where id = msg.id returning * into msg;
    return public.nova_msg(msg, e);

  -- Private chats. Whoever starts one is its host (owner): the host can rename it, add and
  -- remove people, delete it, and give or take the others' powers (perms): "rename", "add",
  -- "remove" and "priv" (giving and taking those four). Everyone else starts with "add".
  -- Anyone can leave; when the host leaves, the next member becomes host, and the last one
  -- out deletes the chat. Only the people in a private chat can read it.
  elsif op = 'room-new' then
    if shut then return jsonb_build_object('blocked', true); end if;
    insert into public.nova_rooms (name, owner, members, perms)
      values (left(btrim(a->>'name'), 40), e,
              array(select e union select distinct lower(v) from jsonb_array_elements_text(coalesce(a->'members', '[]'::jsonb)) v),
              coalesce((select jsonb_object_agg(lower(v), '["add"]'::jsonb) from jsonb_array_elements_text(coalesce(a->'members', '[]'::jsonb)) v where lower(v) <> e), '{}'::jsonb))
      returning id into rid;
    return jsonb_build_object('id', 'p:' || rid);
  elsif op in ('room-add', 'room-rename', 'room-remove', 'room-perm', 'room-delete', 'room-leave') then
    rid := case when coalesce(a->>'room', '') ~ '^p:\d{1,12}$' then substring(a->>'room' from 3)::bigint end;
    select * into rm from public.nova_rooms o where o.id = rid and e = any(o.members);
    if rm.id is null then return jsonb_build_object('denied', true); end if;
    who := lower(coalesce(a->>'who', ''));
    if op = 'room-leave' then
      update public.nova_rooms set members = array_remove(members, e), perms = perms - e,
             owner = case when owner = e then coalesce((array_remove(members, e))[1], owner) else owner end
       where id = rid;
      if not exists (select 1 from public.nova_rooms where id = rid and cardinality(members) > 0) then
        delete from public.nova_likes where message_id in (select id from public.nova_messages where room = 'p:' || rid);
        delete from public.nova_images where room = 'p:' || rid;
        delete from public.nova_messages where room = 'p:' || rid;
        delete from public.nova_rooms where id = rid;
      end if;
      return jsonb_build_object('ok', true);
    end if;
    if shut then return jsonb_build_object('blocked', true); end if;
    -- What this account may do here: everything as host, otherwise its perms.
    perm := case when rm.owner = e then array['rename', 'add', 'remove', 'priv', 'delete']
                 else array(select jsonb_array_elements_text(coalesce(rm.perms->e, '[]'::jsonb))) end;
    if op = 'room-add' then
      if not 'add' = any(perm) then return jsonb_build_object('denied', true); end if;
      update public.nova_rooms o
         set members = o.members || array(select distinct lower(v) from jsonb_array_elements_text(coalesce(a->'add', '[]'::jsonb)) v where not lower(v) = any(o.members)),
             perms = o.perms || coalesce((select jsonb_object_agg(lower(v), '["add"]'::jsonb) from jsonb_array_elements_text(coalesce(a->'add', '[]'::jsonb)) v where not lower(v) = any(o.members)), '{}'::jsonb)
       where o.id = rid;
    elsif op = 'room-rename' then
      if not 'rename' = any(perm) then return jsonb_build_object('denied', true); end if;
      update public.nova_rooms set name = left(btrim(coalesce(a->>'name', '')), 40) where id = rid;
    elsif op = 'room-remove' then
      if not 'remove' = any(perm) or who = rm.owner or who = e or not who = any(rm.members) then return jsonb_build_object('denied', true); end if;
      update public.nova_rooms set members = array_remove(members, who), perms = perms - who where id = rid;
    elsif op = 'room-perm' then
      if not 'priv' = any(perm) or who = rm.owner or who = e or not who = any(rm.members)
         or coalesce(a->>'perm', '') not in ('rename', 'add', 'remove', 'priv') then return jsonb_build_object('denied', true); end if;
      update public.nova_rooms o set perms = jsonb_set(o.perms, array[who], coalesce((
          select jsonb_agg(distinct p) from (
            select jsonb_array_elements_text(coalesce(o.perms->who, '[]'::jsonb)) p
            union select a->>'perm' where (a->>'on')::boolean) q
           where not (p = a->>'perm' and not (a->>'on')::boolean)), '[]'::jsonb))
       where o.id = rid;
    elsif op = 'room-delete' then
      if not 'delete' = any(perm) then return jsonb_build_object('denied', true); end if;
      delete from public.nova_likes where message_id in (select id from public.nova_messages where room = 'p:' || rid);
      delete from public.nova_images where room = 'p:' || rid;
      delete from public.nova_messages where room = 'p:' || rid;
      delete from public.nova_rooms where id = rid;
    end if;
    return jsonb_build_object('ok', true);

  -- People turned away at sign-in asking to be let in (lib/unlock.js), and the admin's answers.
  elsif op = 'request' then
    insert into public.nova_requests as q (email, message, reason) values (e, left(btrim(coalesce(a->>'message', '')), 500), left(coalesce(a->>'reason', ''), 20))
      on conflict (email) do update set message = excluded.message, reason = excluded.reason, at = now(), reply = null, denied_at = null;
    return jsonb_build_object('ok', true);
  elsif op = 'requests' then
    return coalesce((select jsonb_agg(jsonb_build_object('email', q.email, 'message', q.message, 'reason', q.reason, 'at', q.at) order by q.at desc)
                       from public.nova_requests q where q.denied_at is null), '[]'::jsonb);
  elsif op = 'request-done' then
    delete from public.nova_requests where email = lower(a->>'who');
    return jsonb_build_object('ok', found);
  -- Denied, with an optional message from the admin, which that person sees next time.
  elsif op = 'request-deny' then
    update public.nova_requests set denied_at = now(), reply = nullif(left(btrim(coalesce(a->>'reply', '')), 500), '')
     where email = lower(a->>'who');
    return jsonb_build_object('ok', found);
  elsif op = 'request-reply' then
    return coalesce((select jsonb_build_object('denied', true, 'reply', q.reply, 'at', q.denied_at) from public.nova_requests q
                      where q.email = e and q.denied_at is not null), '{}'::jsonb);

  -- Update requests: a member's suggestion for the site (at most 30 a day), and the admin's list.
  elsif op = 'suggest' then
    if shut then return jsonb_build_object('denied', true); end if;
    if (select count(*) from public.nova_suggestions s where s.email = e and s.at > now() - interval '1 day') >= 30 then
      return jsonb_build_object('tooMany', true);
    end if;
    insert into public.nova_suggestions (email, body) values (e, left(btrim(coalesce(a->>'body', '')), 2000));
    return jsonb_build_object('ok', true);
  elsif op = 'suggestions' then
    return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'email', s.email, 'name', u.name, 'body', s.body, 'at', s.at) order by s.at desc)
                       from public.nova_suggestions s left join public.nova_users u on u.email = s.email), '[]'::jsonb);
  elsif op = 'suggestion-del' then
    delete from public.nova_suggestions where id = nullif(coalesce(a->>'id', ''), '')::bigint;
    return jsonb_build_object('ok', found);

  -- Admin: every account with a row, for the member list (no record of what anyone is doing).
  elsif op = 'users' then
    return coalesce((
      select jsonb_agg(jsonb_build_object('email', u.email, 'name', u.name, 'banned', u.banned,
               'kickedAt', u.kicked_at, 'kickDays', u.kick_days,
               'until', u.kicked_at + make_interval(days => coalesce(u.kick_days, 0)),
               'mutedUntil', u.muted_until, 'mutedAll', u.muted_all, 'banReason', u.ban_reason, 'kickReason', u.kick_reason, 'muteReason', u.mute_reason,
               'avatar', u.avatar_v, 'lastSeen', u.last_seen, 'joined', u.created_at,
               'online', coalesce(u.last_seen > now() - interval '60 seconds', false)))
        from public.nova_users u), '[]'::jsonb);

  -- Username and photo version of every account, for the leaderboard and the member search.
  elsif op = 'profiles' then
    return coalesce((select jsonb_object_agg(u.email, jsonb_build_object('name', u.name, 'avatar', u.avatar_v)) from public.nova_users u), '{}'::jsonb);

  -- This account's own profile. a.name (when given) is its username, null for none; a.photo is
  -- { mime, data } in base64, already made small and square by the page, or null to remove
  -- it. Either way the first-time popup is done with. A username someone else holds answers
  -- { taken }; changing or clearing one frees it (the unique index only sees current names).
  elsif op = 'profile' then
    if shut then return jsonb_build_object('blocked', true); end if;
    insert into public.nova_users (email) values (e) on conflict (email) do nothing;
    begin
      update public.nova_users set profile_done = true,
             name = case when a ? 'name' then nullif(btrim(a->>'name'), '') else name end
       where email = e;
    exception when unique_violation then
      return jsonb_build_object('taken', true);
    end;
    if jsonb_typeof(a->'photo') = 'object' then
      insert into public.nova_avatars as t (email, mime, data) values (e, a->'photo'->>'mime', a->'photo'->>'data')
        on conflict (email) do update set mime = excluded.mime, data = excluded.data, updated_at = now();
      update public.nova_users set avatar_v = nextval('public.nova_rev') where email = e;
    elsif a ? 'photo' then
      delete from public.nova_avatars where email = e;
      update public.nova_users set avatar_v = 0 where email = e;
    end if;
    return (select jsonb_build_object('name', u.name, 'avatar', u.avatar_v) from public.nova_users u where u.email = e);

  -- One account's photo.
  elsif op = 'avatar' then
    return coalesce((select jsonb_build_object('mime', t.mime, 'data', t.data) from public.nova_avatars t where t.email = lower(a->>'who')), '{}'::jsonb);

  -- This account's favorite games, the whole list each time.
  elsif op = 'favorites' then
    if shut then return jsonb_build_object('blocked', true); end if;
    insert into public.nova_users (email) values (e) on conflict (email) do nothing;
    update public.nova_users set favorites = array(select jsonb_array_elements_text(coalesce(a->'list', '[]'::jsonb))) where email = e;
    return jsonb_build_object('ok', true);

  -- Admin: change one account. kick signs it out now and keeps it out for a number of days,
  -- unkick lets it back in early, and banned keeps it out until unbanned. mute stops it posting
  -- for a number of days: in the members' chat, or with a.all in every chat.
  elsif op = 'set' then
    insert into public.nova_users (email) values (e) on conflict (email) do nothing;
    amount := case when coalesce(a->>'value', '') ~ '^\d{1,4}$' then least(3650, (a->>'value')::int) else 0 end;
    begin
      case a->>'field'
        when 'name' then update public.nova_users set name = nullif(left(btrim(a->>'value'), 40), '') where email = e;
        when 'banned' then update public.nova_users set banned = (a->>'value')::boolean, ban_reason = case when (a->>'value')::boolean then nullif(a->>'reason', '') end where email = e;
        when 'kick' then update public.nova_users set kicked_at = now(), kick_days = amount, kick_reason = nullif(a->>'reason', '') where email = e;
        when 'kickDays' then update public.nova_users set kick_days = greatest(1, amount) where email = e and kicked_at is not null;
        when 'unkick' then update public.nova_users set kicked_at = null, kick_days = null, kick_reason = null where email = e;
        when 'mute' then update public.nova_users set muted_until = now() + make_interval(days => greatest(1, amount)), muted_all = coalesce((a->>'all')::boolean, false), mute_reason = nullif(a->>'reason', '') where email = e;
        when 'unmute' then update public.nova_users set muted_until = null, muted_all = false, mute_reason = null where email = e;
        else raise exception 'unknown field';
      end case;
    exception when unique_violation then
      return jsonb_build_object('taken', true);
    end;
    return jsonb_build_object('ok', true);

  -- Emails approved or removed in the admin panel.
  elsif op = 'approved' then
    return coalesce((select jsonb_agg(jsonb_build_object('email', p.email, 'by', p.added_by, 'at', p.added_at, 'removed', p.removed) order by p.added_at)
                       from public.nova_approved p), '[]'::jsonb);
  elsif op = 'approve' then
    insert into public.nova_approved as p (email, added_by, removed) values (lower(a->>'add'), e, false)
      on conflict (email) do update set added_by = excluded.added_by, added_at = now(), removed = false;
    return jsonb_build_object('ok', true);
  elsif op = 'unapprove' then
    insert into public.nova_approved as p (email, added_by, removed) values (lower(a->>'remove'), e, true)
      on conflict (email) do update set added_by = excluded.added_by, added_at = now(), removed = true;
    return jsonb_build_object('ok', true);

  -- Admin: stats and leaderboards (see nova_stats).
  elsif op = 'stats' then
    return public.nova_stats(a);

  -- Everyone's best PolyTrack times. Nothing can take a time off: a record stays until its
  -- owner beats it.
  elsif op = 'poly' then
    return coalesce((
      select jsonb_agg(jsonb_build_object('email', p.email, 'track', p.track, 'frames', p.frames, 'at', p.at) order by p.track, p.frames)
        from public.nova_poly p), '[]'::jsonb);

  -- Admin: one member's totals and PolyTrack times.
  elsif op = 'member' then
    return jsonb_build_object(
      'poly', coalesce((select jsonb_agg(jsonb_build_object('track', p.track, 'frames', p.frames, 'at', p.at) order by p.frames)
                          from public.nova_poly p where p.email = lower(a->>'who')), '[]'::jsonb),
      'stats', public.nova_stats(jsonb_build_object('who', a->>'who', 'from', a->>'from')));

  -- Multiplayer (2026-11-04): ratings per account and game, ranked results (from Nova's game
  -- server, lib/mp.js) and saved worlds (the public World Empire world).
  elsif op = 'mp-ratings' then
    return coalesce((select jsonb_agg(jsonb_build_object('email', t.email, 'game', t.game, 'elo', t.elo, 'games', t.games, 'wins', t.wins))
                       from public.nova_mp_ratings t), '[]'::jsonb);
  elsif op = 'mp-result' then
    if exists (select 1 from public.nova_mp_matches where id = a->>'match') then return jsonb_build_object('ok', true, 'dup', true); end if;
    insert into public.nova_mp_matches (id, game, players) values (a->>'match', a->>'game', coalesce(a->'players', '[]'::jsonb));
    for x in select * from jsonb_array_elements(coalesce(a->'players', '[]'::jsonb)) loop
      insert into public.nova_mp_ratings as t (email, game, elo, games, wins)
        values (lower(x->>'email'), a->>'game', (x->>'elo')::int, (x->>'games')::int, (x->>'wins')::int)
        on conflict (email, game) do update set elo = excluded.elo, games = excluded.games, wins = excluded.wins, updated_at = now();
    end loop;
    return jsonb_build_object('ok', true);
  elsif op = 'mp-world-get' then
    return coalesce((select jsonb_build_object('data', w.data, 'at', w.updated_at) from public.nova_mp_worlds w where w.id = a->>'id'), '{}'::jsonb);
  elsif op = 'mp-world-put' then
    insert into public.nova_mp_worlds as w (id, data) values (a->>'id', a->>'data')
      on conflict (id) do update set data = excluded.data, updated_at = now();
    return jsonb_build_object('ok', true);
  end if;

  raise exception 'unknown op';
end;
$function$;

revoke all on function public.nova_msg(public.nova_messages, text) from public, anon, authenticated;
revoke all on function public.nova_stats(jsonb) from public, anon, authenticated;

-- Gone: the live "what each member has open" table and the admin's remote commands, and
-- editing other people's messages.
drop table if exists public.nova_state;
drop table if exists public.nova_commands;
alter table public.nova_messages drop column if exists edited;
