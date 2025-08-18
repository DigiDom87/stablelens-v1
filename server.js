// StableLens v1 (clean, no DB, free feeds)
// Node >= 18, ESM

import express from "express";
import cors from "cors";
import compression from "compression";
import helmet from "helmet";
import RSSParser from "rss-parser";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());
app.use(compression());
app.use(
  helmet({
    contentSecurityPolicy: false, // allow inline script/styles in our simple UI
    crossOriginResourcePolicy: false
  })
);

// -----------------------------
// Basic in-memory cache
// -----------------------------
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

const parser = new RSSParser();

// -----------------------------
// Seed data (safe defaults)
// -----------------------------

// v1 stablecoins list (can extend later; no paid feeds)
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

// CeFi/DeFi platforms, seeded compliance-ish metadata
const SEEDED_PLATFORMS = {
  cefi: [
    {
      name: "Coinbase",
      jurisdiction: "US (NYDFS/FinCEN MSB)",
      licenses: ["NY BitLicense", "MSB"],
      auditor: "Deloitte (financials)",
      por: "Yes (independent attestations)",
      insured: false, // no FDIC/FSCS for crypto balances
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

// -----------------------------
// Helpers
// -----------------------------

function scoreStablecoin(sc, depegIncidents = 0) {
  // Heuristic 1-10; robust to text variations (no fragile quotes)
  let s = 5;
  const juris = (sc.jurisdiction || "");
  const auditor = (sc.auditor || "").toLowerCase();
  const genius = (sc.genius || "").toLowerCase();

  // Jurisdiction boost: NYDFS or US (MSB) — regex avoids special-char pitfalls
  if (/(NYDFS|US\s*\(MSB)/i.test(juris)) s += 2;

  // Auditor signals
  if (auditor.includes("grant thornton")) s += 1;
  if (auditor.includes("withum")) s += 0.8;
  if (auditor.includes("bdo")) s += 0.3;

  // Model effects
  if ((sc.model || "") === "crypto-collateralized") s -= 0.8; // slightly riskier for regulators
  if (genius === "yes" || genius === "likely") s += 1.5;

  // Offshore/decentralized penalty
  if (/OFFSHORE|DECENTRALIZED/i.test(juris)) s -= 0.7;

  // Depeg incidents penalty
  s -= Math.min(2, depegIncidents * 0.7);

  // Clamp & round
  return Math.max(1, Math.min(10, Math.round(s * 10) / 10));
}

function scorePlatform(p) {
  let s = p.scoreBase || 6.5;
  if ((p.licenses || []).some((x) => /NYDFS|TRUST|MSB|VASP/i.test(x))) s += 0.6;
  if ((p.auditor || "").toLowerCase().includes("deloitte")) s += 0.3;
  if ((p.por || "").toLowerCase().includes("partial")) s -= 0.3;
  if ((p.riskNotes || "").toLowerCase().includes("regulatory action")) s -= 0.8;
  return Math.max(1, Math.min(10, Math.round(s * 10) / 10));
}

async function safeJSON(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fetchYields() {
  // DeFiLlama free yields catalog
  const url = "https://yields.llama.fi/pools";
  const json = await safeJSON(url);
  if (!json || !Array.isArray(json.data)) return [];
  return json.data;
}

async function fetchNewsFeeds() {
  // If any feed fails, we continue with the others
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
    feeds.map(async (f) => {
      try {
        const feed = await parser.parseURL(f.url);
        (feed.items || []).slice(0, 10).forEach((it) => {
          items.push({
            source: f.name,
            title: it.title || "",
            link: it.link || "",
            date: it.isoDate || it.pubDate || "",
            isoDate: it.isoDate || it.pubDate || ""
          });
        });
      } catch (e) {
        // ignore a failing source
      }
    })
  );

  // sort newest first
  items.sort((a, b) => new Date(b.isoDate || 0) - new Date(a.isoDate || 0));
  return items.slice(0, 40);
}

function buildStablecoinPayload() {
  // We could overlay price or supply from free sources later; for now keep robust
  const out = SEEDED_STABLES.map((sc) => {
    const incidents = 0; // placeholder; you can stitch depeg history later
    return {
      ...sc,
      score: scoreStablecoin(sc, incidents),
      price: null,
      supply: null
    };
  });
  return out;
}

function buildPlatformPayload() {
  return {
    cefi: SEEDED_PLATFORMS.cefi.map((p) => ({ ...p, score: scorePlatform(p) })),
    defi: SEEDED_PLATFORMS.defi.map((p) => ({ ...p, score: scorePlatform(p) }))
  };
}

function buildAlerts({ stablecoins = [], news = [] }) {
  const alerts = [];

  // Depeg alerts (if we eventually set price)
  stablecoins.forEach((s) => {
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

  // Enforcement style news alerts
  news.forEach((n) => {
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

// -----------------------------
// API Routes
// -----------------------------

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

app.get("/api/stablecoins", async (_req, res) => {
  try {
    if (!cache.stablecoins.data || Date.now() - cache.stablecoins.t > TTL.stablecoins) {
      const data = buildStablecoinPayload();
      cache.stablecoins = { data, t: Date.now() };
    }
    res.json({ stablecoins: cache.stablecoins.data });
  } catch (e) {
    res.json({ stablecoins: buildStablecoinPayload() });
  }
});

app.get("/api/yields", async (req, res) => {
  try {
    if (!cache.yields.data || Date.now() - cache.yields.t > TTL.yields) {
      const data = await fetchYields();
      cache.yields = { data, t: Date.now() };
    }
    const symbol = (req.query.symbol || "").toUpperCase();
    let out = cache.yields.data || [];
    if (symbol) {
      out = out.filter((p) => (p.symbol || "").toUpperCase() === symbol);
    }
    // return lightweight fields
    out = out.slice(0, 50).map((p) => ({
      project: p.project,
      chain: p.chain,
      symbol: p.symbol,
      apy: p.apy,
      apyBase: p.apyBase,
      apyReward: p.apyReward,
      tvlUsd: p.tvlUsd,
      pool: p.pool
    }));
    res.json({ pools: out });
  } catch (e) {
    res.json({ pools: [] });
  }
});

app.get("/api/platforms", async (_req, res) => {
  try {
    if (!cache.platforms.data || Date.now() - cache.platforms.t > TTL.platforms) {
      const data = buildPlatformPayload();
      cache.platforms = { data, t: Date.now() };
    }
    res.json(cache.platforms.data);
  } catch (e) {
    res.json(buildPlatformPayload());
  }
});

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
    // ensure upstream caches are warm enough
    if (!cache.stablecoins.data) cache.stablecoins = { data: buildStablecoinPayload(), t: Date.now() };
    if (!cache.news.data || Date.now() - cache.news.t > TTL.news) {
      const n = await fetchNewsFeeds();
      cache.news = { data: n, t: Date.now() };
    }
    const data = buildAlerts({ stablecoins: cache.stablecoins.data, news: cache.news.data });
    cache.alerts = { data, t: Date.now() };
    res.json({ alerts: data });
  } catch (e) {
    res.json({ alerts: [] });
  }
});

// -----------------------------
// Static UI
// -----------------------------
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// -----------------------------
app.listen(PORT, () => {
  console.log(`StableLens v1 listening on :${PORT}`);
});

