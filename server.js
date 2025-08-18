// StableLens v2 — Institutional-Grade Free-API Edition
// Node 18+ (global fetch)

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";
import { Pool } from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import RSSParser from "rss-parser";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- env ----------
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change";
const DATABASE_URL = process.env.DATABASE_URL || ""; // Set on Railway (Postgres)

// ---------- app ----------
const app = express();
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());

// Security headers
app.use((_, res, next) => {
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  next();
});

// ---------- db ----------
let pool = null;
if (DATABASE_URL) {
  pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
}

// Create tables if not present
async function initDb() {
  if (!pool) return;
  await pool.query(`
    create table if not exists users (
      id bigserial primary key,
      email text unique not null,
      pass_hash text not null,
      tier text not null default 'free', -- 'free' | 'pro' | 'enterprise'
      prefs jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
    create table if not exists alerts_cfg (
      user_id bigint primary key references users(id) on delete cascade,
      cfg jsonb not null default '{}'::jsonb,
      updated_at timestamptz not null default now()
    );
    create table if not exists alert_events (
      id bigserial primary key,
      type text not null, -- 'depeg' | 'stale' | 'regulatory' | 'security'
      entity_type text not null, -- 'coin' | 'platform' | 'pool'
      entity_key text not null,
      severity text not null, -- 'info' | 'warn' | 'critical'
      message text not null,
      created_at timestamptz not null default now()
    );
  `);
  console.log("DB ready");
}

// ---------- auth helpers ----------
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "14d" });
}
function authRequired(req, res, next) {
  const token = req.cookies?.sl_token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

// ---------- cache + fetch helpers ----------
const cache = new Map();
const now = () => Date.now();
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
          "user-agent": "StableLens/2.0 (free-api)",
          ...(opts.headers || {})
        },
        signal: AbortSignal.timeout?.(15000)
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

// ---------- HEALTH / STATUS ----------
const statusTimes = {
  prices: 0,
  yields: 0,
  stablechains: {},
  news: 0,
  regulatory: 0,
  xrpnews: 0
};

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", ts: Date.now() });
});
app.get("/api/status", (_req, res) => {
  res.json({ updatedAt: Date.now(), statusTimes });
});

// ---------- AUTH ----------
app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Missing email/password" });
    if (!pool) return res.status(500).json({ error: "DB unavailable" });
    const pass_hash = await bcrypt.hash(password, 10);
    const q = await pool.query(
      "insert into users(email, pass_hash) values($1,$2) on conflict(email) do nothing returning id, tier;",
      [email.toLowerCase(), pass_hash]
    );
    if (q.rowCount === 0) return res.status(409).json({ error: "Email already registered" });
    const user = { id: q.rows[0].id, email: email.toLowerCase(), tier: q.rows[0].tier };
    const token = signToken({ id: user.id, email: user.email, tier: user.tier });
    res.cookie("sl_token", token, { httpOnly: true, sameSite: "lax", secure: true, maxAge: 14*24*3600*1000 });
    res.json({ user });
  } catch {
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Missing email/password" });
    if (!pool) return res.status(500).json({ error: "DB unavailable" });
    const q = await pool.query("select id, pass_hash, tier from users where email=$1", [email.toLowerCase()]);
    if (q.rowCount === 0) return res.status(401).json({ error: "Invalid credentials" });
    const ok = await bcrypt.compare(password, q.rows[0].pass_hash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });
    const user = { id: q.rows[0].id, email: email.toLowerCase(), tier: q.rows[0].tier };
    const token = signToken({ id: user.id, email: user.email, tier: user.tier });
    res.cookie("sl_token", token, { httpOnly: true, sameSite: "lax", secure: true, maxAge: 14*24*3600*1000 });
    res.json({ user });
  } catch {
    res.status(500).json({ error: "Login failed" });
  }
});

app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie("sl_token");
  res.json({ ok: true });
});

app.get("/api/me", authRequired, async (req, res) => {
  if (!pool) return res.status(500).json({ error: "DB unavailable" });
  const q = await pool.query("select id, email, tier, prefs from users where id=$1", [req.user.id]);
  if (q.rowCount === 0) return res.status(404).json({ error: "User not found" });
  res.json({ user: q.rows[0] });
});

