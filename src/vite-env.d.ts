/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PROXY_PREFIX?: string;
  readonly NEXT_PUBLIC_SUPABASE_URL?: string;
  readonly NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
