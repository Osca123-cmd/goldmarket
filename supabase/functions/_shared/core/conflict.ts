/**
 * Sinyal BERTENTANGAN: dua setup arah berlawanan yang sama-sama masih hidup (menunggu entry atau
 * sedang berjalan) dengan entry berdekatan (≤ jarak SL terbesar keduanya). Hanya peringatan —
 * keduanya tetap dikirim dan dilacak; pengguna memilih salah satu.
 */
export interface ConflictView {
  id: string;
  direction: "BUY" | "SELL";
  timeframe: string;
  entry_price: number;
  sl: number;
  status: string;
  eligible: boolean;
  outcome?: string | null;
}

export function isLiveSignal(s: ConflictView): boolean {
  if (s.status === "approaching" || s.status === "awaiting_confirmation") return s.eligible;
  return s.status === "entry_touched" && (s.outcome == null || s.outcome === "open");
}

export function findConflicts<T extends ConflictView>(s: ConflictView, others: T[]): T[] {
  if (!isLiveSignal(s)) return [];
  const risk = Math.abs(s.entry_price - s.sl);
  return others.filter(
    (o) => o.id !== s.id && o.direction !== s.direction && isLiveSignal(o) && Math.abs(o.entry_price - s.entry_price) <= Math.max(risk, Math.abs(o.entry_price - o.sl)),
  );
}

export function conflictText(o: ConflictView): string {
  return `${o.direction} ${o.timeframe} ${o.entry_price.toFixed(2)} (${o.status === "entry_touched" ? "entry tersentuh" : "menunggu entry"})`;
}
