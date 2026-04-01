import express, { Request, Response } from "express";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";

const app = express();
app.use(express.json());
const PORT = 3000;

type OrderBook = {
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
};

// --- Scenario types ---

type TimelineEntry = {
  bid: string;
  ask: string;
  bid_qty?: string;
  ask_qty?: string;
};

type ExchangeScenario = {
  symbol: string;
  result_key?: string;
  timeline: TimelineEntry[];
};

type Scenario = {
  name: string;
  exchanges: {
    binance?: ExchangeScenario;
    bybit?: ExchangeScenario;
    kraken?: ExchangeScenario;
  };
};

// --- Scenario state ---

let activeScenario: Scenario | null = null;
let stepCounters: Record<string, number> = {};
let advanceMode = true;

const scenarioFlagIndex = process.argv.indexOf("--scenario");
if (scenarioFlagIndex !== -1 && process.argv[scenarioFlagIndex + 1]) {
  const scenarioPath = path.resolve(__dirname, process.argv[scenarioFlagIndex + 1]);
  const raw = fs.readFileSync(scenarioPath, "utf-8");
  activeScenario = yaml.load(raw) as Scenario;
  for (const exName of Object.keys(activeScenario.exchanges)) {
    stepCounters[exName] = 0;
  }
  console.log(`Scenario loaded: ${activeScenario.name}`);
} else {
  console.log("No scenario — using hardcoded defaults");
}

// --- Scenario helpers ---

function getCurrentEntry(exchangeName: string, timeline: TimelineEntry[]): TimelineEntry {
  const step = Math.min(stepCounters[exchangeName] ?? 0, timeline.length - 1);
  return timeline[step];
}

function buildDepthFromEntry(entry: TimelineEntry): { bids: [string, string][]; asks: [string, string][] } {
  const bidQty = entry.bid_qty ?? "1.000";
  const askQty = entry.ask_qty ?? "1.000";
  return {
    bids: [
      [entry.bid, bidQty],
      [String(parseFloat(entry.bid) - 0.01), bidQty],
    ],
    asks: [
      [entry.ask, askQty],
      [String(parseFloat(entry.ask) + 0.01), askQty],
    ],
  };
}

// --- Binance ---

type BinanceBookTicker = {
  symbol: string;
  bidPrice: string;
  bidQty: string;
  askPrice: string;
  askQty: string;
};

const binanceBookTickers: Record<string, BinanceBookTicker> = {
  BTCUSDT: { symbol: "BTCUSDT", bidPrice: "43250.00", bidQty: "1.500", askPrice: "43251.00", askQty: "1.200" },
  ETHUSDT: { symbol: "ETHUSDT", bidPrice: "2650.00", bidQty: "5.200", askPrice: "2651.00", askQty: "4.100" },
};

const binanceDepths: Record<string, OrderBook> = {
  BTCUSDT: {
    lastUpdateId: 1027024,
    bids: [["43250.00", "1.500"], ["43249.00", "2.300"]],
    asks: [["43251.00", "1.200"], ["43252.00", "0.800"]],
  },
  ETHUSDT: {
    lastUpdateId: 1027025,
    bids: [["2650.00", "5.200"], ["2649.50", "8.750"]],
    asks: [["2651.00", "4.100"], ["2651.50", "3.600"]],
  },
};

// 24h volume data — used by pair-fetcher (representative mock values)
const binanceTickers24hr = [
  { symbol: "BTCUSDT", volume: "15234.50",   quoteVolume: "658432100.00" },
  { symbol: "ETHUSDT", volume: "112500.00",  quoteVolume: "225000000.00" },
  { symbol: "SOLUSDT", volume: "820000.00",  quoteVolume: "98400000.00"  },
  { symbol: "ARBUSDT", volume: "4800000.00", quoteVolume: "3360000.00"   },
  { symbol: "WIFUSDT", volume: "1800000.00", quoteVolume: "3600000.00"   },
];

const binanceRouter = express.Router();

binanceRouter.get("/api/v3/ping", (_req: Request, res: Response) => {
  res.json({});
});

// All pairs with 24h volume — used by pair-fetcher
binanceRouter.get("/api/v3/ticker/24hr", (_req: Request, res: Response) => {
  res.json(binanceTickers24hr);
});

