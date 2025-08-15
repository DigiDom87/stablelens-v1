// StableLens v1 - Free API Edition (ESM)
// Node >= 18

import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import RSSParser from "rss-parser";

// __dirname shim for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// -------- helpers: cache + retry --------
const cache = new Map();
const now = () => Date.now();

async function withCache(key, ttlMs, fetcher) {
  const entry = cache.get(key);
  if (entry && now() - entry.t < ttlMs) return entry.v;
  try {
    const v = await fetcher();
    cache.set(key, { v, t: now() });
    return v;
  } catch (e) {
    if (entry) return entry.v; // stale-on-error
    throw e;
  }
}

async function fetchWithRetry(url, opts = {}, attempts = 3, backoffMs = 300) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, {
        ...opts,
        headers: {
          "accept": "application/json, text/xml;q=0.9",
          "user-agent": "StableLens/1.0 (free-api)",
          ...(opts.headers || {})
        },
        signal: AbortSignal.timeout?.(12000)
      });
      if (!r.ok) throw new Error(`${url} -> ${r.status}`);
      return r;
    } catch (e) {
      lastErr = e;
      await new Promise(res => setTimeout(res, backoffMs * (i + 1)));
    }
  }
  throw lastErr;
}

// -------- API routes --------
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", ts: Date.now() });
});

app.get("/api/prices", async (_req, res) => {
  const CG = { USDT: "tether", USDC: "usd-coin", DAI: "dai", sDAI: "savings-dai" };

  async function llamaCG() {
    const ids = Object.values(CG).map(id => `coingecko:${id}`).join(",");
    const url = `https://coins.llama.fi/prices/current/${ids}`;
    const r = await fetchWithRetry(url);
    const out = await r.json();
    const coins = out?.coins || {};
    const data = {};
    for (const [sym, id] of Object.entries(CG)) {
      const key = `coingecko:${id}`;
      const v = coins[key] || coins[key.toLowerCase()] || null;
      data[sym] = {
        price: (v && typeof v.price === "number") ? v.price : null,
        confidence: (v && typeof v.confidence === "number") ? v.confidence : null
      };
    }
    return data;
  }

  async function coingeckoFallback() {
    const ids = Object.values(CG).join(",");
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;
    const r = await fetchWithRetry(url);
    const out = await r.json();
    const data = {};
    for (const [sym, id] of Object.entries(CG)) {
      const px = out?.[id]?.usd;
      data[sym] = { price: typeof px === "number" ? px : null, confidence: null };
    }
    return data;
  }

  try {
    const data = await withCache("prices", 60_000, async () => {
      const primary = await llamaCG();
      const allNull = Object.values(primary).every(v => v.price == null);
      return allNull ? await coingeckoFallback() : primary;
    });
    res.json({ updatedAt: Date.now(), data });
  } catch {
    try {
      const data = await coingeckoFallback();
      res.json({ updatedAt: Date.now(), data });
    } catch {
      res.status(502).json({ error: "Price sources unavailable" });
    }
  }
});

app.get("/api/stablecoins/chain", async (req, res) => {
  const chain = (req.query.chain || "Ethereum").toString();
  try {
    const series = await withCache(`stables:${chain}`, 30 * 60_000, async () => {
      const url = `https://stablecoins.llama.fi/stablecoincharts/${encodeURIComponent(chain)}?stablecoin=1`;
      const r = await fetchWithRetry(url);
      const arr = await r.json();
      return arr.map(row => ({
        t: row.date * 1000 || null,
        circulatingUSD: row?.totalCirculatingUSD?.peggedUSD ?? null,
        bridgedUSD: row?.totalBridgedToUSD?.peggedUSD ?? null
      })).filter(p => p.t && p.circulatingUSD != null);
    });
    res.json({ chain, updatedAt: Date.now(), series });
  } catch {
    res.status(502).json({ error: `Stablecoin series unavailable for ${chain}` });
  }
});

app.get("/api/yields/sdai", async (_req, res) => {
  try {
    const data = await withCache("yields:sdai", 10 * 60_000, async () => {
      const r = await fetchWithRetry("https://yields.llama.fi/pools");
      const out = await r.json();
      const pools = Array.isArray(out?.data) ? out.data : [];
      return pools
        .filter(p => (p?.symbol || "").toUpperCase().includes("SDAI"))
        .sort((a, b) => (b.tvlUsd || 0) - (a.tvlUsd || 0))
        .slice(0, 6)
        .map(p => ({
          project: p.project,
          chain: p.chain,
          symbol: p.symbol,
          apy: p.apy ?? p.apyBase ?? null,
          apyBase: p.apyBase ?? null,
          apyReward: p.apyReward ?? null,
          tvlUsd: p.tvlUsd ?? null,
          url: p.url || null
        }));
    });
    res.json({ updatedAt: Date.now(), pools: data });
  } catch {
    res.status(502).json({ error: "Yield data unavailable" });
  }
});

const rss = new RSSParser();
app.get("/api/news", async (_req, res) => {
  try {
    const news = await withCache("news", 30 * 60_000, async () => {
      const feeds = [
        "https://www.federalreserve.gov/feeds/press_all.xml",
        "https://data.bis.org/feed.xml"
      ];
      const items = [];
      for (const f of feeds) {
        try {
          const xmlText = await (await fetchWithRetry(f)).text();
          const parsed = await rss.parseString(xmlText);
          for (const it of parsed.items || []) {
            items.push({
              source: parsed.title || new URL(f).hostname,
              title: it.title,
              link: it.link,
              published: it.isoDate || it.pubDate || null
            });
          }
        } catch {}
      }
      return items
        .filter(i => i.title && i.link)
        .sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0))
        .slice(0, 20);
    });
    res.json({ updatedAt: Date.now(), items: news });
  } catch {
    res.status(502).json({ error: "News unavailable" });
  }
});

// -------- static frontend + catch-all --------
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`StableLens v1 listening on :${PORT}`);
});