app.post("/api/me/prefs", authRequired, async (req, res) => {
  try {
    const prefs = req.body?.prefs || {};
    const q = await pool.query("update users set prefs=$1 where id=$2 returning id, email, tier, prefs", [prefs, req.user.id]);
    res.json({ user: q.rows[0] });
  } catch {
    res.status(500).json({ error: "Failed to save prefs" });
  }
});

// ---------- STABLECOINS: metadata + scoring ----------
const SC = [
  // symbol, name, issuer, model, jurisdiction, auditor, genius, insurance, notes
  { symbol: "USDC", name: "USD Coin", issuer: "Circle", model: "fiat-backed", jurisdiction: "US (MSB/state MTs)", auditor: "Grant Thornton (attest)", genius: "likely", insurance: "reserves at FDIC banks; not token-insured" },
  { symbol: "USDT", name: "Tether", issuer: "Tether Ltd", model: "fiat-backed", jurisdiction: "BVI/HK (offshore)", auditor: "BDO Italia (attest)", genius: "no", insurance: "none" },
  { symbol: "DAI", name: "Dai", issuer: "MakerDAO", model: "crypto-collateralized", jurisdiction: "decentralized", auditor: "on-chain transparency", genius: "no", insurance: "n/a" },
  { symbol: "sDAI", name: "Savings Dai", issuer: "MakerDAO", model: "yield-bearing DAI", jurisdiction: "decentralized", auditor: "on-chain transparency", genius: "no", insurance: "n/a" },
  { symbol: "GUSD", name: "Gemini Dollar", issuer: "Gemini Trust", model: "fiat-backed", jurisdiction: "NYDFS Trust", auditor: "BPM (attest)", genius: "yes", insurance: "reserves at FDIC banks; not token-insured" },
  { symbol: "USDP", name: "Pax Dollar", issuer: "Paxos Trust", model: "fiat-backed", jurisdiction: "NYDFS Trust", auditor: "Withum (attest)", genius: "yes", insurance: "FDIC-bank reserves; not token-insured" },
  { symbol: "PYUSD", name: "PayPal USD", issuer: "Paxos for PayPal", model: "fiat-backed", jurisdiction: "NYDFS Trust", auditor: "Withum (attest)", genius: "yes", insurance: "FDIC-bank reserves; not token-insured" },
  { symbol: "FDUSD", name: "First Digital USD", issuer: "First Digital", model: "fiat-backed", jurisdiction: "HK Trust", auditor: "Independent (attest)", genius: "unknown", insurance: "custody only" },
  { symbol: "TUSD", name: "TrueUSD", issuer: "Techteryx", model: "fiat-backed", jurisdiction: "Offshore (multi-custody)", auditor: "Monthly attestations", genius: "unknown", insurance: "custody only" },
  { symbol: "RLUSD", name: "Ripple USD", issuer: "Ripple", model: "fiat-backed", jurisdiction: "US (NYDFS/BitLicense)", auditor: "Independent (attest)", genius: "yes", insurance: "FDIC-bank reserves; not token-insured" },
  { symbol: "USDP_EUROPE", name: "EURe (example)", issuer: "European issuer", model: "fiat-backed (EUR)", jurisdiction: "EU (EMT)", auditor: "Independent", genius: "n/a", insurance: "bank reserves" }
];

function scoreStablecoin(sc, depegIncidents = 0) {
  // Heuristic 1-10
  let s = 5;
  if (sc.jurisdiction.includes("NYDFS") || sc.jurisdiction.includes("US (MSB"))) s += 2;
  if (sc.auditor && sc.auditor.toLowerCase().includes("grant thornton")) s += 1;
  if (sc.auditor && sc.auditor.toLowerCase().includes("withum")) s += 0.8;
  if (sc.auditor && sc.auditor.toLowerCase().includes("bdo")) s += 0.3;
  if (sc.model === "crypto-collateralized") s -= 0.8; // regulatory opacity
  if (sc.genius === "yes" || sc.genius === "likely") s += 1.5;
  if (sc.jurisdiction.includes("offshore") || sc.jurisdiction.includes("decentralized")) s -= 0.7;
  s -= Math.min(2, depegIncidents * 0.7);
  return Math.max(1, Math.min(10, Math.round(s * 10) / 10));
}

const CHAIN_ALIASES = {
  Ethereum: ["Ethereum"],
  Tron: ["Tron"],
  XRPL: ["XRPL", "XRP Ledger", "Ripple"]
};

