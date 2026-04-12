// Level-2 order book fetching and effective fill computation.
// Used by ExecutionCoordinator to replace fixed slippage_estimate_pct with
// a per-trade value derived from actual book depth.

export interface Level {
  price: number
  qty: number
}

export interface EffectiveFill {
  avgPrice: number    // average execution price across all levels consumed
  filledUsdt: number  // how much notional can actually be filled
  slippagePct: number // (avgPrice - bestPrice) / bestPrice * 100; always positive
  fillRatio: number   // filledUsdt / requestedUsdt; < 1 means book is too thin
}

// Walk `levels` (asks for BUY, bids for SELL) to fill `notionalUsdt`.
// Levels must be sorted best-first: asks ascending, bids descending.
export function computeEffectiveFill(
  levels: Level[],
  notionalUsdt: number,
  side: 'buy' | 'sell',
): EffectiveFill {
  const bestPrice = levels[0]?.price ?? 0
  if (!bestPrice || levels.length === 0) {
    return { avgPrice: 0, filledUsdt: 0, slippagePct: 0, fillRatio: 0 }
  }

  let remaining = notionalUsdt
  let totalQty = 0
  let totalCost = 0

  for (const level of levels) {
    if (remaining <= 0) break
    const levelUsdt = level.price * level.qty
    const fillUsdt = Math.min(remaining, levelUsdt)
    const fillQty = fillUsdt / level.price
    totalQty += fillQty
    totalCost += fillUsdt
    remaining -= fillUsdt
  }

  const avgPrice = totalQty > 0 ? totalCost / totalQty : bestPrice
  const slippagePct = side === 'buy'
    ? Math.max(0, (avgPrice - bestPrice) / bestPrice * 100)
    : Math.max(0, (bestPrice - avgPrice) / bestPrice * 100)

  return {
    avgPrice,
    filledUsdt: totalCost,
    slippagePct,
    fillRatio: totalCost / notionalUsdt,
  }
}

// Parse raw exchange order book response into sorted Level arrays.
export function parseLevels(raw: Array<[string, string]>): Level[] {
  return raw.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }))
    .filter(l => l.price > 0 && l.qty > 0)
}
