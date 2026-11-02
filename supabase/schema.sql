-- Esquema de Pampa 7 Noticias. Ejecutalo una vez en el SQL Editor de tu proyecto de Supabase.
-- El servidor accede con la clave de servicio (service_role) desde las funciones de Vercel; el navegador nunca habla con Supabase.
-- Las tablas tienen RLS activado y ninguna política: con la clave pública (anon) no se puede leer ni escribir nada.

create table if not exists public.segments (
  id         uuid primary key,
  source     text not null check (source in ('mcp', 'trend', 'colab')),
  status     text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'pinned')),   -- pinned = destacada a mano
  created_at timestamptz not null default now(),
  data       jsonb not null
);
create index if not exists segments_status_created_idx on public.segments (status, created_at desc);

create table if not exists public.embeds (
  id       text primary key,            -- id numérico del tweet
  url      text not null,
  added_at timestamptz not null default now()
);

create table if not exists public.rate_limits (
  k   text not null,
  day date not null default current_date,
  n   integer not null default 0,
  primary key (k, day)
);

-- Suma 1 al contador del día y devuelve true si todavía está dentro del límite.
create or replace function public.bump_limit(p_key text, p_lim integer)
returns boolean language plpgsql security definer set search_path = public as $$
declare c integer;
begin
  insert into public.rate_limits (k, day, n) values (p_key, current_date, 1)
  on conflict (k, day) do update set n = public.rate_limits.n + 1
  returning n into c;
  return c <= p_lim;
end $$;
revoke all on function public.bump_limit(text, integer) from public, anon, authenticated;

alter table public.segments    enable row level security;
alter table public.embeds      enable row level security;
alter table public.rate_limits enable row level security;

-- Presencia: cuántas personas tienen la página abierta (latido anónimo cada ~45 s; cuenta las de los últimos 90 s).
create table if not exists public.presence (
  id      text primary key,
  seen_at timestamptz not null default now()
);
create index if not exists presence_seen_idx on public.presence (seen_at);
alter table public.presence enable row level security;

create or replace function public.presence_ping(p_id text)
returns integer language plpgsql security definer set search_path = public as $$
declare c integer;
begin
  insert into public.presence (id, seen_at) values (p_id, now())
  on conflict (id) do update set seen_at = now();
  delete from public.presence where seen_at < now() - interval '10 minutes';
  select count(*) into c from public.presence where seen_at > now() - interval '90 seconds';
  return c;
end $$;
revoke all on function public.presence_ping(text) from public, anon, authenticated;

-- Votos 👍/👎 por clip. Un voto por (clip, votante); el votante es un id al azar guardado en el navegador (anónimo).
create table if not exists public.votes (
  seg_id     text     not null,
  voter      text     not null,
  v          smallint not null check (v in (-1, 1)),
  updated_at timestamptz not null default now(),
  primary key (seg_id, voter)
);
create index if not exists votes_seg_idx on public.votes (seg_id);
alter table public.votes enable row level security;

create or replace function public.vote_cast(p_seg text, p_voter text, p_v integer)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_v = 0 then
    delete from public.votes where seg_id = p_seg and voter = p_voter;
  else
    insert into public.votes (seg_id, voter, v, updated_at) values (p_seg, p_voter, p_v::smallint, now())
    on conflict (seg_id, voter) do update set v = excluded.v, updated_at = now();
  end if;
end $$;
revoke all on function public.vote_cast(text, text, integer) from public, anon, authenticated;

create or replace function public.vote_totals()
returns table (seg_id text, up bigint, down bigint) language sql security definer set search_path = public as $$
  select seg_id, count(*) filter (where v = 1), count(*) filter (where v = -1) from public.votes group by seg_id
$$;
revoke all on function public.vote_totals() from public, anon, authenticated;
