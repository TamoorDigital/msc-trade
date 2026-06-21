// server.js — SMC Signal Analyzer backend
// Crypto → Binance API | Forex/Gold/Indices → Yahoo Finance (auto-detect, no key needed)

require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

const GEMINI_KEY      = process.env.GEMINI_API_KEY;
const GEMINI_MODEL    = 'gemini-1.5-pro';   // Free: 1500 req/day, great vision+analysis
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

app.use(cors());
app.use(express.json({ limit: '15mb' }));

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an elite institutional trader with 15+ years of experience trading crypto, forex, and indices using Smart Money Concepts (SMC) and ICT methodology.
You think like a hedge fund trader, not a retail trader.
Your job is to analyze the provided trading data (chart image + multi-timeframe candle data) and return ONLY high-probability trade setups.
INPUT DATA YOU RECEIVE:

1. Chart Image (15-minute timeframe screenshot from TradingView)
2. Candle Data:
   * 4H timeframe candles
   * 1H timeframe candles
3. Symbol (e.g., BTCUSDT)
4. Current Price
5. Session (Asia / London / New York if available)
YOUR ANALYSIS PROCESS (STRICTLY FOLLOW):
STEP 1: MARKET STRUCTURE

* Identify trend on 4H and 1H (Bullish / Bearish / Ranging)
* Detect Break of Structure (BOS)
* Detect Change of Character (CHOCH)
STEP 2: LIQUIDITY ANALYSIS

* Identify buy-side liquidity (equal highs, stop clusters)
* Identify sell-side liquidity (equal lows, stop clusters)
* Detect liquidity sweeps (fake breakouts)
STEP 3: ORDER FLOW & SMART MONEY

* Identify Order Blocks (OB)
* Identify Breaker Blocks
* Identify mitigation zones
STEP 4: IMBALANCES

* Detect Fair Value Gaps (FVG)
* Identify inefficiencies likely to be filled
STEP 5: PREMIUM / DISCOUNT

* Determine if price is in premium or discount zone relative to range
STEP 6: SESSION CONTEXT

* Consider session behavior (London killzone, NY volatility)
* Avoid low-volume/no-liquidity times
STEP 7: CONFLUENCE CHECK

* Only proceed if at least 3 strong confluences align: (Structure + Liquidity + OB/FVG + Session + Trend)
DECISION LOGIC:
You must choose ONLY ONE:

1. LONG
2. SHORT
3. WAIT (no trade)
TRADE RULES:

* Minimum Risk:Reward = 1:2
* Ideal Risk:Reward >= 1:3
* If setup quality < 80% -> return WAIT
* Do NOT force trades
* Avoid trades in choppy or ranging markets unless breakout confirmed
OUTPUT FORMAT:
If LONG or SHORT:
Return in this EXACT format:
TRADE: LONG / SHORT
ENTRY: [price]
STOP LOSS: [price]
TAKE PROFIT 1: [price]
TAKE PROFIT 2: [price]
TAKE PROFIT 3: [price]
RISK REWARD: [e.g., 1:3]
PROBABILITY: [0-100%]

REASONING:

* Market Structure:
* Liquidity:
* Entry Model (OB/FVG/etc):
* Session Context:
* Confluence Summary:

If WAIT:
TRADE: WAIT

REASON:

* Why no valid setup exists

WHAT TO WATCH:

* Key levels
* Conditions required for trade

IMPORTANT RULES:

* Think step-by-step before answering
* Prioritize accuracy over frequency
* Do not hallucinate levels
* Use both image and candle data together
* If image conflicts with data -> trust candle data more
* Only give ONE final decision
* Be precise, not verbose

