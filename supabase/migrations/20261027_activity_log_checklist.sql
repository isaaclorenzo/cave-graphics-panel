-- Historial de cambios (auditoria) y checklist por proyecto.
-- Cada alta, cambio o borrado en tasks y debts queda registrado en activity_log
-- desde la propia base de datos, asi nada se pierde aunque el tablero sea abierto.

begin;

alter table public.tasks
  add column if not exists checklist jsonb not null default '[]'::jsonb;

create table if not exists public.activity_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  table_name text not null,
  row_id text not null,
  action text not null check (action in ('insert', 'update', 'delete')),
  old_row jsonb,
  new_row jsonb
);

create index if not exists activity_log_at_idx on public.activity_log (at desc);

alter table public.activity_log enable row level security;
revoke all on table public.activity_log from anon, authenticated;

create or replace function public.log_board_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    insert into public.activity_log (table_name, row_id, action, old_row)
    values (tg_table_name, old.id, 'delete', to_jsonb(old));
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if (to_jsonb(old) - 'updated_at') = (to_jsonb(new) - 'updated_at') then
      return new;
    end if;
    insert into public.activity_log (table_name, row_id, action, old_row, new_row)
    values (tg_table_name, new.id, 'update', to_jsonb(old), to_jsonb(new));
    return new;
  end if;
  insert into public.activity_log (table_name, row_id, action, new_row)
  values (tg_table_name, new.id, 'insert', to_jsonb(new));
  return new;
end;
$$;

revoke execute on function public.log_board_change() from public, anon, authenticated;

drop trigger if exists tasks_activity on public.tasks;
create trigger tasks_activity
  after insert or update or delete on public.tasks
  for each row execute function public.log_board_change();

drop trigger if exists debts_activity on public.debts;
create trigger debts_activity
  after insert or update or delete on public.debts
  for each row execute function public.log_board_change();

commit;
