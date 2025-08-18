// StableLens v1.1 — richer endpoints, detail views, basic charts data
// Free APIs only. Node >= 18 (ESM)

import express from "express";
import cors from "cors";
import compression from "compression";
import helmet from "helmet";
import RSSParser from "rss-parser";
import { fileURLToPath } from "url";
import path from "path";

// --------------------------------------------------------
// Bootstrapping
// --------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

const allow = process.env.CORS_ORIGIN?.split(",").map(s => s.trim());
app.use(cors(allow ? { origin: allow } : {}));
app.use(express.json());
app.use(compression());
app.use(
  helmet({
    contentSecurityPolicy: false,         // allow CDN Chart.js + inline in our simple UI
    crossOriginResourcePolicy: false
  })
);

const parser = new RSSParser();

// --------------------------------------------------------
// In-memory cache
// --------------------------------------------------------
const cache = {
  stablecoins: { data: null, t: 0 },
  yields: { data: null, t: 0 },
  platforms: { data: null, t: 0 },
  news: { data: null, t: 0 },
  alerts: { data: null, t: 0 }
};

const TTL = {
  stablecoins: 5 * 60 * 1000,
  yields: 5 * 60 * 1000,
  platforms: 12 * 60 * 60 * 1000,
  news: 10 * 60 * 1000,
  alerts: 60 * 1000
};

// --------------------------------------------------------
// Seed registries (expand anytime)
// --------------------------------------------------------
const SEEDED_STABLES = [
  {
    symbol: "USDC",
    name: "USD Coin",
    issuer: "Circle",
    jurisdiction: "US (MSB) / EU EMI",
    auditor: "Grant Thornton",
    model: "fiat-backed",
    genius: "yes",
    chains: ["Ethereum", "Base", "Solana", "Arbitrum", "Polygon"]
  },
  {
    symbol: "USDT",
    name: "Tether",
    issuer: "Tether",
    jurisdiction: "Offshore",
    auditor: "BDO",
    model: "fiat-backed",
    genius: "likely",
    chains: ["Ethereum", "Tron", "Arbitrum", "BSC", "Polygon"]
  },
  {
    symbol: "DAI",
    name: "DAI",
    issuer: "MakerDAO",
    jurisdiction: "Decentralized",
    auditor: "Withum",
    model: "crypto-collateralized",
    genius: "yes",
    chains: ["Ethereum", "Layer2"]
  },
  {
    symbol: "sDAI",
    name: "Savings DAI",
    issuer: "MakerDAO",
    jurisdiction: "Decentralized",
    auditor: "Withum",
    model: "yield-bearing (DAI -> sDAI)",
    genius: "yes",
    chains: ["Ethereum"]
  },
  {
    symbol: "FRAX",
    name: "Frax",
    issuer: "Frax",
    jurisdiction: "US (MSB)",
    auditor: "Withum",
    model: "hybrid",
    genius: "likely",
    chains: ["Ethereum", "Fraxtal", "Arbitrum"]
  },
  {
    symbol: "PYUSD",
    name: "PayPal USD",
    issuer: "PayPal (via Paxos)",
    jurisdiction: "NYDFS",
    auditor: "Withum",
    model: "fiat-backed",
    genius: "yes",
    chains: ["Ethereum", "Solana"]
  },
  {
    symbol: "GHO",
    name: "GHO",
    issuer: "Aave",
    jurisdiction: "Decentralized",
    auditor: "Various",
    model: "crypto-collateralized",
    genius: "likely",
    chains: ["Ethereum"]
  },
  {
    symbol: "RLUSD",
    name: "Ripple USD (announced)",
    issuer: "Ripple",
    jurisdiction: "US",
    auditor: "TBD",
    model: "fiat-backed",
    genius: "likely",
    status: "announced",
    chains: ["XRPL", "Ethereum"]
  }
];

