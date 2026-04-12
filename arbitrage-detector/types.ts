export type OrderSide = 'BUY' | 'SELL'
export type OrderType = 'MARKET' | 'LIMIT_IOC'
export type OrderStatus = 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED'

export interface OrderResult {
  orderId: string
  clientOrderId: string
  status: OrderStatus
  filledQty: number      // base asset quantity filled
  avgFillPrice: number   // 0 if not yet filled
  feeUsdt: number        // approximate; non-USDT fees converted at fill price
  timestamp: number
}