binanceRouter.get("/api/v3/ticker/bookTicker", (req: Request, res: Response) => {
  const symbol = req.query.symbol as string | undefined;
  if (!symbol || !binanceBookTickers[symbol]) {
    res.status(400).json({ code: -1121, msg: "Invalid symbol." });
    return;
  }
  const binanceScenario = activeScenario?.exchanges.binance;
  if (binanceScenario?.symbol === symbol) {
    const entry = getCurrentEntry("binance", binanceScenario.timeline);
    if (entry) {
      res.json({
        symbol,
        bidPrice: entry.bid,
        bidQty: entry.bid_qty ?? "1.000",
        askPrice: entry.ask,
        askQty: entry.ask_qty ?? "1.000",
      });
      return;
    }
  }
  res.json(binanceBookTickers[symbol]);
});

binanceRouter.get("/api/v3/depth", (req: Request, res: Response) => {
  const symbol = req.query.symbol as string | undefined;
  if (!symbol || !binanceDepths[symbol]) {
    res.status(400).json({ code: -1121, msg: "Invalid symbol." });
    return;
  }
  const binanceScenario = activeScenario?.exchanges.binance;
  if (binanceScenario?.symbol === symbol) {
    const entry = getCurrentEntry("binance", binanceScenario.timeline);
    if (entry) {
      const { bids, asks } = buildDepthFromEntry(entry);
      res.json({ lastUpdateId: binanceDepths[symbol].lastUpdateId, bids, asks });
      return;
    }
  }
  res.json(binanceDepths[symbol]);
});

// --- Bybit ---

type BybitOrderbookResult = {
  s: string;
  b: [string, string][];
  a: [string, string][];
};

type BybitTickerItem = {
  symbol: string;
  bid1Price: string;
  bid1Size: string;
  ask1Price: string;
  ask1Size: string;
  volume24h: string;   // base asset 24h volume — used by pair-fetcher
  turnover24h: string; // quote asset 24h volume (USDT)
};

const bybitTickers: Record<string, BybitTickerItem> = {
  BTCUSDT: { symbol: "BTCUSDT", bid1Price: "43249.00", bid1Size: "1.500", ask1Price: "43251.50", ask1Size: "1.200", volume24h: "12000.00",   turnover24h: "518400000.00" },
  ETHUSDT: { symbol: "ETHUSDT", bid1Price: "2649.00",  bid1Size: "5.200", ask1Price: "2651.00",  ask1Size: "4.100", volume24h: "95000.00",    turnover24h: "190000000.00" },
  SOLUSDT: { symbol: "SOLUSDT", bid1Price: "120.00",   bid1Size: "500.0", ask1Price: "120.10",   ask1Size: "500.0", volume24h: "650000.00",   turnover24h: "78000000.00"  },
  ARBUSDT: { symbol: "ARBUSDT", bid1Price: "0.70",     bid1Size: "1000",  ask1Price: "0.701",    ask1Size: "1000",  volume24h: "3900000.00",  turnover24h: "2730000.00"   },
  WIFUSDT: { symbol: "WIFUSDT", bid1Price: "2.00",     bid1Size: "500",   ask1Price: "2.001",    ask1Size: "500",   volume24h: "1500000.00",  turnover24h: "3000000.00"   },
};

const bybitOrderbooks: Record<string, BybitOrderbookResult> = {
  BTCUSDT: {
    s: "BTCUSDT",
    b: [["43249.00", "1.500"], ["43248.00", "2.300"]],
    a: [["43251.50", "1.200"], ["43252.00", "0.800"]],
  },
  ETHUSDT: {
    s: "ETHUSDT",
    b: [["2649.00", "5.200"], ["2648.50", "8.750"]],
    a: [["2651.00", "4.100"], ["2651.50", "3.600"]],
  },
};

const bybitRouter = express.Router();

bybitRouter.get("/v5/market/time", (_req: Request, res: Response) => {
  res.json({
    retCode: 0,
    retMsg: "OK",
    result: { timeSecond: String(Math.floor(Date.now() / 1000)) },
  });
});

