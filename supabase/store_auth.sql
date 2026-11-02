-- Autenticación de la Edge Function «store»: guarda solo el HASH del token que usa el servidor de Vercel.
-- Para cargar o rotar el token:  insert into public.store_auth (token_hash) values ('<sha256 en hex del token>');  (dejá una sola fila)
create table if not exists public.store_auth (token_hash text primary key, created_at timestamptz not null default now());
alter table public.store_auth enable row level security;
