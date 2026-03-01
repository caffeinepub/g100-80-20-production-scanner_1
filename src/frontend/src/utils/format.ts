export function formatPrice(price: number): string {
  if (!Number.isFinite(price)) return "--";
  if (price >= 1000) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.01) return price.toFixed(5);
  return price.toFixed(6);
}

export function formatRsi(rsi: number): string {
  if (!Number.isFinite(rsi)) return "--";
  return rsi.toFixed(1);
}

export function formatScore(score: number): string {
  if (!Number.isFinite(score)) return "--";
  return score.toFixed(3);
}

export function formatVolume(vol: number): string {
  if (vol >= 1_000_000_000) return `${(vol / 1_000_000_000).toFixed(1)}B`;
  if (vol >= 1_000_000) return `${(vol / 1_000_000).toFixed(0)}M`;
  if (vol >= 1_000) return `${(vol / 1_000).toFixed(0)}K`;
  return vol.toFixed(0);
}

export function formatTs(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour12: false });
}

export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}