GOAL:
Act like a professional trader managing real capital. Your priority is capital preservation and high-probability execution.`;

// ── Symbol classifier ─────────────────────────────────────────────────────────
// Returns 'binance' | 'yahoo'
// Normalize TradingView symbol → clean Binance/Yahoo-compatible symbol
// Handles: BINANCE:BTCUSDT.P  BYBIT:BTCUSDTPERP  OANDA:GBPUSD  COMEX:XAUUSD
function normalizeSymbol(raw) {
  let s = raw || '';

  // 1. Strip exchange prefix:  "BINANCE:BTCUSDT.P" → "BTCUSDT.P"
  s = s.replace(/^[A-Z0-9]+:/i, '');

  // 2. Strip perpetual / futures suffixes BEFORE removing dots
  //    These show up on Binance Futures, Bybit, OKX charts
  s = s.replace(/\.P$/i, '');          // BTCUSDT.P  → BTCUSDT
  s = s.replace(/\.PERP$/i, '');       // BTCUSDT.PERP → BTCUSDT
  s = s.replace(/_PERP$/i, '');        // BTCUSDT_PERP → BTCUSDT
  s = s.replace(/PERP$/i, '');         // BTCUSDTPERP → BTCUSDT
  s = s.replace(/\.USD$/i, 'USDT');    // Some exchanges use .USD instead of USDT

  // 3. Remove any remaining non-alphanumeric characters
  s = s.replace(/[^A-Z0-9]/gi, '').toUpperCase();

  return s;
}

function detectDataSource(symbol) {
  // Crypto quote currencies used on Binance
  const cryptoSuffixes = ['USDT', 'USDC', 'BTC', 'ETH', 'BNB', 'BUSD', 'TRY', 'FDUSD'];
  const isCrypto = cryptoSuffixes.some(s => symbol.toUpperCase().endsWith(s));
  if (isCrypto) return 'binance';

  // Known crypto base assets that might not have a standard suffix after normalization
  const cryptoBases = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'MATIC', 'DOT', 'AVAX', 'LINK'];
  const likelyCrypto = cryptoBases.some(b => symbol.toUpperCase().startsWith(b));
  if (likelyCrypto) return 'binance';

  // Everything else (Forex, Gold, Silver, Indices) → Yahoo Finance
  return 'yahoo';
}

// ── Binance helpers ───────────────────────────────────────────────────────────
async function fetchBinanceCandles(symbol, interval, limit = 20) {
  const res = await axios.get('https://api.binance.com/api/v3/klines', {
    params: { symbol, interval, limit },
    timeout: 8000,
  });
  return res.data.map(c => ({
    time:   new Date(c[0]).toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
    open:   parseFloat(c[1]),
    high:   parseFloat(c[2]),
    low:    parseFloat(c[3]),
    close:  parseFloat(c[4]),
    volume: parseFloat(c[5]),
  }));
}

async function fetchBinancePrice(symbol) {
  const res = await axios.get('https://api.binance.com/api/v3/ticker/price', {
    params: { symbol },
    timeout: 5000,
  });
  return parseFloat(res.data.price);
}

// ── Symbol helpers ────────────────────────────────────────────────────────────
function parseCryptoSymbol(symbol) {
  // "BTCUSDT" → { fsym:"BTC", tsym:"USDT" }
  const quotes = ['USDT','USDC','BUSD','FDUSD','BTC','ETH','BNB'];
  for (const q of quotes) {
    if (symbol.toUpperCase().endsWith(q))
      return { fsym: symbol.slice(0, -q.length).toUpperCase(), tsym: q };
  }
  return { fsym: symbol.slice(0,-4).toUpperCase(), tsym: symbol.slice(-4).toUpperCase() };
}

function toHyphenSymbol(symbol) {
  // "BTCUSDT" → "BTC-USDT"  (used by Gate.io, KuCoin, OKX)
  const { fsym, tsym } = parseCryptoSymbol(symbol);
  return `${fsym}-${tsym}`;
}

function toUnderscoreSymbol(symbol) {
  // "BTCUSDT" → "BTC_USDT"  (used by Gate.io)
  const { fsym, tsym } = parseCryptoSymbol(symbol);
  return `${fsym}_${tsym}`;
}

// ── Exchange 2: MEXC (same Binance API format, different IPs) ─────────────────
async function fetchMEXCCandles(symbol, interval, limit = 20) {
  const res = await axios.get('https://api.mexc.com/api/v3/klines', {
    params: { symbol, interval, limit },
    timeout: 8000,
  });
  if (!Array.isArray(res.data) || res.data.length === 0)
    throw new Error(`MEXC no data for ${symbol}`);
  return res.data.map(c => ({
    time:   new Date(c[0]).toISOString().replace('T',' ').slice(0,16) + ' UTC',
    open:   parseFloat(c[1]),
    high:   parseFloat(c[2]),
    low:    parseFloat(c[3]),
    close:  parseFloat(c[4]),
    volume: parseFloat(c[5]),
  }));
}

async function fetchMEXCPrice(symbol) {
  const res = await axios.get('https://api.mexc.com/api/v3/ticker/price', {
    params: { symbol }, timeout: 5000,
  });
  return parseFloat(res.data.price);
}

// ── Exchange 3: Gate.io ───────────────────────────────────────────────────────
async function fetchGateCandles(symbol, interval, limit = 20) {
  const barMap = { '1h':'1h', '4h':'4h', '15m':'15m', '1d':'1d' };
  const res = await axios.get('https://api.gateio.ws/api/v4/spot/candlesticks', {
    params: { currency_pair: toUnderscoreSymbol(symbol), interval: barMap[interval]||'1h', limit },
    timeout: 8000,
  });
  if (!Array.isArray(res.data) || res.data.length === 0)
    throw new Error(`Gate.io no data for ${symbol}`);
  // Gate.io format: [time_sec, quote_vol, close, high, low, open]
  return res.data.map(c => ({
    time:   new Date(parseInt(c[0]) * 1000).toISOString().replace('T',' ').slice(0,16) + ' UTC',
    open:   parseFloat(c[5]),
    high:   parseFloat(c[3]),
    low:    parseFloat(c[4]),
    close:  parseFloat(c[2]),
    volume: parseFloat(c[1]),
  }));
}

async function fetchGatePrice(symbol) {
  const res = await axios.get('https://api.gateio.ws/api/v4/spot/tickers', {
    params: { currency_pair: toUnderscoreSymbol(symbol) }, timeout: 5000,
  });
  return parseFloat(res.data?.[0]?.last ?? 0);
}

// ── Exchange 4: KuCoin ────────────────────────────────────────────────────────
async function fetchKuCoinCandles(symbol, interval, limit = 20) {
  const typeMap = { '1h':'1hour', '4h':'4hour', '15m':'15min', '1d':'1day' };
  // KuCoin needs startAt/endAt for limit — use endAt=now, startAt=now-limit*interval
  const intervalSeconds = { '1h':3600, '4h':14400, '15m':900, '1d':86400 };
  const endAt   = Math.floor(Date.now() / 1000);
  const startAt = endAt - (limit + 5) * (intervalSeconds[interval] || 3600);

  const res = await axios.get('https://api.kucoin.com/api/v1/market/candles', {
    params: { symbol: toHyphenSymbol(symbol), type: typeMap[interval]||'1hour', startAt, endAt },
    timeout: 8000,
  });
  const data = res.data?.data;
  if (!data || data.length === 0) throw new Error(`KuCoin no data for ${symbol}`);
  // KuCoin format: [time_sec, open, close, high, low, volume, amount] — newest first
  return data.reverse().slice(-limit).map(c => ({
    time:   new Date(parseInt(c[0]) * 1000).toISOString().replace('T',' ').slice(0,16) + ' UTC',
    open:   parseFloat(c[1]),
    high:   parseFloat(c[3]),
    low:    parseFloat(c[4]),
    close:  parseFloat(c[2]),
    volume: parseFloat(c[5]),
  }));
}

async function fetchKuCoinPrice(symbol) {
  const res = await axios.get(`https://api.kucoin.com/api/v1/market/orderbook/level1`, {
    params: { symbol: toHyphenSymbol(symbol) }, timeout: 5000,
  });
  return parseFloat(res.data?.data?.price ?? 0);
}

