import { Config } from './config'

export interface Tick {
  bidPrice: number
  askPrice: number
}

export interface SpreadResult {
  rawSpreadPct: number
  allInCostPct: number
  netSpreadPct: number
  isOpportunity: boolean
  estimatedPnlUsdt: number
  exchangeBuy: string
  exchangeSell: string
  askBuy: number
  bidSell: number
}

export function computeSpread(
  exchangeA: string, tickA: Tick,
  exchangeB: string, tickB: Tick,
  config: Config
): SpreadResult {
  const cfgA = config.exchanges[exchangeA]
  const cfgB = config.exchanges[exchangeB]

  const allInCostAB =
    cfgA.taker_fee_pct + cfgB.taker_fee_pct +
    cfgA.slippage_estimate_pct + cfgB.slippage_estimate_pct

  const allInCostBA =
    cfgB.taker_fee_pct + cfgA.taker_fee_pct +
    cfgB.slippage_estimate_pct + cfgA.slippage_estimate_pct

  // Direction: buy A, sell B
  const rawAB = (tickB.bidPrice - tickA.askPrice) / tickA.askPrice * 100
  const netAB = rawAB - allInCostAB
  const oppAB =
    netAB >= config.min_net_spread_pct &&
    netAB >= allInCostAB * config.entry_buffer_multiplier

  // Direction: buy B, sell A
  const rawBA = (tickA.bidPrice - tickB.askPrice) / tickB.askPrice * 100
  const netBA = rawBA - allInCostBA
  const oppBA =
    netBA >= config.min_net_spread_pct &&
    netBA >= allInCostBA * config.entry_buffer_multiplier

  if (oppAB && (!oppBA || netAB >= netBA)) {
    return buildResult(exchangeA, tickA.askPrice, exchangeB, tickB.bidPrice, rawAB, allInCostAB, netAB, true, config)
  }

  if (oppBA) {
    return buildResult(exchangeB, tickB.askPrice, exchangeA, tickA.bidPrice, rawBA, allInCostBA, netBA, true, config)
  }

  // No opportunity — return the better direction (even if negative)
  if (netAB >= netBA) {
    return buildResult(exchangeA, tickA.askPrice, exchangeB, tickB.bidPrice, rawAB, allInCostAB, netAB, false, config)
  }
  return buildResult(exchangeB, tickB.askPrice, exchangeA, tickA.bidPrice, rawBA, allInCostBA, netBA, false, config)
}

function buildResult(
  exchangeBuy: string, askBuy: number,
  exchangeSell: string, bidSell: number,
  rawSpreadPct: number,
  allInCostPct: number,
  netSpreadPct: number,
  isOpportunity: boolean,
  config: Config
): SpreadResult {
  return {
    rawSpreadPct,
    allInCostPct,
    netSpreadPct,
    isOpportunity,
    estimatedPnlUsdt: (netSpreadPct / 100) * config.capital_per_trade_usdt,
    exchangeBuy,
    exchangeSell,
    askBuy,
    bidSell,
  }
}
