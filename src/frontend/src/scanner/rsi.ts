/**
 * Wilder's RMA RSI — deterministic
 * Standard Wilder smoothing: first value = SMA of first `period` gains/losses,
 * then RMA: avg = (prev_avg * (period-1) + current) / period
 */
export function computeRSI(closes: number[], period: number): number[] {
  if (closes.length < period + 1) return [];

  const gains: number[] = [];
  const losses: number[] = [];

  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }

  if (gains.length < period) return [];

  // First avg = simple mean of first `period` values
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  const rsiValues: number[] = [];

  // First RSI value
  if (avgLoss === 0) {
    rsiValues.push(100);
  } else {
    const rs = avgGain / avgLoss;
    rsiValues.push(100 - 100 / (1 + rs));
  }

  // Subsequent values via Wilder smoothing (RMA)
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;

    if (avgLoss === 0) {
      rsiValues.push(100);
    } else {
      const rs = avgGain / avgLoss;
      rsiValues.push(100 - 100 / (1 + rs));
    }
  }

  return rsiValues;
}

export function getLastRSI(closes: number[], period: number): number {
  const values = computeRSI(closes, period);
  if (values.length === 0) return Number.NaN;
  return values[values.length - 1];
}
