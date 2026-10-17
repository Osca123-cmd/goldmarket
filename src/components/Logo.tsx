"use client";

import { useId } from "react";
import { cx } from "./ui";

/**
 * Logo GOLDMARKET: ubin biru (navy → biru) dengan huruf "G" emas yang garis
 * tengahnya menjadi tren naik. Bentuk yang sama dipakai scripts/gen-icons.ts
 * untuk ikon PWA/notifikasi.
 */
export function LogoMark({ size = 32, className }: { size?: number; className?: string }) {
  // id gradien unik per instance: logo yang sama bisa muncul dua kali (sidebar tersembunyi + header mobile)
  const uid = useId().replace(/:/g, "");
  const tile = `gm-tile-${uid}`;
  const gold = `gm-gold-${uid}`;
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} className={className} aria-hidden>
      <defs>
        <linearGradient id={tile} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3d7bff" />
          <stop offset="0.55" stopColor="#1a3fb8" />
          <stop offset="1" stopColor="#0b1a52" />
        </linearGradient>
        <linearGradient id={gold} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffe39a" />
          <stop offset="0.55" stopColor="#e8b84c" />
          <stop offset="1" stopColor="#b8862b" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="38" height="38" rx="11" fill={`url(#${tile})`} />
      <rect x="1.5" y="1.5" width="37" height="37" rx="10.5" fill="none" stroke={`url(#${gold})`} strokeOpacity=".55" />
      <path d="M2 14 Q20 4 38 12 V2 H2 Z" fill="#fff" opacity=".07" />
      {/* "G": busur + palang yang naik seperti grafik */}
      <path d="M27.7 12.6 A10 10 0 1 0 30 21" fill="none" stroke={`url(#${gold})`} strokeWidth="3.6" strokeLinecap="round" />
      <path d="M19.5 23.5 L23.5 19.5 L26 22 L31 16.5" fill="none" stroke={`url(#${gold})`} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="31.4" cy="9.2" r="1.7" fill="#ffd36a" />
    </svg>
  );
}

export function Logo({ className, tagline }: { className?: string; tagline?: boolean }) {
  return (
    <div className={cx("flex items-center gap-2.5", className)}>
      <LogoMark size={34} className="shrink-0 drop-shadow-[0_6px_14px_rgba(47,107,255,0.45)]" />
      <div className="leading-none">
        <div className="text-[17px] font-extrabold tracking-[0.14em]">
          <span className="text-gold-gradient">GOLD</span>
          <span className="text-blue-gradient">MARKET</span>
        </div>
        {tagline && <div className="mt-1 text-[10px] font-medium tracking-wide text-muted">XAUUSD · analisis informasional</div>}
      </div>
    </div>
  );
}