// Prices (add XRP & RLUSD)
app.get("/api/prices", async (_req, res) => {
  const CG = {
    USDT: "tether", USDC: "usd-coin", DAI: "dai", sDAI: "savings-dai",
    XRP: "ripple", RLUSD: "ripple-usd", GUSD: "gemini-dollar",
    USDP: "paxos-standard", PYUSD: "paypal-usd", FDUSD: "first-digital-usd",
    TUSD: "true-usd"
  };
  async function llama() {
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
  async function cgFallback() {
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
      const primary = await llama();
      const allNull = Object.values(primary).every(v => v.price == null);
      return allNull ? await cgFallback() : primary;
    });
    statusTimes.prices = Date.now();
    res.json({ updatedAt: Date.now(), data });
  } catch {
    try {
      const data = await cgFallback();
      statusTimes.prices = Date.now();
      res.json({ updatedAt: Date.now(), data });
    } catch {
      res.status(502).json({ error: "Price sources unavailable" });
    }
  }
});

// Stablecoin chain series (ETH/TRON/XRPL)
async function getStablecoinSeriesForChain(chain) {
  const candidates = [chain, ...(CHAIN_ALIASES[chain] || [])].filter((v,i,a)=>a.indexOf(v)===i);
  for (const name of candidates) {
    try {
      const url = `https://stablecoins.llama.fi/stablecoincharts/${encodeURIComponent(name)}?stablecoin=1`;
      const r = await fetchWithRetry(url, {}, 2);
      const arr = await r.json();
      if (Array.isArray(arr) && arr.length) {
        return arr.map(row => ({
          t: (row.date * 1000) || null,
          circulatingUSD: row?.totalCirculatingUSD?.peggedUSD ?? null
        })).filter(p => p.t && (p.circulatingUSD != null));
      }
    } catch {}
  }
  throw new Error("no series");
}

app.get("/api/stablecoins/chain", async (req, res) => {
  const chain = (req.query.chain || "Ethereum").toString();
  try {
    const series = await withCache(`stables:${chain}`, 30*60_000, async () => {
      const s = await getStablecoinSeriesForChain(chain);
      statusTimes.stablechains[chain] = Date.now();
      return s;
    });
    res.json({ chain, updatedAt: Date.now(), series });
  } catch {
    res.status(502).json({ error: `Stablecoin series unavailable for ${chain}` });
  }
});

// DeFi yields via Llama
async function getAllPools() {
  return await withCache("yields:pools", 10*60_000, async () => {
    const r = await fetchWithRetry("https://yields.llama.fi/pools");
    const out = await r.json();
    statusTimes.yields = Date.now();
    return Array.isArray(out?.data) ? out.data : [];
  });
}
const pickAPY = (p) => (typeof p?.apy === "number" ? p.apy :
                         typeof p?.apyBase === "number" ? p.apyBase : null);

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
      .sort((a,b) => (b.apy || 0) - (a.apy || 0))
      .slice(0, 10);
    res.json({ symbol, updatedAt: Date.now(), pools: filtered });
  } catch {
    res.status(502).json({ error: `Yield data unavailable for ${symbol}` });
  }
});

app.get("/api/yields/summary", async (req, res) => {
  const list = (req.query.symbols || "USDT,USDC,DAI,sDAI,RLUSD,GUSD,USDP,PYUSD,FDUSD,TUSD")
    .toString().split(",").map(s=>s.trim()).filter(Boolean);
  try {
    const pools = await getAllPools();
    const out = list.map(sym => {
      const S = sym.toUpperCase();
      const ps = pools
        .filter(p => (p?.symbol || "").toUpperCase().includes(S))
        .map(p => ({ apy: pickAPY(p), tvl: p.tvlUsd || 0, project: p.project, chain: p.chain }))
        .filter(p => p.apy != null);
      if (ps.length === 0) return { symbol: S, count: 0 };
      const apys = ps.map(p => p.apy).sort((a,b) => a-b);
      const avg = apys.reduce((a,b)=>a+b,0)/apys.length;
      const median = (apys.length % 2) ? apys[(apys.length-1)/2]
                   : (apys[apys.length/2-1] + apys[apys.length/2]) / 2;
      const best = ps.sort((a,b)=>b.apy-a.apy)[0];
      return { symbol: S, count: ps.length, bestApy: best.apy, bestProject: best.project, bestChain: best.chain,
               medianApy: Math.round(median*100)/100, avgApy: Math.round(avg*100)/100 };
    });
    res.json({ updatedAt: Date.now(), summary: out });
  } catch {
    res.status(502).json({ error: "Yield summary unavailable" });
  }
});

