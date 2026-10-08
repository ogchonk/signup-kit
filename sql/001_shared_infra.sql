-- signup-kit: shared daily send quota (one table, per-site pools). Idempotent; safe to re-run. Source of truth: plans/2026-10-08-signup-uniform-waitlist-newsletter.md
create table if not exists public.signup_send_quota (
  day date not null,
  pool text not null check (pool ~ '^[a-z0-9_:.-]{1,64}$'),
  sends int not null default 0 check (sends >= 0),
  primary key (day, pool)
);
alter table public.signup_send_quota enable row level security;
revoke all on public.signup_send_quota from anon, authenticated;

-- the UTC day the slot was charged to, or null when the pool is spent; give-back uses that day
-- (v0.1.1 returned boolean; a guarded drop lets this file upgrade it in place)
do $$ begin
  if exists (select 1 from pg_proc where proname = 'signup_take_send' and pronamespace = 'public'::regnamespace
             and prorettype = 'boolean'::regtype) then
    drop function public.signup_take_send(text, int);
  end if;
end $$;
create or replace function public.signup_take_send(p_pool text, p_limit int)
returns date language sql security invoker set search_path = '' as $$
  insert into public.signup_send_quota as q (day, pool, sends)
  values ((now() at time zone 'utc')::date, p_pool, 1)
  on conflict (day, pool) do update set sends = q.sends + 1 where q.sends < p_limit
  returning day;
$$;
-- read-only check used before any address lookup
create or replace function public.signup_pool_open(p_pool text, p_limit int)
returns boolean language sql security invoker set search_path = '' stable as $$
  select coalesce((select sends < p_limit from public.signup_send_quota
                   where day = (now() at time zone 'utc')::date and pool = p_pool), true);
$$;
create or replace function public.signup_give_back_send(p_pool text, p_day date)
returns void language sql security invoker set search_path = '' as $$
  update public.signup_send_quota set sends = greatest(sends - 1, 0)
  where day = p_day and pool = p_pool;
$$;
revoke execute on function public.signup_take_send(text, int), public.signup_pool_open(text, int),
  public.signup_give_back_send(text, date) from public, anon, authenticated;
grant execute on function public.signup_take_send(text, int), public.signup_pool_open(text, int),
  public.signup_give_back_send(text, date) to service_role;
