-- Meal Prep Picker: shared storage for household picks, shopping checkmarks, notes and ratings.
-- Paste this whole file into Supabase > SQL Editor > New query, then click Run.
-- The table is locked: the website can only read or change rows through the three
-- functions below, and only for a household code it already knows.

create table if not exists public.meal_items (
  household  text not null check (household ~ '^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$'),
  kind       text not null check (kind in ('picks', 'checks', 'recipes')),
  key        text not null check (char_length(key) between 1 and 200),
  data       jsonb not null default '{}'::jsonb check (pg_column_size(data) < 20000),
  updated_at timestamptz not null default now(),
  primary key (household, kind, key)
);

alter table public.meal_items enable row level security;
-- No policies on purpose: nobody can read or write the table directly.

create or replace function public.mp_get(hh text)
returns table (kind text, key text, data jsonb, updated_at timestamptz)
language sql security definer set search_path = public as $$
  select m.kind, m.key, m.data, m.updated_at from public.meal_items m where m.household = hh;
$$;

create or replace function public.mp_put(hh text, k text, ky text, d jsonb)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.meal_items where household = hh) >= 2000 then
    raise exception 'household is full';
  end if;
  insert into public.meal_items (household, kind, key, data, updated_at)
  values (hh, k, ky, d, now())
  on conflict (household, kind, key) do update set data = excluded.data, updated_at = now();
end;
$$;

create or replace function public.mp_del(hh text, k text, ky text)
returns void
language sql security definer set search_path = public as $$
  delete from public.meal_items where household = hh and kind = k and key = ky;
$$;

revoke all on function public.mp_get(text) from public;
revoke all on function public.mp_put(text, text, text, jsonb) from public;
revoke all on function public.mp_del(text, text, text) from public;
grant execute on function public.mp_get(text) to anon;
grant execute on function public.mp_put(text, text, text, jsonb) to anon;
grant execute on function public.mp_del(text, text, text) to anon;
