"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { isConfigured } from "@/lib/supabase";
import { registerSw } from "@/lib/push";
import { effectiveStatus } from "@/lib/market";
import { MarketProvider, useMarket } from "./MarketContext";
import { NotificationCenter } from "./NotificationCenter";
import { StatusBadge, cx, fmt, useNow } from "./ui";
import { Logo } from "./Logo";

const NAV = [
  { href: "/", label: "Dashboard", short: "Home", icon: "M3 12l9-8 9 8M5 10v10h14V10" },
  { href: "/opportunities/", label: "Live Opportunities", short: "Peluang", icon: "M13 2L3 14h8l-1 8 10-12h-8z" },
  { href: "/chart/", label: "Chart & Analysis", short: "Chart", icon: "M4 20V10M10 20V4M16 20v-8M22 20H2" },
  { href: "/news/", label: "News AI", short: "News", icon: "M4 5h13v14H6a2 2 0 0 1-2-2zM17 9h3v8a2 2 0 0 1-2 2M8 9h5M8 13h5M8 16h3" },
  { href: "/ai-chart/", label: "Analisa AI Gambar", short: "AI Gambar", icon: "M4 6h16v12H4zM4 15l4-4 3 3 4-5 5 6M8.5 9.5h.01" },
  { href: "/risk/", label: "Kalkulator Risiko", short: "Risiko", icon: "M12 3v18M5 8h14M7 16h10" },
  { href: "/journal/", label: "Jurnal Trading", short: "Jurnal", icon: "M5 4h11l3 3v13H5zM9 9h6M9 13h6M9 17h4" },
  { href: "/stats/", label: "Statistik", short: "Statistik", icon: "M4 19h16M7 16V9M12 16V5M17 16v-4" },
  { href: "/settings/", label: "Pengaturan", short: "Atur", icon: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" },
];

function Icon({ d, className }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={d} />
    </svg>
  );
}

export { Logo } from "./Logo";

function TopBar() {
  const { snapshot, channel } = useMarket();
  const now = useNow(5000);
  const status = effectiveStatus(snapshot, now);
  const up = (snapshot?.day_change ?? 0) >= 0;
  return (
    <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-line/70 bg-bg/70 px-4 py-3 backdrop-blur-xl lg:px-6">
      <Logo className="lg:hidden" />
      <div className="flex min-w-0 flex-1 items-center justify-end gap-2 sm:gap-3 lg:justify-start">
        <div className="hidden min-w-0 items-baseline gap-2 sm:flex">
          <span className="text-xs font-semibold tracking-wider text-blue-strong">XAUUSD</span>
          <span className="num text-gold-gradient text-base font-bold">{fmt(snapshot?.price)}</span>
          {snapshot?.day_change_pct != null && (
            <span className={cx("num text-xs", up ? "text-buy" : "text-sell")}>
              {up ? "+" : ""}
              {fmt(snapshot.day_change_pct)}%
            </span>
          )}
        </div>
        <StatusBadge status={status} />
        <span className="hidden text-[11px] text-muted md:inline" title="Koneksi browser ke server">
          {channel === "websocket" ? "WebSocket" : channel === "polling" ? "Polling" : channel === "offline" ? "Offline" : "Menghubungkan…"}
        </span>
      </div>
      <NotificationCenter />
    </header>
  );
}

function Sidebar({ onSignOut, email }: { onSignOut: () => void; email: string }) {
  const path = usePathname();
  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col border-r border-line/70 bg-[linear-gradient(180deg,#0c1638_0%,#081029_60%,#070d22_100%)] lg:flex">
      <div className="px-5 py-6">
        <Logo tagline />
      </div>
      <div className="mx-5 mb-3 h-px bg-gradient-to-r from-blue/50 via-gold/40 to-transparent" />
      <nav className="flex-1 space-y-1 px-3" aria-label="Menu utama">
        {NAV.map((n) => {
          const active = n.href === "/" ? path === "/" : path?.startsWith(n.href.replace(/\/$/, ""));
          return (
            <Link
              key={n.href}
              href={n.href}
              className={cx(
                "relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition",
                active ? "bg-gradient-to-r from-blue/30 via-blue/10 to-transparent text-ink shadow-[inset_0_0_0_1px_rgb(91_140_255/0.25)]" : "text-muted hover:bg-surface-2/70 hover:text-ink",
              )}
            >
              {active && <span className="absolute inset-y-2 left-0 w-1 rounded-r-full bg-gradient-to-b from-gold-strong to-gold-deep" />}
              <Icon d={n.icon} className={active ? "text-gold" : undefined} />
              {n.label}
            </Link>
          );
        })}
      </nav>
      <div className="m-3 rounded-xl border border-line/70 bg-surface-2/50 p-3 text-xs text-muted">
        <div className="truncate" title={email}>
          {email}
        </div>
        <button className="mt-2 text-gold hover:underline" onClick={onSignOut}>
          Keluar (logout)
        </button>
      </div>
    </aside>
  );
}

function MobileNav() {
  const path = usePathname();
  const [more, setMore] = useState(false);
  const main = NAV.slice(0, 4);
  const rest = NAV.slice(4);
  return (
    <>
      <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-line/70 bg-[#081029]/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden" aria-label="Navigasi mobile">
        {main.map((n) => {
          const active = n.href === "/" ? path === "/" : path?.startsWith(n.href.replace(/\/$/, ""));
          return (
            <Link key={n.href} href={n.href} className={cx("relative flex flex-col items-center gap-0.5 py-2 text-[10px] font-medium", active ? "text-gold" : "text-muted")}>
              {active && <span className="absolute inset-x-6 top-0 h-0.5 rounded-b-full bg-gradient-to-r from-blue-strong to-gold" />}
              <Icon d={n.icon} />
              {n.short}
            </Link>
          );
        })}
        <button className={cx("flex flex-col items-center gap-0.5 py-2 text-[10px] font-medium", more ? "text-gold" : "text-muted")} onClick={() => setMore((m) => !m)} aria-expanded={more}>
          <Icon d="M4 6h16M4 12h16M4 18h16" />
          Lainnya
        </button>
      </nav>
      {more && (
        <div className="fixed inset-x-3 bottom-20 z-40 card p-2 lg:hidden" onClick={() => setMore(false)}>
          {rest.map((n) => (
            <Link key={n.href} href={n.href} className="flex items-center gap-3 rounded-xl px-3 py-3 text-sm text-ink hover:bg-surface-2">
              <Icon d={n.icon} />
              {n.label}
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { session, loading, signOut } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (!loading && !session) router.replace("/login/");
  }, [loading, session, router]);
  useEffect(() => {
    void registerSw();
  }, []);

  if (!isConfigured) {
    return (
      <div className="mx-auto max-w-lg p-6">
        <div className="card">
          <Logo />
          <p className="mt-3 text-sm text-muted">
            Konfigurasi belum lengkap: set <code className="text-gold">NEXT_PUBLIC_SUPABASE_URL</code> dan <code className="text-gold">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> lalu build ulang.
          </p>
        </div>
      </div>
    );
  }
  if (loading || !session) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-muted">Memuat sesi…</div>;
  }
  return (
    <MarketProvider>
      <Sidebar email={session.user.email ?? ""} onSignOut={() => void signOut()} />
      <div className="min-h-screen lg:pl-64">
        <TopBar />
        <main className="mx-auto w-full max-w-7xl px-4 pb-28 pt-4 lg:px-6 lg:pb-10">{children}</main>
      </div>
      <MobileNav />
    </MarketProvider>
  );
}