// ── Exchange 5: CryptoCompare (data aggregator, no exchange IP blocks) ────────
async function fetchCCCandles(symbol, interval, limit = 20) {
  const { fsym, tsym } = parseCryptoSymbol(symbol);
  const hoursNeeded = interval === '4h' ? limit * 4 : limit;
  const res = await axios.get('https://min-api.cryptocompare.com/data/v2/histohour', {
    params: { fsym, tsym, limit: hoursNeeded },
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 10000,
  });
  if (res.data.Response === 'Error') throw new Error(res.data.Message);
  const raw = res.data?.Data?.Data || [];
  if (raw.length === 0) throw new Error(`CryptoCompare no data for ${fsym}`);
  const candles = raw.map(c => ({
    time:   new Date(c.time * 1000).toISOString().replace('T',' ').slice(0,16) + ' UTC',
    open:   c.open, high: c.high, low: c.low, close: c.close, volume: c.volumefrom,
  }));
  if (interval === '4h') return aggregateTo4H(candles).slice(-limit);
  return candles.slice(-limit);
}

async function fetchCCPrice(symbol) {
  const { fsym, tsym } = parseCryptoSymbol(symbol);
  const res = await axios.get('https://min-api.cryptocompare.com/data/price', {
    params: { fsym, tsyms: tsym }, headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000,
  });
  return res.data[tsym] ?? null;
}

