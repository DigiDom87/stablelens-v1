// StableLens v1 — Platforms (CeFi/DeFi) + Compliance Score + XRP/RLUSD + Regulatory feeds
// Node 18+ (global fetch)

import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import RSSParser from "rss-parser";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// ---------------- in-memory cache + helpers ----------------
const cache = new Map();
const now = () => Date.now();
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const round1 = (n) => Math.round(n * 10) / 10;

async function withCache(key, ttlMs, fetcher) {
  const entry = cache.get(key);
  if (entry && (now() - entry.t) < ttlMs) return entry.v;
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

// ---------------- security headers ----------------
app.use((_, res, next) => {
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  next();
});

// ---------------- health ----------------
app.get("/api/health", (_req, res) => res.json({ status: "ok", ts: Date.now() }));

// ---------------- prices (USDT/USDC/DAI/sDAI + XRP + RLUSD) ----------------
app.get("/api/prices", async (_req, res) => {
  const CG = {
    USDT: "tether",
    USDC: "usd-coin",
    DAI: "dai",
    sDAI: "savings-dai",
    XRP: "ripple",
    RLUSD: "ripple-usd"
  };

  async function llamaCoins() {
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
      data[sym] = { price: (typeof px === "number" ? px : null), confidence: null };
    }
    return data;
  }

  try {
    const data = await withCache("prices", 60_000, async () => {
      const primary = await llamaCoins();
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

// ---------------- stablecoin series per chain (incl. XRPL aliasing) ----------------
const CHAIN_ALIASES = {
  Ethereum: ["Ethereum"],
  Tron: ["Tron"],
  XRPL: ["XRPL", "XRP Ledger", "Ripple"]
};

async function getStablecoinSeriesForChain(chain) {
  const candidates = [chain, ...(CHAIN_ALIASES[chain] || [])].filter((v, i, a) => a.indexOf(v) === i);
  for (const name of candidates) {
    try {
      const url = `https://stablecoins.llama.fi/stablecoincharts/${encodeURIComponent(name)}?stablecoin=1`;
      const r = await fetchWithRetry(url, {}, 2);
      const arr = await r.json();
      if (Array.isArray(arr) && arr.length) {
        return arr.map(row => ({
          t: (row.date * 1000) || null,
          circulatingUSD: row?.totalCirculatingUSD?.peggedUSD ?? null,
          bridgedUSD: row?.totalBridgedToUSD?.peggedUSD ?? null
        })).filter(p => p.t && (p.circulatingUSD != null));
      }
    } catch { /* try next alias */ }
  }
  throw new Error(`No series for ${chain}`);
}

app.get("/api/stablecoins/chain", async (req, res) => {
  const chain = (req.query.chain || "Ethereum").toString();
  try {
    const series = await withCache(`stables:${chain}`, 30 * 60_000, () => getStablecoinSeriesForChain(chain));
    res.json({ chain, updatedAt: Date.now(), series });
  } catch {
    res.status(502).json({ error: `Stablecoin series unavailable for ${chain}` });
  }
});

// ---------------- APYs (DeFiLlama yields) ----------------
async function getAllPools() {
  return await withCache("yields:pools", 10 * 60_000, async () => {
    const r = await fetchWithRetry("https://yields.llama.fi/pools");
    const out = await r.json();
    return Array.isArray(out?.data) ? out.data : [];
  });
}
const pickAPY = (p) => (typeof p?.apy === "number" ? p.apy : typeof p?.apyBase === "number" ? p.apyBase : null);

app.get("/api/yields", async (req, res) => {
  const symbol = (req.query.symbol || "DAI").toString().toUpperCase();
  try {
    const pools = await getAllPools();
    const filtered = pools
      .filter(p => (p?.symbol || "").toUpperCase().includes(symbol))
      .map(p => ({
        project: p.project, chain: p.chain, symbol: p.symbol,
        apy: pickAPY(p), apyBase: (typeof p?.apyBase === "number" ? p.apyBase : null),
        apyReward: (typeof p?.apyReward === "number" ? p.apyReward : null),
        tvlUsd: p.tvlUsd ?? null, url: p.url || null
      }))
      .filter(p => p.apy != null)
      .sort((a, b) => (b.apy || 0) - (a.apy || 0))
      .slice(0, 8);
    res.json({ symbol, updatedAt: Date.now(), pools: filtered });
  } catch {
    res.status(502).json({ error: `Yield data unavailable for ${symbol}` });
  }
});

app.get("/api/yields/summary", async (req, res) => {
  const list = (req.query.symbols || "USDT,USDC,DAI,sDAI,RLUSD").toString().split(",").map(s => s.trim()).filter(Boolean);
  try {
    const pools = await getAllPools();
    const out = list.map(sym => {
      const S = sym.toUpperCase();
      const ps = pools
        .filter(p => (p?.symbol || "").toUpperCase().includes(S))
        .map(p => ({ apy: pickAPY(p), tvl: p.tvlUsd || 0, project: p.project, chain: p.chain }))
        .filter(p => p.apy != null);
      if (ps.length === 0) return { symbol: S, count: 0 };
      const apys = ps.map(p => p.apy).sort((a, b) => a - b);
      const avg = apys.reduce((a, b) => a + b, 0) / apys.length;
      const median = (apys.length % 2) ? apys[(apys.length - 1) / 2] : (apys[apys.length / 2 - 1] + apys[apys.length / 2]) / 2;
      const best = ps.sort((a, b) => b.apy - a.apy)[0];
      return { symbol: S, count: ps.length, bestApy: best.apy, bestProject: best.project, bestChain: best.chain, medianApy: avg ? round1(median) : null, avgApy: avg ? round1(avg) : null };
    });
    res.json({ updatedAt: Date.now(), summary: out });
  } catch {
    res.status(502).json({ error: "Yield summary unavailable" });
  }
});

app.get("/api/yields/sdai", (req, res) => { req.query.symbol = "sDAI"; app._router.handle(req, res, () => {}, "GET", "/api/yields"); });

// ---------------- Platforms (CeFi & DeFi) + Compliance Score ----------------
// NOTE: This is a heuristic score for product UX – not investment advice.
// Feel free to adjust attributes/weights below.

const PLATFORMS = [
  // ----- CeFi: Exchanges / Custody -----
  { name: "Coinbase", type: "CeFi", category: "Exchange", regionFocus: "US/Global",
    kycAml: true, proofOfReserves: "partial", independentAudit: true, licenseCoverage: "high",
    majorEnforcementEvents: 1, securityAudits: true, remarks: "Public company; financial statements audited." },
  { name: "Kraken", type: "CeFi", category: "Exchange", regionFocus: "US/Global",
    kycAml: true, proofOfReserves: "yes", independentAudit: true, licenseCoverage: "high",
    majorEnforcementEvents: 1, securityAudits: true, remarks: "Publishes PoR attestations periodically." },
  { name: "Binance", type: "CeFi", category: "Exchange", regionFocus: "Global",
    kycAml: true, proofOfReserves: "partial", independentAudit: false, licenseCoverage: "medium",
    majorEnforcementEvents: 2, securityAudits: true, remarks: "PoR snapshots; mixed jurisdiction footprint." },
  { name: "OKX", type: "CeFi", category: "Exchange", regionFocus: "Global",
    kycAml: true, proofOfReserves: "yes", independentAudit: false, licenseCoverage: "medium",
    majorEnforcementEvents: 0, securityAudits: true, remarks: "Regular PoR Merkle audits." },
  { name: "Ledger", type: "CeFi", category: "Custody/Wallet", regionFocus: "Global",
    scoringProfile: "custody", kycAml: false, proofOfReserves: "n/a", independentAudit: true, licenseCoverage: "n/a",
    majorEnforcementEvents: 0, securityAudits: true, bugBounty: true, remarks: "Non-custodial hardware wallet." },

  // ----- DeFi: Protocol issuers / platforms -----
  { name: "MakerDAO", type: "DeFi", category: "Issuer/Protocol", regionFocus: "On-chain",
    onchainTransparency: true, audits: ["Trail of Bits","Quantstamp"], formalVerification: false,
    algorithmicRisk: false, depegIncidents: false, remarks: "DAI issuer; collateral on-chain." },
  { name: "Frax Finance", type: "DeFi", category: "Issuer/Protocol", regionFocus: "On-chain",
    onchainTransparency: true, audits: ["CertiK","Trail of Bits"], formalVerification: false,
    algorithmicRisk: true, depegIncidents: false, remarks: "Hybrid model; multiple audits." },
  { name: "Liquity", type: "DeFi", category: "Lending Protocol", regionFocus: "On-chain",
    onchainTransparency: true, audits: ["Trail of Bits"], formalVerification: true,
    algorithmicRisk: false, depegIncidents: false, remarks: "ETH-backed LUSD; governance-minimal." }
];

// scoring functions
function scoreCeFi(p) {
  const isCustody = p.scoringProfile === "custody" || p.category === "Custody/Wallet";
  if (isCustody) {
    let s = 6;
    if (p.independentAudit) s += 1;
    if (p.securityAudits) s += 1;
    if (p.bugBounty) s += 0.5;
    s -= Math.min(2, (p.majorEnforcementEvents || 0) * 0.5);
    return clamp(round1(s), 1, 10);
  }
  let s = 5;
  if (p.kycAml) s += 1.5;
  if (p.proofOfReserves === "yes" || p.proofOfReserves === true) s += 1;
  else if (p.proofOfReserves === "partial") s += 0.5;
  if (p.independentAudit) s += 1;
  if (p.licenseCoverage === "high") s += 1;
  else if (p.licenseCoverage === "medium") s += 0.5;
  s -= Math.min(2, (p.majorEnforcementEvents || 0) * 0.8);
  if (p.securityAudits) s += 0.3;
  return clamp(round1(s), 1, 10);
}

function scoreDeFi(p) {
  let s = 6;
  if (p.onchainTransparency) s += 1;
  const audits = Array.isArray(p.audits) ? p.audits.length : 0;
  if (audits >= 1) s += 1;
  if (audits >= 2) s += 0.5;
  if (p.formalVerification) s += 0.5;
  if (p.algorithmicRisk) s -= 1.5;
  if (p.depegIncidents) s -= 1;
  return clamp(round1(s), 1, 10);
}

function computeScore(p) {
  return p.type === "DeFi" ? scoreDeFi(p) : scoreCeFi(p);
}

app.get("/api/platforms", async (req, res) => {
  try {
    let list = PLATFORMS.map(p => ({
      ...p,
      complianceScore: computeScore(p),
      computedAt: Date.now()
    }));

    const q = (req.query.q || "").toString().toLowerCase();
    const type = (req.query.type || "All").toString();
    const minScore = Number.isFinite(Number(req.query.minScore)) ? Number(req.query.minScore) : 0;
    const sort = (req.query.sort || "scoreDesc").toString();

    if (type === "CeFi" || type === "DeFi") list = list.filter(p => p.type === type);
    if (q) list = list.filter(p => p.name.toLowerCase().includes(q));
    if (minScore > 0) list = list.filter(p => (p.complianceScore || 0) >= minScore);

    if (sort === "nameAsc") list.sort((a,b) => a.name.localeCompare(b.name));
    else if (sort === "scoreAsc") list.sort((a,b) => (a.complianceScore||0) - (b.complianceScore||0));
    else list.sort((a,b) => (b.complianceScore||0) - (a.complianceScore||0)); // scoreDesc

    res.json({ updatedAt: Date.now(), count: list.length, platforms: list });
  } catch {
    res.status(500).json({ error: "Platforms unavailable" });
  }
});

// ---------------- News feeds ----------------
const rss = new RSSParser();

// Fed + BIS
app.get("/api/news", async (_req, res) => {
  try {
    const news = await withCache("news:fed+bis", 30 * 60_000, async () => {
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
            items.push({ source: parsed.title || new URL(f).hostname, title: it.title, link: it.link, published: it.isoDate || it.pubDate || null });
          }
        } catch {}
      }
      return items.filter(i => i.title && i.link).sort((a,b)=>new Date(b.published||0)-new Date(a.published||0)).slice(0,20);
    });
    res.json({ updatedAt: Date.now(), items: news });
  } catch { res.status(502).json({ error: "News unavailable" }); }
});

// Regulatory (SEC + CFTC)
app.get("/api/news/regulatory", async (_req, res) => {
  try {
    const items = await withCache("news:regulators", 20 * 60_000, async () => {
      const feeds = [
        "https://www.sec.gov/news/pressreleases.rss",
        "https://www.cftc.gov/RSS/RSSGP/rssgp.xml",
        "https://www.cftc.gov/RSS/RSSENF/rssenf.xml"
      ];
      const acc = [];
      for (const f of feeds) {
        try {
          const xml = await (await fetchWithRetry(f)).text();
          const parsed = await rss.parseString(xml);
          for (const it of parsed.items || []) acc.push({ source: parsed.title || new URL(f).hostname, title: it.title, link: it.link, published: it.isoDate || it.pubDate || null });
        } catch {}
      }
      return acc.filter(i => i.title && i.link).sort((a,b)=>new Date(b.published||0)-new Date(a.published||0)).slice(0,25);
    });
    res.json({ updatedAt: Date.now(), items });
  } catch { res.status(502).json({ error: "Regulatory feeds unavailable" }); }
});

// Ripple / XRPL
app.get("/api/news/xrp", async (_req, res) => {
  try {
    const items = await withCache("news:xrp", 30 * 60_000, async () => {
      const feeds = [
        "https://ripple.com/press-releases/feed/",
        "https://xrpl.org/blog/index.xml"
      ];
      const acc = [];
      for (const f of feeds) {
        try {
          const xml = await (await fetchWithRetry(f)).text();
          const parsed = await rss.parseString(xml);
          for (const it of parsed.items || []) acc.push({ source: parsed.title || new URL(f).hostname, title: it.title, link: it.link, published: it.isoDate || it.pubDate || null });
        } catch {}
      }
      return acc.filter(i => i.title && i.link).sort((a,b)=>new Date(b.published||0)-new Date(a.published||0)).slice(0,20);
    });
    res.json({ updatedAt: Date.now(), items });
  } catch { res.status(502).json({ error: "Ripple/XRPL feeds unavailable" }); }
});

// ---------------- static + catch-all ----------------
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`StableLens v1 listening on :${PORT}`));