// CeFi/DeFi platforms + scoring (expanded)
const PLATFORMS = [
  { name: "Coinbase", type: "CeFi", category: "Exchange", region: "US", kyc:true, por:"partial", audit:true, license:"high", events:1, secAudit:true, notes:"Public; USDC rewards." },
  { name: "Kraken", type: "CeFi", category: "Exchange", region: "US", kyc:true, por:"yes", audit:true, license:"high", events:1, secAudit:true, notes:"PoR attestations." },
  { name: "Gemini", type: "CeFi", category: "Exchange", region: "US", kyc:true, por:"yes", audit:true, license:"high", events:1, secAudit:true, notes:"GUSD issuer." },
  { name: "Bitstamp", type: "CeFi", category: "Exchange", region: "EU", kyc:true, por:"yes", audit:true, license:"high", events:0, secAudit:true, notes:"Oldest EU exchange." },
  { name: "OKX", type: "CeFi", category: "Exchange", region: "Global", kyc:true, por:"yes", audit:false, license:"med", events:0, secAudit:true, notes:"Regular PoR reports." },
  { name: "Binance", type: "CeFi", category: "Exchange", region: "Global", kyc:true, por:"partial", audit:false, license:"med", events:2, secAudit:true, notes:"SAFU fund." },
  { name: "Bybit", type: "CeFi", category: "Exchange", region: "Global", kyc:true, por:"yes", audit:false, license:"med", events:0, secAudit:true, notes:"PoR Merkle." },
  { name: "KuCoin", type: "CeFi", category: "Exchange", region: "Global", kyc:true, por:"partial", audit:false, license:"low", events:1, secAudit:true, notes:"Offshore." },
  { name: "Crypto.com", type: "CeFi", category: "Exchange", region: "Global", kyc:true, por:"yes", audit:true, license:"med", events:0, secAudit:true, notes:"SOC2 security." },
  { name: "Ledger", type: "CeFi", category: "Custody/Wallet", region: "Global", kyc:false, por:"n/a", audit:true, license:"n/a", events:0, secAudit:true, notes:"Non-custodial HW wallet." },
  // DeFi
  { name: "MakerDAO", type: "DeFi", category: "Issuer/Protocol", region: "On-chain", onchain:true, audits:["Trail of Bits","Quantstamp"], formal:true, algo:false, depeg:false, notes:"DAI issuer" },
  { name: "Aave", type: "DeFi", category: "Lending", region: "On-chain", onchain:true, audits:["Trail of Bits","Certora"], formal:true, algo:false, depeg:false, notes:"Blue-chip lending" },
  { name: "Compound", type: "DeFi", category: "Lending", region: "On-chain", onchain:true, audits:["OpenZeppelin"], formal:true, algo:false, depeg:false, notes:"Blue-chip lending" },
  { name: "Curve", type: "DeFi", category: "AMM", region: "On-chain", onchain:true, audits:["Trail of Bits"], formal:false, algo:false, depeg:false, notes:"Stable AMM" }
];

function scoreCeFi(p) {
  let s = 5;
  if (p.kyc) s += 1.5;
  if (p.por === "yes") s += 1; else if (p.por === "partial") s += 0.5;
  if (p.audit) s += 1;
  if (p.license === "high") s += 1; else if (p.license === "med") s += 0.5;
  s -= Math.min(2, (p.events || 0) * 0.8);
  if (p.secAudit) s += 0.3;
  return Math.max(1, Math.min(10, Math.round(s*10)/10));
}
function scoreDeFi(p) {
  let s = 6;
  if (p.onchain) s += 1;
  const audits = Array.isArray(p.audits) ? p.audits.length : 0;
  if (audits >= 1) s += 1;
  if (audits >= 2) s += 0.5;
  if (p.formal) s += 0.5;
  if (p.algo) s -= 1.5;
  if (p.depeg) s -= 1;
  return Math.max(1, Math.min(10, Math.round(s*10)/10));
}
function platformScore(p){ return p.type==="DeFi"?scoreDeFi(p):scoreCeFi(p); }

