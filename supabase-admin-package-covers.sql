-- Additive migration: images for bouquets that are NOT rows in admin_packages (ex. id fournisseur "903").
-- Run in Supabase → SQL → New query if you see: Could not find the table 'public.admin_package_covers' in the schema cache.

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

alter table public.admin_package_covers add column if not exists theme_bg text;
alter table public.admin_package_covers add column if not exists theme_surface text;
alter table public.admin_package_covers add column if not exists theme_primary text;
alter table public.admin_package_covers add column if not exists theme_glow text;
alter table public.admin_package_covers add column if not exists theme_back text;
alter table public.admin_package_covers alter column cover_url drop not null;