// ── Master crypto fetch: tries 5 exchanges in order ──────────────────────────
// One of these WILL work regardless of cloud provider IP restrictions.
const CRYPTO_SOURCES = [
  { name: 'Binance',       candles: fetchBinanceCandles, price: fetchBinancePrice },
  { name: 'MEXC',          candles: fetchMEXCCandles,    price: fetchMEXCPrice    },
  { name: 'Gate.io',       candles: fetchGateCandles,    price: fetchGatePrice    },
  { name: 'KuCoin',        candles: fetchKuCoinCandles,  price: fetchKuCoinPrice  },
  { name: 'CryptoCompare', candles: fetchCCCandles,      price: fetchCCPrice      },
];

async function fetchCryptoCandles(symbol, interval, limit = 20) {
  const errors = [];
  for (const src of CRYPTO_SOURCES) {
    try {
      const data = await src.candles(symbol, interval, limit);
      if (data && data.length > 0) {
        if (src.name !== 'Binance') console.log(`[Data] Using ${src.name} for ${symbol}`);
        return data;
      }
    } catch (e) {
      console.log(`[${src.name}] ${e.response?.status || ''} ${e.message}`);
      errors.push(`${src.name}: ${e.message}`);
    }
  }
  throw new Error(`All sources failed for ${symbol}:\n${errors.join('\n')}`);
}

async function fetchCryptoPrice(symbol) {
  for (const src of CRYPTO_SOURCES) {
    try {
      const p = await src.price(symbol);
      if (p && p > 0) return p;
    } catch (_) {}
  }
  return null;
}


// ── Yahoo Finance helpers (Forex / Gold / Indices) ────────────────────────────
//
// Symbol mapping for Yahoo Finance:
//   GBPUSD  → GBPUSD=X
//   EURUSD  → EURUSD=X
//   XAUUSD  → GC=F   (Gold Futures)
//   XAGUSD  → SI=F   (Silver Futures)
//   US30    → ^DJI
//   NAS100  → ^IXIC
//   SPX500  → ^GSPC
//   GER40   → ^GDAXI
//   UK100   → ^FTSE
//
function toYahooSymbol(symbol) {
  const s = symbol.toUpperCase();
  const map = {
    'XAUUSD': 'GC=F',
    'XAGUSD': 'SI=F',
    'XTIUSD': 'CL=F',   // WTI Crude
    'XBRUSD': 'BZ=F',   // Brent Crude
    'US30':   '^DJI',
    'DJIA':   '^DJI',
    'NAS100': '^IXIC',
    'NASDAQ': '^IXIC',
    'NDX':    '^IXIC',
    'SPX500': '^GSPC',
    'SP500':  '^GSPC',
    'SPX':    '^GSPC',
    'GER40':  '^GDAXI',
    'DAX':    '^GDAXI',
    'UK100':  '^FTSE',
    'FTSE':   '^FTSE',
    'JPN225': '^N225',
    'NI225':  '^N225',
  };
  if (map[s]) return map[s];
  // Forex pairs: 6-char like GBPUSD, EURUSD → append =X
  if (/^[A-Z]{6}$/.test(s)) return s + '=X';
  return s + '=X';
}

