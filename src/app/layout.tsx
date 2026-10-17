import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AuthProvider } from "@/lib/auth";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const metadata: Metadata = {
  manifest: `${BASE}/manifest.webmanifest`,
  icons: { icon: `${BASE}/favicon.png`, apple: `${BASE}/apple-touch-icon.png` },
  appleWebApp: { capable: true, title: "GOLDMARKET", statusBarStyle: "black-translucent" },
  title: "GOLDMARKET — Analisis XAUUSD",
  description: "Platform analisis XAUUSD: data pasar, setup otomatis, kalkulator risiko, notifikasi, dan jurnal trading. Informasional, bukan eksekusi order.",
};

export const viewport: Viewport = { themeColor: "#050a1a", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet" />
      </head>
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
