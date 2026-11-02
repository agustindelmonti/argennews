-- Migración: permite el estado «pinned» (noticia de la comunidad fijada como destacada desde el admin).
-- Si ya tenías el esquema anterior, ejecutala una vez. Los proyectos nuevos la traen en schema.sql.
alter table public.segments drop constraint if exists segments_status_check;
alter table public.segments add constraint segments_status_check check (status in ('pending', 'approved', 'rejected', 'pinned'));
