-- Migración: votos por clip. Ejecutala una vez en el SQL Editor (schema.sql ya la incluye para proyectos nuevos).

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
