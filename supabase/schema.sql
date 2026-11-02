-- Esquema de Pampa 7 Noticias. Ejecutalo una vez en el SQL Editor de tu proyecto de Supabase.
-- El servidor accede con la clave de servicio (service_role) desde las funciones de Vercel; el navegador nunca habla con Supabase.
-- Las tablas tienen RLS activado y ninguna política: con la clave pública (anon) no se puede leer ni escribir nada.

create table if not exists public.segments (
  id         uuid primary key,
  source     text not null check (source in ('mcp', 'trend', 'colab')),
  status     text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
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