const SEEDED_PLATFORMS = {
  cefi: [
    {
      name: "Coinbase",
      jurisdiction: "US (NYDFS/FinCEN MSB)",
      licenses: ["NY BitLicense", "MSB"],
      auditor: "Deloitte (financials)",
      por: "Yes (independent attestations)",
      insured: false,
      riskNotes: "High regulatory transparency in US",
      scoreBase: 8.8
    },
    {
      name: "Kraken",
      jurisdiction: "US/EU (various)",
      licenses: ["MSB", "Virtual Asset Service Provider EU"],
      auditor: "Independent attestations",
      por: "Yes",
      insured: false,
      riskNotes: "Strong compliance posture",
      scoreBase: 8.3
    },
    {
      name: "Binance",
      jurisdiction: "Global (offshore + local entities)",
      licenses: ["Local registrations vary"],
      auditor: "Proof-of-reserves style reports",
      por: "Partial",
      insured: false,
      riskNotes: "Regulatory actions/settlements noted",
      scoreBase: 6.3
    },
    {
      name: "OKX",
      jurisdiction: "Global",
      licenses: ["Local registrations vary"],
      auditor: "PoR style reports",
      por: "Partial",
      insured: false,
      riskNotes: "Offshore entity",
      scoreBase: 6.8
    },
    {
      name: "Gemini",
      jurisdiction: "US (NYDFS)",
      licenses: ["NY BitLicense", "Trust company"],
      auditor: "Withum (PoR historically)",
      por: "Yes (historically)",
      insured: false,
      riskNotes: "US-regulated trust company",
      scoreBase: 8.1
    },
    {
      name: "Bitstamp",
      jurisdiction: "EU/Global",
      licenses: ["EU VASP"],
      auditor: "Independent attestations",
      por: "Yes/Partial",
      insured: false,
      riskNotes: "Long operating history",
      scoreBase: 7.6
    }
  ],
  defi: [
    {
      name: "Aave",
      chain: "Ethereum/Multichain",
      audits: ["Trail of Bits", "OpenZeppelin", "Certora"],
      por: "N/A",
      insured: false,
      riskNotes: "Governance & oracle risks",
      scoreBase: 7.5
    },
    {
      name: "Compound",
      chain: "Ethereum",
      audits: ["OpenZeppelin", "Trail of Bits"],
      por: "N/A",
      insured: false,
      riskNotes: "Governance & oracle risks",
      scoreBase: 7.2
    },
    {
      name: "Curve",
      chain: "Ethereum/Multichain",
      audits: ["Trail of Bits", "MixBytes"],
      por: "N/A",
      insured: false,
      riskNotes: "AMM-specific risks; past incidents",
      scoreBase: 6.8
    },
    {
      name: "MakerDAO",
      chain: "Ethereum",
      audits: ["Runtime Verification", "Trail of Bits"],
      por: "On-chain transparency",
      insured: false,
      riskNotes: "Protocol & collateral risks",
      scoreBase: 7.9
    },
    {
      name: "Frax",
      chain: "Ethereum/Fraxtal",
      audits: ["Trail of Bits", "Certora"],
      por: "On-chain transparency",
      insured: false,
      riskNotes: "Protocol risks",
      scoreBase: 7.4
    }
  ]
};