// Fetch 1H candles from Yahoo (returns raw 1H array)
async function fetchYahoo1H(symbol, totalHours = 80) {
  const yahooSym = toYahooSymbol(symbol);
  // range needs to cover totalHours; use 14d to be safe (forex = 24/5)
  const range = '14d';
  const res = await axios.get(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}`,
    {
      params: { interval: '1h', range },
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SMCAnalyzer/1.0)' },
      timeout: 10000,
    }
  );

  const result = res.data?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo Finance returned no data for ${symbol}`);

  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};

  return timestamps
    .map((ts, i) => ({
      time:   new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
      open:   quote.open?.[i]   ?? null,
      high:   quote.high?.[i]   ?? null,
      low:    quote.low?.[i]    ?? null,
      close:  quote.close?.[i]  ?? null,
      volume: quote.volume?.[i] ?? 0,
    }))
    .filter(c => c.open !== null && c.close !== null);
}

// Aggregate 1H candles into 4H candles
function aggregateTo4H(candles1H) {
  const groups = [];
  for (let i = 0; i < candles1H.length; i += 4) {
    const g = candles1H.slice(i, i + 4);
    if (g.length < 2) continue; // skip incomplete edge groups
    groups.push({
      time:   g[0].time,
      open:   g[0].open,
      high:   Math.max(...g.map(c => c.high)),
      low:    Math.min(...g.map(c => c.low)),
      close:  g[g.length - 1].close,
      volume: g.reduce((s, c) => s + (c.volume || 0), 0),
    });
  }
  return groups;
}

async function fetchYahooCandles(symbol, interval, limit = 20) {
  // Always fetch 1H base, then aggregate if needed
  const raw1H = await fetchYahoo1H(symbol, 80);

  if (interval === '1h') {
    return raw1H.slice(-limit);
  }

  if (interval === '4h') {
    const candles4H = aggregateTo4H(raw1H);
    return candles4H.slice(-limit);
  }

  return raw1H.slice(-limit);
}

async function fetchYahooPrice(symbol) {
  // Use last close from 1H candles as current price
  const candles = await fetchYahoo1H(symbol, 2);
  return candles[candles.length - 1]?.close ?? null;
}

// ── Shared helpers ────────────────────────────────────────────────────────────
function formatCandleTable(candles, timeframe) {
  const header = `\n${timeframe} CANDLES (last ${candles.length}):`;
  const cols   = 'Time                 | Open           | High           | Low            | Close          | Volume';
  const sep    = '-'.repeat(95);
  const rows   = candles.map(c =>
    `${c.time.padEnd(20)} | ${pad(c.open,14)} | ${pad(c.high,14)} | ${pad(c.low,14)} | ${pad(c.close,14)} | ${(c.volume||0).toFixed(2)}`
  ).join('\n');
  return `${header}\n${cols}\n${sep}\n${rows}`;
}

function pad(n, width = 12) {
  return String(n ?? '—').padEnd(width);
}

function getSession() {
  const h = new Date().getUTCHours();
  if (h >= 0  && h < 7)  return 'Asia';
  if (h >= 7  && h < 12) return 'London';
  if (h >= 12 && h < 21) return 'New York';
  return 'Off-Session';
}