app.get("/api/platforms", async (req, res) => {
  try {
    const type = (req.query.type || "All").toString();
    const minScore = Number(req.query.minScore || "0");
    const region = (req.query.region || "").toString().toLowerCase();
    let list = PLATFORMS.map(p => ({ ...p, complianceScore: platformScore(p) }));
    if (type==="CeFi"||type==="DeFi") list = list.filter(p=>p.type===type);
    if (region) list = list.filter(p=> (p.region||"").toLowerCase().includes(region));
    if (minScore>0) list = list.filter(p => (p.complianceScore||0) >= minScore);
    list.sort((a,b)=>(b.complianceScore||0)-(a.complianceScore||0));
    res.json({ updatedAt: Date.now(), count: list.length, platforms: list });
  } catch {
    res.status(500).json({ error: "Platforms unavailable" });
  }
});

// Stablecoin compliance endpoint (with dynamic price + score)
app.get("/api/stablecoins", async (req, res) => {
  try {
    const prices = (await (await fetch(`${req.protocol}://${req.get("host")}/api/prices`)).json()).data || {};
    const q = (req.query.q || "").toString().toLowerCase();
    const model = (req.query.model || "all").toString();
    const genius = (req.query.genius || "all").toString(); // yes|no|likely|all
    const insured = (req.query.insured || "all").toString(); // yes|no|all
    const minScore = Number(req.query.minScore || "0");
    let list = SC.map(x => {
      const price = prices[x.symbol]?.price ?? null;
      const depeg = (price && Math.abs(1 - price) > 0.02) ? 1 : 0; // simple incident flag
      return {
        ...x,
        price,
        pegDev: price ? Math.round((price-1)*10000)/100 : null,
        complianceScore: scoreStablecoin(x, depeg)
      };
    });
    if (q) list = list.filter(s => (s.symbol+s.name+s.issuer).toLowerCase().includes(q));
    if (model !== "all") list = list.filter(s => (s.model||"").toLowerCase() === model.toLowerCase());
    if (genius !== "all") list = list.filter(s => (s.genius||"").toLowerCase() === genius.toLowerCase());
    if (insured !== "all") {
      if (insured === "yes") list = list.filter(s => (s.insurance||"").toLowerCase().includes("fdic"));
      if (insured === "no") list = list.filter(s => !(s.insurance||"").toLowerCase().includes("fdic"));
    }
    if (minScore>0) list = list.filter(s => (s.complianceScore||0) >= minScore);
    list.sort((a,b)=> (b.complianceScore||0)-(a.complianceScore||0));
    res.json({ updatedAt: Date.now(), count: list.length, stablecoins: list });
  } catch {
    res.status(500).json({ error: "Stablecoins unavailable" });
  }
});

// ---------- Alerts: config + events ----------
app.get("/api/alerts", async (_req, res) => {
  if (!pool) return res.json({ updatedAt: Date.now(), events: [] });
  const q = await pool.query("select id, type, entity_type, entity_key, severity, message, created_at from alert_events order by created_at desc limit 100");
  res.json({ updatedAt: Date.now(), events: q.rows });
});

app.get("/api/alerts/config", authRequired, async (req, res) => {
  if (!pool) return res.status(500).json({ error: "DB unavailable" });
  const q = await pool.query("select cfg from alerts_cfg where user_id=$1", [req.user.id]);
  res.json({ cfg: q.rowCount ? q.rows[0].cfg : {} });
});
app.post("/api/alerts/config", authRequired, async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: "DB unavailable" });
    const cfg = req.body?.cfg || {};
    await pool.query(`
      insert into alerts_cfg(user_id, cfg) values($1,$2)
      on conflict (user_id) do update set cfg=excluded.cfg, updated_at=now()
    `, [req.user.id, cfg]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to save config" });
  }
});

// ---------- News feeds ----------
const rss = new RSSParser();

