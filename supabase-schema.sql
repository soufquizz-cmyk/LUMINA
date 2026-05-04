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

-- Image des bouquets : URL publique (externe, Supabase Storage, ou Cloudflare R2 via Worker).
-- Storage Supabase : bucket public « package-covers » (Dashboard → Storage) + politiques anon.
-- Cloudflare : voir cloudflare-workers/package-cover-r2/README.md (fichiers sur R2, URL enregistrée ici).

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

-- Déplacements / masquage de chaînes par pays (ex. bouquets France : beIN, Canal, Disney).
-- `target_package_id` = id du bouquet cible (UUID Supabase, id catégorie fournisseur, ou ids synthétiques
-- velagg:fr:bein | velagg:fr:canal | velagg:fr:disney), ou la valeur littérale `hidden` pour masquer.
create table if not exists public.admin_stream_curations (
  id uuid primary key default gen_random_uuid(),
  stream_id bigint not null,
  country_id uuid not null references public.admin_countries (id) on delete cascade,
  target_package_id text not null,
  created_at timestamptz not null default now(),
  unique (stream_id, country_id)
);

create index if not exists admin_stream_curations_country_id_idx on public.admin_stream_curations (country_id);

alter table public.admin_stream_curations enable row level security;

drop policy if exists "open read/write admin_stream_curations" on public.admin_stream_curations;

create policy "open read/write admin_stream_curations"
on public.admin_stream_curations for all to anon, authenticated using (true) with check (true);

-- Images de bouquets hors `admin_packages` (catégories fournisseur, ex. velagg:fr:bein) ou surcharges explicites.
create table if not exists public.admin_package_covers (
  package_id text primary key,
  cover_url text,
  theme_bg text,
  theme_surface text,
  theme_primary text,
  theme_glow text,
  theme_back text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.admin_package_covers enable row level security;

drop policy if exists "open read/write admin_package_covers" on public.admin_package_covers;

create policy "open read/write admin_package_covers"
on public.admin_package_covers for all to anon, authenticated using (true) with check (true);

-- Existing DBs: couleurs de thème sur surcharges catalogue + cover_url nullable
alter table public.admin_package_covers add column if not exists theme_bg text;
alter table public.admin_package_covers add column if not exists theme_surface text;
alter table public.admin_package_covers add column if not exists theme_primary text;
alter table public.admin_package_covers add column if not exists theme_glow text;
alter table public.admin_package_covers add column if not exists theme_back text;
alter table public.admin_package_covers alter column cover_url drop not null;
