-- Migración: contador de gente en línea. Ejecutala una vez en el SQL Editor (o dejá que schema.sql la incluya en proyectos nuevos).

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