app.get("/api/news", async (_req, res) => {
  try {
    const items = await withCache("news:fed+bis", 30*60_000, async () => {
      const feeds = ["https://www.federalreserve.gov/feeds/press_all.xml","https://data.bis.org/feed.xml"];
      const acc = [];
      for (const f of feeds) {
        try {
          const xml = await (await fetchWithRetry(f)).text();
          const parsed = await rss.parseString(xml);
          for (const it of (parsed.items||[])) acc.push({source: parsed.title||new URL(f).hostname, title: it.title, link: it.link, published: it.isoDate||it.pubDate||null});
        } catch {}
      }
      return acc.sort((a,b)=>new Date(b.published||0)-new Date(a.published||0)).slice(0,20);
    });
    statusTimes.news = Date.now();
    res.json({ updatedAt: Date.now(), items });
  } catch {
    res.status(502).json({ error: "News unavailable" });
  }
});
app.get("/api/news/regulatory", async (_req, res) => {
  try {
    const items = await withCache("news:reg", 20*60_000, async () => {
      const feeds = ["https://www.sec.gov/news/pressreleases.rss","https://www.cftc.gov/RSS/RSSGP/rssgp.xml","https://www.cftc.gov/RSS/RSSENF/rssenf.xml"];
      const acc = [];
      for (const f of feeds) {
        try {
          const xml = await (await fetchWithRetry(f)).text();
          const parsed = await rss.parseString(xml);
          for (const it of (parsed.items||[])) acc.push({source: parsed.title||new URL(f).hostname, title: it.title, link: it.link, published: it.isoDate||it.pubDate||null});
        } catch {}
      }
      return acc.sort((a,b)=>new Date(b.published||0)-new Date(a.published||0)).slice(0,25);
    });
    statusTimes.regulatory = Date.now();
    res.json({ updatedAt: Date.now(), items });
  } catch {
    res.status(502).json({ error: "Regulatory feeds unavailable" });
  }
});
app.get("/api/news/xrp", async (_req, res) => {
  try {
    const items = await withCache("news:xrp", 30*60_000, async () => {
      const feeds = ["https://ripple.com/press-releases/feed/","https://xrpl.org/blog/index.xml"];
      const acc = [];
      for (const f of feeds) {
        try {
          const xml = await (await fetchWithRetry(f)).text();
          const parsed = await rss.parseString(xml);
          for (const it of (parsed.items||[])) acc.push({source: parsed.title||new URL(f).hostname, title: it.title, link: it.link, published: it.isoDate||it.pubDate||null});
        } catch {}
      }
      return acc.sort((a,b)=>new Date(b.published||0)-new Date(a.published||0)).slice(0,20);
    });
    statusTimes.xrpnews = Date.now();
    res.json({ updatedAt: Date.now(), items });
  } catch {
    res.status(502).json({ error: "Ripple/XRPL feeds unavailable" });
  }
});

// ---------- ALERT ENGINE (basic) ----------
async function alert(event) {
  if (!pool) return;
  await pool.query(
    "insert into alert_events(type, entity_type, entity_key, severity, message) values($1,$2,$3,$4,$5)",
    [event.type, event.entity_type, event.entity_key, event.severity, event.message]
  );
}
// Depeg monitor (price deviation > 2%)
setInterval(async () => {
  try {
    const r = await fetch(`http://localhost:${PORT}/api/prices`).then(r=>r.json());
    const d = r?.data || {};
    for (const [sym, obj] of Object.entries(d)) {
      const px = obj?.price;
      if (typeof px === "number" && Math.abs(1 - px) >= 0.02) {
        await alert({ type:"depeg", entity_type:"coin", entity_key:sym, severity: (Math.abs(1-px)>=0.05?"critical":"warn"),
          message: `${sym} deviated ${((px-1)*100).toFixed(2)}% from $1 (${px.toFixed(4)})` });
      }
    }
  } catch {}
}, 60_000);

// Stale data monitor (if a key feed older than X)
setInterval(async () => {
  const tooOld = (t, ms)=> (Date.now() - t) > ms;
  if (tooOld(statusTimes.yields, 20*60_000)) {
    await alert({ type:"stale", entity_type:"system", entity_key:"yields", severity:"warn", message:"Yield feed stale >20m" });
  }
  if (tooOld(statusTimes.prices, 5*60_000)) {
    await alert({ type:"stale", entity_type:"system", entity_key:"prices", severity:"warn", message:"Price feed stale >5m" });
  }
}, 120_000);

// ---------- static UI ----------
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------- start ----------
initDb().then(() => {
  app.listen(PORT, () => console.log(`StableLens v2 listening on :${PORT}`));
});


