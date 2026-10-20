"use client";

import { useId } from "react";
import { cx } from "./ui";

export type MascotKind = "bull" | "bear" | "both";
/** live = bergerak (data live); still = diam & redup (demo/delayed/terganggu); sleep = tidur (jam istirahat / pasar tutup) */
export type MascotMood = "live" | "still" | "sleep";

function Eyes({ y, lx, rx, sleep }: { y: number; lx: number; rx: number; sleep: boolean }) {
  if (sleep)
    return (
      <g fill="none" stroke="#3b2606" strokeWidth="1.6" strokeLinecap="round">
        <path d={`M${lx - 2.4} ${y} Q${lx} ${y + 2} ${lx + 2.4} ${y}`} />
        <path d={`M${rx - 2.4} ${y} Q${rx} ${y + 2} ${rx + 2.4} ${y}`} />
      </g>
    );
  return (
    <>
      <ellipse className="m-eye" cx={lx} cy={y} rx="2.3" ry="3" fill="#3b2606" />
      <ellipse className="m-eye" cx={rx} cy={y} rx="2.3" ry="3" fill="#3b2606" />
      <circle cx={lx + 0.8} cy={y - 1} r=".8" fill="#fff" />
      <circle cx={rx + 0.8} cy={y - 1} r=".8" fill="#fff" />
    </>
  );
}

function Bull({ gold, sleep }: { gold: string; sleep: boolean }) {
  return (
    <g className="m-nod">
      <path d="M14 22 Q6 18 7 9 Q12 16 19 17 Z" fill="#fff1c9" />
      <path d="M46 22 Q54 18 53 9 Q48 16 41 17 Z" fill="#fff1c9" />
      <ellipse cx="12" cy="27" rx="5" ry="3" fill="#d9a441" transform="rotate(-20 12 27)" />
      <ellipse cx="48" cy="27" rx="5" ry="3" fill="#d9a441" transform="rotate(20 48 27)" />
      <path d="M17 22 Q30 14 43 22 Q47 36 41 46 Q30 52 19 46 Q13 36 17 22 Z" fill={`url(#${gold})`} />
      <ellipse cx="30" cy="42" rx="10" ry="6.5" fill="#ffe3a0" />
      <ellipse cx="26.5" cy="42" rx="1.5" ry="2" fill="#7a5410" />
      <ellipse cx="33.5" cy="42" rx="1.5" ry="2" fill="#7a5410" />
      <Eyes y={30} lx={24} rx={36} sleep={sleep} />
    </g>
  );
}

function Bear({ gold, sleep }: { gold: string; sleep: boolean }) {
  return (
    <g className="m-nod">
      <circle cx="16" cy="18" r="7" fill="#c08a2a" />
      <circle cx="44" cy="18" r="7" fill="#c08a2a" />
      <circle cx="16" cy="18" r="3.5" fill="#ffe3a0" />
      <circle cx="44" cy="18" r="3.5" fill="#ffe3a0" />
      <circle cx="30" cy="32" r="18" fill={`url(#${gold})`} />
      <ellipse cx="30" cy="40" rx="8" ry="6" fill="#ffe3a0" />
      <ellipse cx="30" cy="37.5" rx="3" ry="2.2" fill="#3b2606" />
      <path d="M27 42 Q30 44.5 33 42" fill="none" stroke="#3b2606" strokeWidth="1.4" strokeLinecap="round" />
      <Eyes y={29} lx={23.5} rx={36.5} sleep={sleep} />
    </g>
  );
}

/**
 * Maskot status di halaman Peluang: banteng saat engine mencari BUY, beruang saat mencari SELL, keduanya saat netral.
 * Bergerak hanya saat data live; diam & redup bila data demo/tertunda/terganggu; tidur saat jam istirahat atau pasar tutup.
 */
export function Mascot({ kind, mood, size = 56, className }: { kind: MascotKind; mood: MascotMood; size?: number; className?: string }) {
  const gold = `m-gold-${useId().replace(/:/g, "")}`;
  const sleep = mood === "sleep";
  return (
    <svg viewBox="0 0 64 60" width={size} height={size * (60 / 64)} className={cx("shrink-0 overflow-visible", mood === "live" ? "mascot-live" : "opacity-70", className)} aria-hidden>
      <defs>
        <linearGradient id={gold} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffe9a8" />
          <stop offset=".5" stopColor="#f2c55a" />
          <stop offset="1" stopColor="#c08a2a" />
        </linearGradient>
      </defs>
      {kind === "both" ? (
        <>
          <g transform="translate(18 4) scale(.8)">
            <Bear gold={gold} sleep={sleep} />
          </g>
          <g transform="translate(-4 8) scale(.8)">
            <Bull gold={gold} sleep={sleep} />
          </g>
        </>
      ) : kind === "bull" ? (
        <Bull gold={gold} sleep={sleep} />
      ) : (
        <Bear gold={gold} sleep={sleep} />
      )}
      {sleep ? (
        <text x="50" y="14" fontFamily="Inter, sans-serif" fontWeight="800" fontSize="10" fill="#8e9cc9">
          z<tspan dx="1" dy="-5" fontSize="7">z</tspan>
        </text>
      ) : kind === "bull" ? (
        <path className="m-bob" d="M53 50 L57 44 L61 50" fill="none" stroke="#22c58b" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      ) : kind === "bear" ? (
        <path className="m-bob" d="M53 44 L57 50 L61 44" fill="none" stroke="#f0506e" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      ) : null}
    </svg>
  );
}