// ── Signal parser ─────────────────────────────────────────────────────────────
function parseSignal(text) {
  const result = { rawText: text };

  const tradeMatch = text.match(/TRADE:\s*(LONG|SHORT|WAIT)/i);
  result.trade = tradeMatch ? tradeMatch[1].toUpperCase() : 'WAIT';

  const extractPrice = pattern => {
    const m = text.match(pattern);
    if (!m) return null;
    return parseFloat(m[1].replace(/[$,\s]/g, ''));
  };

  if (result.trade !== 'WAIT') {
    result.entry    = extractPrice(/ENTRY:\s*\$?([\d,]+(?:\.\d+)?)/i);
    result.stopLoss = extractPrice(/STOP\s*LOSS:\s*\$?([\d,]+(?:\.\d+)?)/i);
    result.tp1      = extractPrice(/TAKE\s*PROFIT\s*1:\s*\$?([\d,]+(?:\.\d+)?)/i);
    result.tp2      = extractPrice(/TAKE\s*PROFIT\s*2:\s*\$?([\d,]+(?:\.\d+)?)/i);
    result.tp3      = extractPrice(/TAKE\s*PROFIT\s*3:\s*\$?([\d,]+(?:\.\d+)?)/i);

    const rrM = text.match(/RISK\s*REWARD:\s*([\d.:]+)/i);
    result.riskReward = rrM ? rrM[1].trim() : null;

    const probM = text.match(/PROBABILITY:\s*([\d.]+)\s*%?/i);
    result.probability = probM ? parseFloat(probM[1]) : null;

    const rIdx = text.search(/REASONING:/i);
    if (rIdx !== -1) result.reasoning = text.slice(rIdx + 10).trim();
  } else {
    const reasonM = text.match(/REASON:([\s\S]+?)(?:WHAT\s*TO\s*WATCH:|$)/i);
    if (reasonM) result.reason = reasonM[1].trim();

    const watchM = text.match(/WHAT\s*TO\s*WATCH:([\s\S]+?)$/i);
    if (watchM) result.watchFor = watchM[1].trim();
  }

  return result;
}