// --------------------------------------------------------
// Scoring & helpers
// --------------------------------------------------------
function scoreStablecoin(sc, depegIncidents = 0) {
  // same heuristic as before, but robust to text variations
  let s = 5;
  const juris = (sc.jurisdiction || "");
  const auditor = (sc.auditor || "").toLowerCase();
  const genius = (sc.genius || "").toLowerCase();

  if (/(NYDFS|US\s*\(MSB)/i.test(juris)) s += 2;
  if (auditor.includes("grant thornton")) s += 1;
  if (auditor.includes("withum")) s += 0.8;
  if (auditor.includes("bdo")) s += 0.3;
  if ((sc.model || "") === "crypto-collateralized") s -= 0.8;
  if (/OFFSHORE|DECENTRALIZED/i.test(juris)) s -= 0.7;
  if (genius === "yes" || genius === "likely") s += 1.5;
  s -= Math.min(2, depegIncidents * 0.7);

  return Math.max(1, Math.min(10, Math.round(s * 10) / 10));
}

function scoreBreakdown(sc, depegIncidents = 0) {
  // break the final score into components for UI chart
  const parts = {
    base: 5,
    jurisdiction: /(NYDFS|US\s*\(MSB)/i.test(sc.jurisdiction || "") ? 2 : 0,
    auditor:
      (sc.auditor || "").toLowerCase().includes("grant thornton")
        ? 1
        : (sc.auditor || "").toLowerCase().includes("withum")
        ? 0.8
        : (sc.auditor || "").toLowerCase().includes("bdo")
        ? 0.3
        : 0,
    model: (sc.model || "") === "crypto-collateralized" ? -0.8 : 0,
    offshore: /OFFSHORE|DECENTRALIZED/i.test(sc.jurisdiction || "") ? -0.7 : 0,
    genius:
      (sc.genius || "").toLowerCase() === "yes" || (sc.genius || "").toLowerCase() === "likely"
        ? 1.5
        : 0,
    depeg: -Math.min(2, depegIncidents * 0.7)
  };
  const total =
    parts.base +
    parts.jurisdiction +
    parts.auditor +
    parts.model +
    parts.offshore +
    parts.genius +
    parts.depeg;

  return {
    parts,
    total: Math.max(1, Math.min(10, Math.round(total * 10) / 10))
  };
}

function scorePlatform(p) {
  let s = p.scoreBase || 6.5;
  if ((p.licenses || []).some(x => /NYDFS|TRUST|MSB|VASP/i.test(x))) s += 0.6;
  if ((p.auditor || "").toLowerCase().includes("deloitte")) s += 0.3;
  if ((p.por || "").toLowerCase().includes("partial")) s -= 0.3;
  if ((p.riskNotes || "").toLowerCase().includes("regulatory action")) s -= 0.8;
  return Math.max(1, Math.min(10, Math.round(s * 10) / 10));
}

async function safeJSON(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchYieldsFromLlama() {
  const url = "https://yields.llama.fi/pools";
  const json = await safeJSON(url);
  if (!json || !Array.isArray(json.data)) return [];
  return json.data;
}

function buildStablecoinList() {
  return SEEDED_STABLES.map(sc => {
    const incidents = 0;
    return {
      ...sc,
      score: scoreStablecoin(sc, incidents),
      price: null,
      supply: null
    };
  });
}

function buildPlatforms() {
  return {
    cefi: SEEDED_PLATFORMS.cefi.map(p => ({ ...p, score: scorePlatform(p) })),
    defi: SEEDED_PLATFORMS.defi.map(p => ({ ...p, score: scorePlatform(p) }))
  };
}

async function fetchNewsFeeds() {
  const feeds = [
    { name: "SEC", url: "https://www.sec.gov/news/pressreleases.rss" },
    { name: "CFTC", url: "https://www.cftc.gov/PressRoom/PressReleases/rss.xml" },
    { name: "Federal Reserve", url: "https://www.federalreserve.gov/feeds/press_all.xml" },
    { name: "BIS", url: "https://www.bis.org/list/press_releases.rss" },
    { name: "Ripple/XRPL", url: "https://xrpl.org/blog/index.xml" },
    { name: "CertiK", url: "https://www.certik.com/resources.rss" }
  ];

  const items = [];
  await Promise.all(
    feeds.map(async f => {
      try {
        const feed = await parser.parseURL(f.url);
        (feed.items || []).slice(0, 10).forEach(it => {
          items.push({
            source: f.name,
            title: it.title || "",
            link: it.link || "",
            date: it.isoDate || it.pubDate || "",
            isoDate: it.isoDate || it.pubDate || ""
          });
        });
      } catch {
        // ignore source failures
      }
    })
  );

  items.sort((a, b) => new Date(b.isoDate || 0) - new Date(a.isoDate || 0));
  return items.slice(0, 40);
}

function buildAlerts({ stablecoins = [], news = [] }) {
  const alerts = [];
  stablecoins.forEach(s => {
    if (typeof s.price === "number") {
      const diff = Math.abs(1 - s.price);
      if (diff >= 0.015) {
        alerts.push({
          type: "depeg",
          severity: diff >= 0.05 ? "high" : "medium",
          symbol: s.symbol,
          message: `${s.symbol} deviated ${Math.round(diff * 100)}% from $1`
        });
      }
    }
  });
  news.forEach(n => {
    const t = (n.title || "").toLowerCase();
    if (
      /enforcement|settlement|charge|lawsuit|penalty|consent order/.test(t) &&
      /(sec|cftc|doj|attorney general)/.test(t)
    ) {
      alerts.push({
        type: "regulatory",
        severity: "info",
        source: n.source,
        message: n.title,
        link: n.link
      });
    }
  });
  return alerts.slice(0, 50);
}

// --------------------------------------------------------
// API
// --------------------------------------------------------
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", ts: Date.now() });
});

app.get("/api/status", (_req, res) => {
  res.json({
    health: "ok",
    updatedAt: {
      stablecoins: cache.stablecoins.t || null,
      yields: cache.yields.t || null,
      platforms: cache.platforms.t || null,
      news: cache.news.t || null,
      alerts: cache.alerts.t || null
    }
  });
});

// List
app.get("/api/stablecoins", async (_req, res) => {
  try {
    if (!cache.stablecoins.data || Date.now() - cache.stablecoins.t > TTL.stablecoins) {
      cache.stablecoins = { data: buildStablecoinList(), t: Date.now() };
    }
    res.json({ stablecoins: cache.stablecoins.data });
  } catch {
    res.json({ stablecoins: buildStablecoinList() });
  }
});

// Detail (by symbol)
app.get("/api/stablecoins/:symbol", async (req, res) => {
  const sym = (req.params.symbol || "").toUpperCase();
  try {
    if (!cache.stablecoins.data) cache.stablecoins = { data: buildStablecoinList(), t: Date.now() };
    const found = cache.stablecoins.data.find(s => (s.symbol || "").toUpperCase() === sym);
    if (!found) return res.status(404).json({ error: "not_found" });

    // compute breakdown
    const incidents = 0;
    const breakdown = scoreBreakdown(found, incidents);

    // top pools for the symbol
    if (!cache.yields.data || Date.now() - cache.yields.t > TTL.yields) {
      const data = await fetchYieldsFromLlama();
      cache.yields = { data, t: Date.now() };
    }
    const pools = (cache.yields.data || [])
      .filter(p => (p.symbol || "").toUpperCase() === sym)
      .sort((a, b) => (b.apy || 0) - (a.apy || 0))
      .slice(0, 12)
      .map(p => ({
        project: p.project,
        chain: p.chain,
        symbol: p.symbol,
        apy: p.apy,
        apyBase: p.apyBase,
        apyReward: p.apyReward,
        tvlUsd: p.tvlUsd,
        pool: p.pool
      }));

    res.json({ stablecoin: found, breakdown, topPools: pools });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

// Platforms (list)
app.get("/api/platforms", async (_req, res) => {
  try {
    if (!cache.platforms.data || Date.now() - cache.platforms.t > TTL.platforms) {
      cache.platforms = { data: buildPlatforms(), t: Date.now() };
    }
    res.json(cache.platforms.data);
  } catch {
    res.json(buildPlatforms());
  }
});

// Platform detail (by name slug)
app.get("/api/platforms/:name", async (req, res) => {
  const name = decodeURIComponent(req.params.name || "");
  try {
    if (!cache.platforms.data) cache.platforms = { data: buildPlatforms(), t: Date.now() };
    const all = cache.platforms.data;
    const item =
      (all.cefi || []).find(p => p.name.toLowerCase() === name.toLowerCase()) ||
      (all.defi || []).find(p => p.name.toLowerCase() === name.toLowerCase());
    if (!item) return res.status(404).json({ error: "not_found" });
    res.json({ platform: item });
  } catch {
    res.status(500).json({ error: "server_error" });
  }
});

// Yields with filters/sorting
// /api/yields?symbol=&chain=&sort=apy|tvl&order=desc|asc&minScore=7
app.get("/api/yields", async (req, res) => {
  const symbol = (req.query.symbol || "").toUpperCase();
  const chain = req.query.chain || "";
  const sort = (req.query.sort || "apy").toLowerCase(); // apy|tvl
  const order = (req.query.order || "desc").toLowerCase(); // desc|asc
  const minScore = parseFloat(req.query.minScore || "0");

  try {
    if (!cache.yields.data || Date.now() - cache.yields.t > TTL.yields) {
      const data = await fetchYieldsFromLlama();
      cache.yields = { data, t: Date.now() };
    }
    if (!cache.stablecoins.data) cache.stablecoins = { data: buildStablecoinList(), t: Date.now() };

    // quick score map
    const scoreMap = new Map(cache.stablecoins.data.map(s => [s.symbol.toUpperCase(), s.score || 0]));

    let rows = cache.yields.data || [];
    if (symbol) rows = rows.filter(p => (p.symbol || "").toUpperCase() === symbol);
    if (chain) rows = rows.filter(p => (p.chain || "").toLowerCase() === chain.toLowerCase());
    if (minScore > 0) rows = rows.filter(p => (scoreMap.get((p.symbol || "").toUpperCase()) || 0) >= minScore);

    rows = rows.map(p => ({
      project: p.project,
      chain: p.chain,
      symbol: p.symbol,
      apy: p.apy,
      apyBase: p.apyBase,
      apyReward: p.apyReward,
      tvlUsd: p.tvlUsd,
      pool: p.pool
    }));

    rows.sort((a, b) => {
      const key = sort === "tvl" ? "tvlUsd" : "apy";
      const av = a[key] || 0, bv = b[key] || 0;
      return order === "asc" ? av - bv : bv - av;
    });

    res.json({ pools: rows.slice(0, 200) });
  } catch {
    res.json({ pools: [] });
  }
});

// Best finder
// /api/best?minScore=7&chain=Ethereum&top=10
app.get("/api/best", async (req, res) => {
  const minScore = parseFloat(req.query.minScore || "0");
  const chain = req.query.chain || "";
  const top = Math.min(200, parseInt(req.query.top || "20", 10));

  try {
    if (!cache.yields.data || Date.now() - cache.yields.t > TTL.yields) {
      const data = await fetchYieldsFromLlama();
      cache.yields = { data, t: Date.now() };
    }
    if (!cache.stablecoins.data) cache.stablecoins = { data: buildStablecoinList(), t: Date.now() };

    const scoreMap = new Map(cache.stablecoins.data.map(s => [s.symbol.toUpperCase(), s.score || 0]));
    let rows = cache.yields.data || [];
    if (chain) rows = rows.filter(p => (p.chain || "").toLowerCase() === chain.toLowerCase());
    if (minScore > 0) rows = rows.filter(p => (scoreMap.get((p.symbol || "").toUpperCase()) || 0) >= minScore);

    rows = rows
      .filter(p => p.symbol && typeof p.apy === "number")
      .sort((a, b) => (b.apy || 0) - (a.apy || 0))
      .slice(0, top)
      .map(p => ({
        project: p.project,
        chain: p.chain,
        symbol: p.symbol,
        apy: p.apy,
        tvlUsd: p.tvlUsd,
        pool: p.pool,
        complianceScore: scoreMap.get((p.symbol || "").toUpperCase()) || 0
      }));

    res.json({ results: rows });
  } catch {
    res.json({ results: [] });
  }
});

// News + Alerts
app.get("/api/news", async (_req, res) => {
  try {
    if (!cache.news.data || Date.now() - cache.news.t > TTL.news) {
      const data = await fetchNewsFeeds();
      cache.news = { data, t: Date.now() };
    }
    res.json({ items: cache.news.data });
  } catch {
    res.json({ items: [] });
  }
});

app.get("/api/alerts", async (_req, res) => {
  try {
    if (!cache.stablecoins.data) cache.stablecoins = { data: buildStablecoinList(), t: Date.now() };
    if (!cache.news.data || Date.now() - cache.news.t > TTL.news) {
      const n = await fetchNewsFeeds();
      cache.news = { data: n, t: Date.now() };
    }
    const data = buildAlerts({ stablecoins: cache.stablecoins.data, news: cache.news.data });
    cache.alerts = { data, t: Date.now() };
    res.json({ alerts: data });
  } catch {
    res.json({ alerts: [] });
  }
});

// --------------------------------------------------------
// Static UI
// --------------------------------------------------------
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --------------------------------------------------------
// Prewarm & Listen
// --------------------------------------------------------
(async function prewarm() {
  try {
    cache.stablecoins = { data: buildStablecoinList(), t: Date.now() };
    cache.platforms = { data: buildPlatforms(), t: Date.now() };
    const [y, n] = await Promise.all([fetchYieldsFromLlama(), fetchNewsFeeds()]);
    cache.yields = { data: y, t: Date.now() };
    cache.news = { data: n, t: Date.now() };
  } catch {
    // ignore warm-up failures
  }
})();

app.listen(PORT, () => {
  console.log(`StableLens v1 listening on :${PORT}`);
});