bybitRouter.get("/v5/market/tickers", (req: Request, res: Response) => {
  const symbol = req.query.symbol as string | undefined;
  const category = (req.query.category as string | undefined) ?? "spot";

  // No symbol — return all tickers (used by pair-fetcher for 24h volume)
  if (!symbol) {
    res.json({
      retCode: 0,
      retMsg: "OK",
      result: { category, list: Object.values(bybitTickers) },
    });
    return;
  }

  if (!bybitTickers[symbol]) {
    res.json({ retCode: 10001, retMsg: "Invalid symbol" });
    return;
  }
  const bybitScenario = activeScenario?.exchanges.bybit;
  if (bybitScenario?.symbol === symbol) {
    const entry = getCurrentEntry("bybit", bybitScenario.timeline);
    if (entry) {
      res.json({
        retCode: 0,
        retMsg: "OK",
        result: {
          category,
          list: [{
            symbol,
            bid1Price: entry.bid,
            bid1Size: entry.bid_qty ?? "1.000",
            ask1Price: entry.ask,
            ask1Size: entry.ask_qty ?? "1.000",
          }],
        },
      });
      return;
    }
  }
  res.json({
    retCode: 0,
    retMsg: "OK",
    result: { category, list: [bybitTickers[symbol]] },
  });
});

bybitRouter.get("/v5/market/orderbook", (req: Request, res: Response) => {
  const symbol = req.query.symbol as string | undefined;
  if (!symbol || !bybitOrderbooks[symbol]) {
    res.json({ retCode: 10001, retMsg: "Invalid symbol" });
    return;
  }
  const bybitScenario = activeScenario?.exchanges.bybit;
  if (bybitScenario?.symbol === symbol) {
    const entry = getCurrentEntry("bybit", bybitScenario.timeline);
    if (entry) {
      const { bids, asks } = buildDepthFromEntry(entry);
      res.json({
        retCode: 0,
        retMsg: "OK",
        result: { s: symbol, b: bids, a: asks },
      });
      return;
    }
  }
  res.json({
    retCode: 0,
    retMsg: "OK",
    result: bybitOrderbooks[symbol],
  });
});

// --- Kraken ---

type KrakenTickerEntry = {
  b: [string, string, string];
  a: [string, string, string];
};

type KrakenDepthEntry = {
  bids: [string, string, number][];
  asks: [string, string, number][];
};

const krakenPairToKey: Record<string, string> = {
  XBTUSD: "XXBTZUSD",
  ETHUSD: "XETHZUSD",
};

const krakenTickers: Record<string, KrakenTickerEntry> = {
  XXBTZUSD: { b: ["43250.00", "1", "1.000"], a: ["43251.00", "1", "1.000"] },
  XETHZUSD: { b: ["2650.00", "1", "1.000"], a: ["2651.00", "1", "1.000"] },
};

const krakenDepths: Record<string, KrakenDepthEntry> = {
  XXBTZUSD: {
    bids: [["43250.00", "1.500", 1234567890], ["43249.00", "2.300", 1234567890]],
    asks: [["43251.00", "1.200", 1234567890], ["43252.00", "0.800", 1234567890]],
  },
  XETHZUSD: {
    bids: [["2650.00", "5.200", 1234567890], ["2649.50", "8.750", 1234567890]],
    asks: [["2651.00", "4.100", 1234567890], ["2651.50", "3.600", 1234567890]],
  },
};

const krakenRouter = express.Router();

krakenRouter.get("/0/public/SystemStatus", (_req: Request, res: Response) => {
  res.json({
    error: [],
    result: { status: "online", timestamp: new Date().toISOString() },
  });
});

krakenRouter.get("/0/public/Ticker", (req: Request, res: Response) => {
  const pair = req.query.pair as string | undefined;
  const key = pair ? krakenPairToKey[pair] : undefined;
  if (!pair || !key) {
    res.json({ error: ["EQuery:Unknown asset pair"] });
    return;
  }
  const krakenScenario = activeScenario?.exchanges.kraken;
  if (krakenScenario?.symbol === pair) {
    const entry = getCurrentEntry("kraken", krakenScenario.timeline);
    if (entry) {
      const resultKey = krakenScenario.result_key ?? key;
      const bidQty = entry.bid_qty ?? "1.000";
      const askQty = entry.ask_qty ?? "1.000";
      res.json({
        error: [],
        result: {
          [resultKey]: {
            b: [entry.bid, "1", bidQty],
            a: [entry.ask, "1", askQty],
          },
        },
      });
      return;
    }
  }
  res.json({ error: [], result: { [key]: krakenTickers[key] } });
});

