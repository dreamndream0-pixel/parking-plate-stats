-- Supabase 資料表（已套用到 parking-plate-stats 專案；換新專案時在 SQL Editor 執行一次）
-- 伺服器用 publishable key + x-app-secret header 存取；沒有正確密鑰的請求被 RLS 擋下。
create extension if not exists pgcrypto;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table private.app_config (
  id int primary key default 1 check (id = 1),
  secret text not null default encode(gen_random_bytes(24), 'hex')
);
insert into private.app_config default values;
-- 取得密鑰（填到 SUPABASE_APP_SECRET）：select secret from private.app_config;

create or replace function public.app_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (current_setting('request.headers', true)::json ->> 'x-app-secret') = (select secret from private.app_config where id = 1),
    false)
$$;
revoke all on function public.app_ok() from public;
grant execute on function public.app_ok() to anon, authenticated;

create table public.events (
  id bigint generated always as identity primary key,
  plate text not null,
  direction text not null check (direction in ('in','out','auto')),
  taken_at timestamptz not null,
  time_source text not null,
  photo text not null,
  confidence real,
  vehicle text,
  ai_plate text,
  gate text,
  created_at timestamptz not null default now()
);
create index events_plate_idx on public.events (plate, taken_at);
create index events_time_idx on public.events (taken_at);
alter table public.events enable row level security;
create policy events_app on public.events for all to anon using (public.app_ok()) with check (public.app_ok());

create table public.photos (
  name text primary key,
  data bytea not null,
  created_at timestamptz not null default now()
);
alter table public.photos enable row level security;
create policy photos_app on public.photos for all to anon using (public.app_ok()) with check (public.app_ok());

create or replace function public.put_photo(p_name text, p_b64 text) returns void
language sql security invoker set search_path = '' as $$
  insert into public.photos (name, data) values (p_name, decode(p_b64, 'base64'))
  on conflict (name) do update set data = excluded.data
$$;
create or replace function public.get_photo(p_name text) returns text
language sql stable security invoker set search_path = '' as $$
  select encode(data, 'base64') from public.photos where name = p_name
$$;
create or replace function public.delete_photo_if_unused(p_name text) returns void
language sql security invoker set search_path = '' as $$
  delete from public.photos where name = p_name
    and not exists (select 1 from public.events where photo = p_name)
$$;
revoke all on function public.put_photo(text, text), public.get_photo(text), public.delete_photo_if_unused(text) from public;
grant execute on function public.put_photo(text, text), public.get_photo(text), public.delete_photo_if_unused(text) to anon;

-- 員工暫時離開（空檔）與回來盤點
create table public.gaps (
  id bigint generated always as identity primary key,
  start_at timestamptz not null,
  end_at timestamptz,
  audit_done boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.gaps enable row level security;
create policy gaps_app on public.gaps for all to anon using (public.app_ok()) with check (public.app_ok());

alter table public.events add column gap_id bigint references public.gaps(id) on delete set null;
alter table public.events add column estimated_from timestamptz; -- 有值表示實際時間介於 estimated_from 和 taken_at 之間（空檔推估）
