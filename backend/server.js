// server.js — SMC Signal Analyzer backend
// Crypto → Binance API | Forex/Gold/Indices → Yahoo Finance (auto-detect, no key needed)

require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

const AGENTROUTER_KEY      = process.env.AGENTROUTER_API_KEY;
const AGENTROUTER_BASE_URL = 'https://agentrouter.org';

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
  if (!AGENTROUTER_KEY) {
    return res.status(500).json({ error: 'AGENTROUTER_API_KEY not set in .env — see setup guide.' });
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
      [candles4H, candles1H, currentPrice] = await Promise.all([
        fetchBinanceCandles(cleanSymbol, '4h', 20),
        fetchBinanceCandles(cleanSymbol, '1h', 20),
        fetchBinancePrice(cleanSymbol),
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

    // If Binance failed, try Yahoo as last resort
    if (dataSource === 'binance') {
      try {
        console.log(`[Analyze] Binance failed, trying Yahoo for ${cleanSymbol}...`);
        [candles4H, candles1H] = await Promise.all([
          fetchYahooCandles(cleanSymbol, '4h', 20),
          fetchYahooCandles(cleanSymbol, '1h', 20),
        ]);
        currentPrice = candles1H[candles1H.length - 1]?.close ?? null;
      } catch (yahooErr) {
        return res.status(400).json({
          error: `Could not fetch data for "${cleanSymbol}" from Binance or Yahoo Finance. ` +
                 `Check the symbol is correct. Supported: BTCUSDT, GBPUSD, XAUUSD, EURUSD, NAS100, US30.`,
        });
      }
    } else {
      return res.status(400).json({
        error: `Yahoo Finance data fetch failed for "${cleanSymbol}": ${detail}. ` +
               `Check symbol is correct. Forex pairs like GBPUSD, EURUSD, XAUUSD, USDJPY are supported.`,
      });
    }
  }

  const session   = getSession();
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  // ── Build user message ──
  const userText = `
Symbol: ${cleanSymbol}
Asset Type: ${dataSource === 'binance' ? 'Crypto (Binance)' : 'Forex / Commodity / Index (Yahoo Finance)'}
Current Price: ${currentPrice != null ? currentPrice : 'See chart'}
Timestamp: ${timestamp}
Session: ${session}
${formatCandleTable(candles4H, '4H')}
${formatCandleTable(candles1H, '1H')}

The chart screenshot above shows the current TradingView chart (15-minute timeframe).
Please analyze all provided data — chart image + candles — and return your trade signal.
`.trim();

  // ── Call AgentRouter ──
  let apiRes;
  try {
    apiRes = await axios.post(
      `${AGENTROUTER_BASE_URL}/v1/messages`,
      {
        model:      'claude-opus-4-8',
        max_tokens: 1500,
        system:     SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type:       'base64',
                  media_type: mediaType || 'image/jpeg',
                  data:       screenshot,
                },
              },
              { type: 'text', text: userText },
            ],
          },
        ],
      },
      {
        headers: {
          'x-api-key':         AGENTROUTER_KEY,
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json',
        },
        timeout: 90000,
      }
    );
  } catch (err) {
    const apiErr = err.response?.data?.error?.message || err.response?.data || err.message;
    console.error('[AgentRouter Error]', apiErr);
    return res.status(502).json({ error: `AgentRouter API error: ${JSON.stringify(apiErr)}` });
  }

  const rawText = apiRes.data?.content?.[0]?.text || '';
  if (!rawText) return res.status(502).json({ error: 'Empty response from AI model.' });

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
    status:  'ok',
    model:   'claude-opus-4-8',
    router:  AGENTROUTER_BASE_URL,
    apiKey:  AGENTROUTER_KEY ? '✓ set' : '✗ missing',
    sources: ['binance (crypto)', 'yahoo finance (forex/gold/indices)'],
  });
});

app.listen(PORT, () => {
  console.log(`\n✅  SMC Signal Backend running at http://localhost:${PORT}`);
  console.log(`    Key:     ${AGENTROUTER_KEY ? '✓ loaded' : '✗ NOT SET — add to .env'}`);
  console.log(`    Sources: Binance (crypto) + Yahoo Finance (forex/gold/indices)`);
  console.log(`    Health:  http://localhost:${PORT}/health\n`);
});