// ── Main route ────────────────────────────────────────────────────────────────
app.post('/analyze', async (req, res) => {
  const { symbol, screenshot, mediaType } = req.body;

  if (!symbol)     return res.status(400).json({ error: 'Missing symbol' });
  if (!screenshot) return res.status(400).json({ error: 'Missing screenshot' });
  if (!GEMINI_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not set in environment variables.' });
  }

  // Normalize: strip exchange prefix + perpetual suffixes (.P, PERP, etc.)
  // e.g. "BINANCE:BTCUSDT.P" → "BTCUSDT"  |  "OANDA:GBPUSD" → "GBPUSD"
  const cleanSymbol = normalizeSymbol(symbol);
  const dataSource  = detectDataSource(cleanSymbol);

  console.log(`[Analyze] ${cleanSymbol} → source: ${dataSource}`);

  // ── Fetch candle data ──
  let candles4H, candles1H, currentPrice;

  try {
    if (dataSource === 'binance') {
      // fetchCryptoCandles auto-falls back: Binance → Bybit
      [candles4H, candles1H, currentPrice] = await Promise.all([
        fetchCryptoCandles(cleanSymbol, '4h', 20),
        fetchCryptoCandles(cleanSymbol, '1h', 20),
        fetchCryptoPrice(cleanSymbol),
      ]);
    } else {
      // Forex / Gold / Indices → Yahoo Finance
      [candles4H, candles1H] = await Promise.all([
        fetchYahooCandles(cleanSymbol, '4h', 20),
        fetchYahooCandles(cleanSymbol, '1h', 20),
      ]);
      currentPrice = candles1H[candles1H.length - 1]?.close ?? null;
    }
  } catch (err) {
    const detail = err.response?.data?.msg || err.message;
    console.error('[Data Fetch Error]', detail);

    if (dataSource === 'binance') {
      return res.status(400).json({
        error: `Could not fetch candles for "${cleanSymbol}" from Binance or Bybit.\n` +
               `Make sure the symbol is a valid spot pair (e.g. BTCUSDT, ETHUSDT, SOLUSDT).`,
      });
    } else {
      return res.status(400).json({
        error: `Could not fetch candles for "${cleanSymbol}" from Yahoo Finance.\n` +
               `Supported forex: GBPUSD, EURUSD, USDJPY, XAUUSD. Indices: NAS100, US30, SPX500.`,
      });
    }
  }

  const session   = getSession();
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  // ── Build user message ──
  const userText = `
Symbol: ${cleanSymbol}
Asset Type: ${dataSource === 'binance' ? 'Crypto (Binance/Bybit)' : 'Forex / Commodity / Index (Yahoo Finance)'}
Current Price: ${currentPrice != null ? currentPrice : 'See chart'}
Timestamp: ${timestamp}
Session: ${session}
${formatCandleTable(candles4H, '4H')}
${formatCandleTable(candles1H, '1H')}

The chart screenshot above shows the current TradingView chart (15-minute timeframe).
Please analyze all provided data — chart image + candles — and return your trade signal.
`.trim();

  // ── Call Gemini API ──
  if (!GEMINI_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not set in environment variables.' });
  }

  let apiRes;
  try {
    apiRes = await axios.post(
      `${GEMINI_BASE_URL}/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
      {
        // System prompt
        system_instruction: {
          parts: [{ text: SYSTEM_PROMPT }]
        },
        // User message: image first, then candle data text
        contents: [
          {
            role: 'user',
            parts: [
              {
                inline_data: {
                  mime_type: mediaType || 'image/jpeg',
                  data:      screenshot,
                }
              },
              { text: userText }
            ]
          }
        ],
        generationConfig: {
          maxOutputTokens: 2000,
          temperature:     0.1,
          topP:            0.95,
        },
        // Prevent safety filters blocking trading content
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
        ],
      },
      { timeout: 90000 }
    );
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.response?.data || err.message;
    console.error('[Gemini Error]', JSON.stringify(detail));
    return res.status(502).json({ error: `Gemini API error: ${JSON.stringify(detail)}` });
  }

  // Parse Gemini response
  const candidate  = apiRes.data?.candidates?.[0];
  const finishReason = candidate?.finishReason;
  const rawText    = candidate?.content?.parts?.map(p => p.text || '').join('') || '';

  console.log('[Gemini] finish:', finishReason, '| chars:', rawText.length, '| preview:', rawText.slice(0, 80));

  if (finishReason === 'SAFETY') {
    return res.status(502).json({ error: 'Gemini safety filter triggered. Try again.' });
  }

  if (!rawText) {
    console.error('[Gemini] Empty response:', JSON.stringify(apiRes.data).slice(0, 400));
    return res.status(502).json({
      error: 'Empty response from Gemini. Check API key and billing.',
      debug: JSON.stringify(apiRes.data).slice(0, 300),
    });
  }

  const signal = parseSignal(rawText);
  signal.symbol       = cleanSymbol;
  signal.currentPrice = currentPrice;
  signal.timestamp    = timestamp;
  signal.session      = session;
  signal.dataSource   = dataSource;

  return res.json(signal);
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: '3.0',
    model:   GEMINI_MODEL,
    apiKey:  GEMINI_KEY ? '✓ set' : '✗ missing',
  });
});

// ── Test AI — open in browser to verify Gemini is working ────────────────────
app.get('/test-ai', async (_req, res) => {
  if (!GEMINI_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not set in environment' });
  }
  try {
    const r = await axios.post(
      `${GEMINI_BASE_URL}/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
      {
        contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: WORKING' }] }],
        generationConfig: { maxOutputTokens: 20 },
      },
      { timeout: 20000 }
    );
    const text = r.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return res.json({
      test:         text ? 'PASSED ✅' : 'FAILED ❌',
      reply:        text,
      model:        GEMINI_MODEL,
      finish:       r.data?.candidates?.[0]?.finishReason,
    });
  } catch (err) {
    return res.status(502).json({
      test:  'FAILED ❌',
      error: err.response?.data?.error?.message || err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅  SMC Signal Backend running at http://localhost:${PORT}`);
  console.log(`    Model:   ${GEMINI_MODEL}`);
  console.log(`    Key:     ${GEMINI_KEY ? '✓ loaded' : '✗ NOT SET — add GEMINI_API_KEY to .env'}`);
  console.log(`    Sources: Binance/MEXC/Gate.io/KuCoin (crypto) + Yahoo (forex/indices)`);
  console.log(`    Health:  http://localhost:${PORT}/health\n`);
});

// ── Global error handlers ─────────────────────────────────────────────────────
// Always return JSON — prevents HTML error pages reaching the extension
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});
app.use((err, req, res, _next) => {
  console.error('[Unhandled Error]', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});