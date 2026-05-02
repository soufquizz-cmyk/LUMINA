-- Lumina admin hierarchy (v2): Country → Package → Category (leaf) → channel rules.
-- Run in Supabase SQL editor. If upgrading from v1, backup data first; this drops old admin tables.
-- Do not use DROP POLICY here: Postgres requires the table to exist, so a first-time run would fail
-- on admin_packages / admin_countries. DROP TABLE ... CASCADE removes policies with the tables.

drop table if exists public.admin_channel_rules cascade;
drop table if exists public.admin_categories cascade;
drop table if exists public.admin_packages cascade;
drop table if exists public.admin_countries cascade;
drop table if exists public.admin_hidden_filters cascade;

create table public.admin_countries (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.admin_packages (
  id uuid primary key default gen_random_uuid(),
  country_id uuid not null references public.admin_countries (id) on delete cascade,
  name text not null,
  cover_url text,
  theme_bg text,
  theme_surface text,
  theme_primary text,
  theme_glow text,
  theme_back text,
  created_at timestamptz not null default now(),
  unique (country_id, name)
);

create table public.admin_categories (
  id uuid primary key default gen_random_uuid(),
  package_id uuid not null references public.admin_packages (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (package_id, name)
);

create table public.admin_channel_rules (
  id uuid primary key default gen_random_uuid(),
  match_text text not null,
  category_id uuid not null references public.admin_categories (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.admin_hidden_filters (
  id uuid primary key default gen_random_uuid(),
  needle text not null unique,
  created_at timestamptz not null default now()
);

alter table public.admin_countries enable row level security;
alter table public.admin_packages enable row level security;
alter table public.admin_categories enable row level security;
alter table public.admin_channel_rules enable row level security;
alter table public.admin_hidden_filters enable row level security;

create policy "open read/write admin_countries"
on public.admin_countries for all to anon, authenticated using (true) with check (true);

create policy "open read/write admin_packages"
on public.admin_packages for all to anon, authenticated using (true) with check (true);

create policy "open read/write admin_categories"
on public.admin_categories for all to anon, authenticated using (true) with check (true);

create policy "open read/write admin_channel_rules"
on public.admin_channel_rules for all to anon, authenticated using (true) with check (true);

create policy "open read/write admin_hidden_filters"
on public.admin_hidden_filters for all to anon, authenticated using (true) with check (true);

-- Existing DBs: add theme columns (safe to re-run)
alter table public.admin_packages add column if not exists theme_bg text;
alter table public.admin_packages add column if not exists theme_surface text;
alter table public.admin_packages add column if not exists theme_primary text;
alter table public.admin_packages add column if not exists theme_glow text;
alter table public.admin_packages add column if not exists theme_back text;
alter table public.admin_packages add column if not exists cover_url text;

-- Image des bouquets Supabase : URL publique (Storage ou externe).
-- Storage : créer un bucket public « package-covers » (Dashboard → Storage), puis des politiques
-- lecture/écriture pour rôle `anon` si vous utilisez la clé publishable côté lecteur.

-- Liste des pays reconnus pour le menu (clé = préfixe normalisé du nom de catégorie IPTV).
-- Si la table est vide, le lecteur utilise la liste intégrée (fallback).
create table if not exists public.canonical_countries (
  id uuid primary key default gen_random_uuid(),
  match_key text not null,
  display_name text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (match_key)
);

alter table public.canonical_countries enable row level security;

drop policy if exists "open read/write canonical_countries" on public.canonical_countries;

create policy "open read/write canonical_countries"
on public.canonical_countries for all to anon, authenticated using (true) with check (true);

-- Préfixes retirés au début des noms de chaînes (affichage + règles d’affectation), ex. "FR - ", "[FR] ".
create table if not exists public.admin_channel_name_prefixes (
  id uuid primary key default gen_random_uuid(),
  prefix text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (prefix)
);

alter table public.admin_channel_name_prefixes enable row level security;

drop policy if exists "open read/write admin_channel_name_prefixes" on public.admin_channel_name_prefixes;

create policy "open read/write admin_channel_name_prefixes"
on public.admin_channel_name_prefixes for all to anon, authenticated using (true) with check (true);
