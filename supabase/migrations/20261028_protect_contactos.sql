-- contactos guarda mensajes de un formulario (nombre, correo y texto). Estaba sin RLS y
-- con todos los permisos para anon, asi que cualquiera con la clave publica podia leerla,
-- cambiarla o vaciarla. Ahora solo se pueden enviar mensajes nuevos; leerlos queda
-- reservado al panel de Supabase (service role).

begin;

alter table public.contactos enable row level security;
revoke select, update, delete, truncate, references, trigger on table public.contactos from anon, authenticated;
grant insert on table public.contactos to anon, authenticated;

drop policy if exists contactos_insert_only on public.contactos;
create policy contactos_insert_only on public.contactos
  for insert to anon, authenticated
  with check (true);

commit;
