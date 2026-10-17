import type { NextConfig } from "next";

// Frontend diekspor statis: semua logika server berjalan di Supabase
// (Postgres + RLS, Auth, Storage, Edge Functions, pg_cron).
const nextConfig: NextConfig = {
  output: "export",
  outputFileTracingRoot: process.cwd(),
  trailingSlash: true,
  images: { unoptimized: true },
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
};

export default nextConfig;