krakenRouter.get("/0/public/Depth", (req: Request, res: Response) => {
  const pair = req.query.pair as string | undefined;
  const key = pair ? krakenPairToKey[pair] : undefined;
  if (!pair || !key) {
    res.json({ error: ["EQuery:Unknown asset pair"] });
    return;
  }
  const krakenScenario = activeScenario?.exchanges.kraken;
  if (krakenScenario?.symbol === pair) {
    const entry = getCurrentEntry("kraken", krakenScenario.timeline);
    if (entry) {
      const resultKey = krakenScenario.result_key ?? key;
      const { bids, asks } = buildDepthFromEntry(entry);
      const now = Math.floor(Date.now() / 1000);
      res.json({
        error: [],
        result: {
          [resultKey]: {
            bids: bids.map(([p, v]) => [p, v, now] as [string, string, number]),
            asks: asks.map(([p, v]) => [p, v, now] as [string, string, number]),
          },
        },
      });
      return;
    }
  }
  res.json({ error: [], result: { [key]: krakenDepths[key] } });
});

// --- Scenario endpoints ---

function resolveScenarioPath(name: string): string | null {
  const serverDir = path.dirname(require.main!.filename);
  const scenarioPath = path.join(serverDir, "..", "scenarios", `${name}.yaml`);
  return fs.existsSync(scenarioPath) ? scenarioPath : null;
}

const scenarioRouter = express.Router();

scenarioRouter.get("/status", (_req: Request, res: Response) => {
  if (!activeScenario) {
    res.json({ name: "default", active: false, steps: {}, advance_mode: false });
    return;
  }
  res.json({
    name: activeScenario.name,
    active: true,
    steps: { ...stepCounters },
    advance_mode: advanceMode,
  });
});

scenarioRouter.post("/load/:name", (req: Request, res: Response) => {
  const name = req.params.name;
  const scenarioPath = resolveScenarioPath(name);

  if (!scenarioPath) {
    res.status(404).json({ error: `Scenario not found: ${name}` });
    return;
  }

  const raw = fs.readFileSync(scenarioPath, "utf-8");
  activeScenario = yaml.load(raw) as Scenario;

  stepCounters = {};
  for (const exName of Object.keys(activeScenario.exchanges)) {
    stepCounters[exName] = 0;
  }
  advanceMode = true;

  const prices: Record<string, { bid: string; ask: string }> = {};
  for (const [exName, ex] of Object.entries(activeScenario.exchanges)) {
    if (ex && ex.timeline.length > 0) {
      prices[exName] = { bid: ex.timeline[0].bid, ask: ex.timeline[0].ask };
    }
  }

  res.json({ loaded: name, steps: { ...stepCounters }, prices });
});

scenarioRouter.post("/advance", (_req: Request, res: Response) => {
  if (!activeScenario) {
    res.status(400).json({ error: "No scenario loaded" });
    return;
  }

  advanceMode = true;

  const advanced: string[] = [];
  for (const [exName, ex] of Object.entries(activeScenario.exchanges)) {
    if (ex) {
      const maxStep = ex.timeline.length - 1;
      stepCounters[exName] = Math.min((stepCounters[exName] ?? 0) + 1, maxStep);
      advanced.push(exName);
    }
  }

  const prices: Record<string, { bid: string; ask: string }> = {};
  for (const [exName, ex] of Object.entries(activeScenario.exchanges)) {
    if (ex) {
      const step = stepCounters[exName] ?? 0;
      prices[exName] = { bid: ex.timeline[step].bid, ask: ex.timeline[step].ask };
    }
  }

  res.json({ advanced, steps: { ...stepCounters }, prices });
});

// --- Mount and start ---

app.use("/binance", binanceRouter);
app.use("/bybit", bybitRouter);
app.use("/kraken", krakenRouter);
app.use("/scenario", scenarioRouter);

app.listen(PORT, () => {
  console.log(`Mock exchanges listening on http://localhost:${PORT}`);
  console.log(`  Binance: http://localhost:${PORT}/binance/api/v3/ping`);
  console.log(`  Bybit:   http://localhost:${PORT}/bybit/v5/market/time`);
  console.log(`  Kraken:  http://localhost:${PORT}/kraken/0/public/SystemStatus`);
});
