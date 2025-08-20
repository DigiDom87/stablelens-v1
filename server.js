// StableLens v1.4 — Macro + Payments + optional plugins (guarded by envs)
// Node >= 18 (ESM)

import express from "express";
import cors from "cors";
import compression from "compression";
import helmet from "helmet";
import RSSParser from "rss-parser";
import { fileURLToPath } from "url";
import path from "path";

// ----- Optional plugins -----
import * as Sentry from "@sentry/node";
import pgPkg from "pg";
import IORedis from "ioredis";
import { Resend } from "resend";

// ----- App / paths -----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 8080;

// ----- Sentry (optional) -----
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV || "production"
  });
  app.use(Sentry.Handlers.requestHandler());
}

// ----- Security / middlewares -----
const allow = process.env.CORS_ORIGIN?.split(",").map(s => s.trim());
app.use(cors(allow ? { origin: allow } : {}));
app.use(express.json());
app.use(compression());
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));

// ----- Optional: Postgres -----
const { Pool } = pgPkg;
const pgUrl = process.env.DATABASE_URL;
let db = null;
if (pgUrl) {
  db = new Pool({
    connectionString: pgUrl,
    ssl: pgUrl.includes("railway") ? { rejectUnauthorized: false } : false
  });
  (async () => {
    await db.query(`
      create table if not exists sl_users (
        id serial primary key,
        email text unique,
        created_at timestamptz default now()
      );
      create table if not exists sl_watchlists (
        id serial primary key,
        user_email text not null,
        item_type text not null, -- 'coin' | 'platform' | 'corridor'
        item_id text not null,
        created_at timestamptz default now()
      );
      create table if not exists sl_alerts_sent (
        id serial primary key,
        kind text not null,
        payload jsonb not null,
        created_at timestamptz default now()
      );
      create table if not exists sl_scenarios (
        id serial primary key,
        user_email text not null,
        corridor_id text not null,
        params jsonb not null,
        created_at timestamptz default now()
      );
    `);
    console.log("DB ready");
  })().catch(err => console.error("DB init error:", err));
}

// ----- Optional: Redis -----
const redisUrl = process.env.REDIS_URL;
let redis = null;
if (redisUrl) {
  redis = new IORedis(redisUrl, { lazyConnect: true });
  redis.connect().catch(err => console.error("Redis connect error:", err));
}
async function cacheGet(key) {
  if (!redis) return null;
  try { const v = await redis.get(key); return v ? JSON.parse(v) : null; }
  catch { return null; }
}
async function cacheSet(key, val, ttlSec = 300) {
  if (!redis) return;
  try { await redis.set(key, JSON.stringify(val), "EX", ttlSec); }
  catch {}
}

// ----- Optional: Resend (email) -----
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// ----- Optional: Slack webhook -----
async function slackNotify(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  } catch {}
}

// ----- Optional: Clerk auth guard -----
async function requireAuth(req, res, next) {
  if (!process.env.CLERK_SECRET_KEY) return res.status(501).json({ error: "auth_not_configured" });
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "no_token" });
  try {
    const r = await fetch("https://api.clerk.com/v1/introspect", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.CLERK_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token })
    });
    const data = await r.json();
    if (!data.active) return res.status(401).json({ error: "invalid_session" });
    req.user = { sub: data.sub, email: data.email || data.claims?.email };
    next();
  } catch (e) { res.status(401).json({ error: "auth_error", detail: String(e) }); }
}

// ----- In-memory cache fallback -----
const memory = {
  stablecoins: { data: null, t: 0 },
  yields:      { data: null, t: 0 },
  platforms:   { data: null, t: 0 },
  news:        { data: null, t: 0 },
  alerts:      { data: null, t: 0 }
};
const TTL = {
  stablecoins: 5 * 60 * 1000,
  yields:      5 * 60 * 1000,
  platforms:   12 * 60 * 60 * 1000,
  news:        10 * 60 * 1000,
  alerts:      60 * 1000
};
const parser = new RSSParser();

// ----- Seed registries (coins / platforms) -----
const SEEDED_STABLES = [
  { symbol:"USDC", name:"USD Coin", issuer:"Circle", jurisdiction:"US (MSB) / EU EMI", auditor:"Grant Thornton", model:"fiat-backed", genius:"yes",    chains:["Ethereum","Base","Solana","Arbitrum","Polygon"] },
  { symbol:"USDT", name:"Tether",   issuer:"Tether", jurisdiction:"Offshore",          auditor:"BDO",            model:"fiat-backed", genius:"likely", chains:["Ethereum","Tron","Arbitrum","BSC","Polygon"] },
  { symbol:"DAI",  name:"DAI",      issuer:"MakerDAO", jurisdiction:"Decentralized",   auditor:"Withum",         model:"crypto-collateralized", genius:"yes", chains:["Ethereum","Layer2"] },
  { symbol:"sDAI", name:"Savings DAI", issuer:"MakerDAO", jurisdiction:"Decentralized", auditor:"Withum",        model:"yield-bearing (DAI -> sDAI)", genius:"yes", chains:["Ethereum"] },
  { symbol:"FRAX", name:"Frax",     issuer:"Frax",    jurisdiction:"US (MSB)",          auditor:"Withum",         model:"hybrid",                genius:"likely", chains:["Ethereum","Fraxtal","Arbitrum"] },
  { symbol:"PYUSD",name:"PayPal USD",issuer:"PayPal (via Paxos)", jurisdiction:"NYDFS", auditor:"Withum",         model:"fiat-backed",           genius:"yes",    chains:["Ethereum","Solana"] },
  { symbol:"GHO",  name:"GHO",      issuer:"Aave",    jurisdiction:"Decentralized",     auditor:"Various",        model:"crypto-collateralized", genius:"likely", chains:["Ethereum"] },
  { symbol:"RLUSD",name:"Ripple USD (announced)", issuer:"Ripple", jurisdiction:"US",   auditor:"TBD",            model:"fiat-backed",           genius:"likely", status:"announced", chains:["XRPL","Ethereum"] }
];
const SEEDED_PLATFORMS = {
  cefi: [
    { name:"Coinbase", jurisdiction:"US (NYDFS/FinCEN MSB)", licenses:["NY BitLicense","MSB"], auditor:"Deloitte", por:"Yes (independent attestations)", insured:false, riskNotes:"High regulatory transparency in US", scoreBase:8.8 },
    { name:"Kraken",   jurisdiction:"US/EU (various)", licenses:["MSB","EU VASP"], auditor:"Independent attestations", por:"Yes", insured:false, riskNotes:"Strong compliance posture", scoreBase:8.3 },
    { name:"Gemini",   jurisdiction:"US (NYDFS)",      licenses:["NY BitLicense","Trust company"], auditor:"Withum (historically)", por:"Yes (historically)", insured:false, riskNotes:"US-regulated trust company", scoreBase:8.1 },
    { name:"Bitstamp", jurisdiction:"EU/Global",       licenses:["EU VASP"], auditor:"Independent", por:"Yes/Partial", insured:false, riskNotes:"Long operating history", scoreBase:7.6 },
    { name:"Binance",  jurisdiction:"Global",          licenses:["Local registrations vary"], auditor:"PoR style", por:"Partial", insured:false, riskNotes:"Regulatory actions/settlements noted", scoreBase:6.3 },
    { name:"OKX",      jurisdiction:"Global",          licenses:["Local registrations vary"], auditor:"PoR style", por:"Partial", insured:false, riskNotes:"Offshore entity", scoreBase:6.8 }
  ],
  defi: [
    { name:"Aave",      chain:"Ethereum/Multichain", audits:["Trail of Bits","OpenZeppelin","Certora"], por:"N/A", insured:false, riskNotes:"Governance & oracle risks", scoreBase:7.5 },
    { name:"Compound",  chain:"Ethereum",            audits:["OpenZeppelin","Trail of Bits"], por:"N/A", insured:false, riskNotes:"Governance & oracle risks", scoreBase:7.2 },
    { name:"Curve",     chain:"Ethereum/Multichain", audits:["Trail of Bits","MixBytes"],     por:"N/A", insured:false, riskNotes:"AMM-specific risks; past incidents", scoreBase:6.8 },
    { name:"MakerDAO",  chain:"Ethereum",            audits:["Runtime Verification","Trail of Bits"], por:"On-chain transparency", insured:false, riskNotes:"Protocol & collateral risks", scoreBase:7.9 },
    { name:"Frax",      chain:"Ethereum/Fraxtal",    audits:["Trail of Bits","Certora"],      por:"On-chain transparency", insured:false, riskNotes:"Protocol risks", scoreBase:7.4 }
  ]
};

// ----- Payments seed (corridors, ramps) -----
const SEEDED_CORRIDORS = [
  {
    id: "US-MX", from: "USD", to: "MXN",
    legacySettleDays: 2, prefundDays: 2, onchainHours: 0.5,
    avgDailyVolUsd: 5_000_000, wacc: 0.10,
    ramps: [
      { country: "US", provider: "Coinbase", rails: ["ACH","Wire"], direction: "in/out" },
      { country: "MX", provider: "Bitso",    rails: ["SPEI"],       direction: "in/out" }
    ],
    notes: "Popular remittance & B2B corridor"
  },
  {
    id: "US-BR", from: "USD", to: "BRL",
    legacySettleDays: 2, prefundDays: 3, onchainHours: 0.5,
    avgDailyVolUsd: 3_000_000, wacc: 0.10,
    ramps: [
      { country: "US", provider: "Coinbase", rails: ["ACH","Wire"], direction: "in/out" },
      { country: "BR", provider: "BTG Pactual", rails: ["PIX"],     direction: "in/out" }
    ],
    notes: "Growing on/off ramp via PIX"
  },
  {
    id: "EU-NG", from: "EUR", to: "NGN",
    legacySettleDays: 3, prefundDays: 4, onchainHours: 1,
    avgDailyVolUsd: 2_000_000, wacc: 0.12,
    ramps: [
      { country: "EU", provider: "SEPA PSP", rails: ["SEPA"], direction: "in/out" },
      { country: "NG", provider: "Local PSP", rails: ["Local"], direction: "out" }
    ],
    notes: "Challenging last-mile; PSP coverage varies"
  },
  {
    id: "US-PH", from: "USD", to: "PHP",
    legacySettleDays: 2, prefundDays: 3, onchainHours: 0.5,
    avgDailyVolUsd: 1_000_000, wacc: 0.12,
    ramps: [
      { country: "US", provider: "Coinbase", rails: ["ACH","Wire"], direction: "in/out" },
      { country: "PH", provider: "GCash/Coins.ph", rails: ["Instapay"], direction: "in/out" }
    ],
    notes: "High remittance corridor"
  }
];

// ===== Scoring =====
const clamp10 = n => Math.max(1, Math.min(10, Math.round(n*10)/10));
const jurisdictionToKey = s => (s||"").toUpperCase();
function scoreStablecoin(sc, depegIncidents = 0) {
  let s = 5;
  const juris = sc.jurisdiction || "";
  const auditor = (sc.auditor || "").toLowerCase();
  const genius = (sc.genius || "").toLowerCase();
  if (/(NYDFS|US\s*\(MSB)/i.test(juris)) s += 2;
  if (auditor.includes("grant thornton")) s += 1;
  if (auditor.includes("withum")) s += 0.8;
  if (auditor.includes("bdo")) s += 0.3;
  if (sc.model === "crypto-collateralized") s -= 0.8;
  if (/OFFSHORE|DECENTRALIZED/i.test(jurisdictionToKey(juris))) s -= 0.7;
  if (genius === "yes" || genius === "likely") s += 1.5;
  s -= Math.min(2, depegIncidents * 0.7);
  return clamp10(s);
}
function scoreBreakdown(sc, depegIncidents = 0) {
  const parts = {
    base: 5,
    jurisdiction: /(NYDFS|US\s*\(MSB)/i.test(sc.jurisdiction || "") ? 2 : 0,
    auditor:
      (sc.auditor || "").toLowerCase().includes("grant thornton") ? 1 :
      (sc.auditor || "").toLowerCase().includes("withum") ? 0.8 :
      (sc.auditor || "").toLowerCase().includes("bdo") ? 0.3 : 0,
    model: (sc.model || "") === "crypto-collateralized" ? -0.8 : 0,
    offshore: /OFFSHORE|DECENTRALIZED/i.test(jurisdictionToKey(sc.jurisdiction || "")) ? -0.7 : 0,
    genius: (sc.genius || "").toLowerCase().match(/yes|likely/) ? 1.5 : 0,
    depeg: -Math.min(2, depegIncidents * 0.7)
  };
  return { parts, total: clamp10(Object.values(parts).reduce((a,b)=>a+b,0)) };
}
function scorePlatform(p) {
  let s = p.scoreBase || 6.5;
  if ((p.licenses || []).some(x => /NYDFS|TRUST|MSB|VASP/i.test(x))) s += 0.6;
  if ((p.auditor || "").toLowerCase().includes("deloitte")) s += 0.3;
  if ((p.por || "").toLowerCase().includes("partial")) s -= 0.3;
  if ((p.riskNotes || "").toLowerCase().includes("regulatory action")) s -= 0.8;
  return clamp10(s);
}
function platformBreakdown(p) {
  const parts = {
    base: p.scoreBase || 6.5,
    licenses: (p.licenses || []).some(x => /NYDFS|TRUST|MSB|VASP/i.test(x)) ? 0.6 : 0,
    auditor: (p.auditor || "").toLowerCase().includes("deloitte") ? 0.3 : 0,
    por: (p.por || "").toLowerCase().includes("yes") ? 0.4 : ((p.por || "").toLowerCase().includes("partial") ? -0.2 : 0),
    risk: (p.riskNotes || "").toLowerCase().includes("regulatory action") ? -0.8 : 0
  };
  return { parts, total: clamp10(Object.values(parts).reduce((a,b)=>a+b,0)) };
}

// ===== Helpers (HTTP pulls) =====
async function safeJSON(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch { return null; }
  finally { clearTimeout(timer); }
}
async function fetchFREDCSV(seriesId, observationCount = 240) {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`FRED ${seriesId} ${r.status}`);
  const text = await r.text();
  const rows = text.trim().split(/\r?\n/).slice(1).map(line => {
    const [d, v] = line.split(",");
    const val = v === "." ? null : Number(v);
    return { t: d, v: isFinite(val) ? val : null };
  }).filter(x => x.v != null);
  return rows.slice(-observationCount);
}
async function fetchCoingeckoGlobal() {
  const r = await fetch("https://api.coingecko.com/api/v3/global");
  if (!r.ok) throw new Error("CG global");
  return await r.json();
}
async function fetchCoingeckoCategories() {
  const r = await fetch("https://api.coingecko.com/api/v3/coins/categories");
  if (!r.ok) throw new Error("CG categories");
  return await r.json();
}
async function fetchSOFRLast30() {
  const url = "https://markets.newyorkfed.org/api/rates/secured/sofr/last/30.json";
  const r = await fetch(url);
  if (!r.ok) throw new Error("SOFR api");
  const json = await r.json();
  return (json?.refRates ?? []).map(x => ({ t: x.effectiveDate, v: Number(x.percentRate) })).filter(x => !isNaN(x.v));
}

// ===== Builders =====
function buildStablecoinList() {
  return SEEDED_STABLES.map(sc => ({ ...sc, score: scoreStablecoin(sc, 0), price: null, supply: null }));
}
function buildPlatforms() {
  return {
    cefi: SEEDED_PLATFORMS.cefi.map(p => ({ ...p, score: scorePlatform(p) })),
    defi: SEEDED_PLATFORMS.defi.map(p => ({ ...p, score: scorePlatform(p) }))
  };
}
function buildAlerts({ stablecoins=[], news=[] }) {
  const alerts=[];
  stablecoins.forEach(s=>{
    if (typeof s.price === "number"){
      const diff = Math.abs(1-s.price);
      if (diff >= 0.015) alerts.push({ type:"depeg", severity: diff>=0.05?"high":"medium", symbol:s.symbol, message:`${s.symbol} deviated ${Math.round(diff*100)}% from $1` });
    }
  });
  news.forEach(n=>{
    const t=(n.title||"").toLowerCase();
    if (/enforcement|settlement|charge|lawsuit|penalty|consent order/.test(t) && /(sec|cftc|doj|attorney general)/.test(t)) {
      alerts.push({ type:"regulatory", severity:"info", source:n.source, message:n.title, link:n.link });
    }
  });
  return alerts.slice(0,50);
}
function buildMetrics(stables, platforms, yields){
  const dist = { ">=8":0, "7-8":0, "6-7":0, "<6":0 };
  stables.forEach(s=>{
    const sc=s.score||0;
    if (sc>=8) dist[">=8"]++; else if (sc>=7) dist["7-8"]++; else if (sc>=6) dist["6-7"]++; else dist["<6"]++;
  });
  const chains={}; stables.forEach(s => (s.chains||[]).forEach(c => chains[c]=(chains[c]||0)+1));
  const topStable=[...stables].sort((a,b)=>(b.score||0)-(a.score||0)).slice(0,5);
  return { dist, chains, topStable, totalStables: stables.length,
           cefiCount: (platforms.cefi||[]).length, defiCount: (platforms.defi||[]).length };
}

// ===== Payments Calculations =====
function corridorBaseCalc(c) {
  const timeSavedDays = Math.max(0, (c.prefundDays || 0) - (c.onchainHours || 0)/24);
  const rampCount = (c.ramps || []).length;
  return { timeSavedDays, rampCount };
}
// Scenario: V = avg daily volume, W = WACC (annual, e.g., 0.10)
function corridorScenario(c, volumeUsd, wacc) {
  const onchainDays = (c.onchainHours || 0)/24;
  const D_before = c.prefundDays || 0;
  const D_after  = onchainDays;
  const freedFloatUsd = Math.max(0, (D_before - D_after)) * (volumeUsd || 0);
  const annualCostSavingsUsd = freedFloatUsd * (wacc || 0); // annualized opportunity cost
  return { freedFloatUsd, annualCostSavingsUsd };
}

// ===== Macro Endpoints =====
app.get("/api/health", (_req,res)=> res.json({ status:"ok", ts: Date.now() }));
app.get("/api/status", (_req,res)=> res.json({
  health:"ok",
  updatedAt:{
    stablecoins: memory.stablecoins.t||null,
    yields:      memory.yields.t||null,
    platforms:   memory.platforms.t||null,
    news:        memory.news.t||null,
    alerts:      memory.alerts.t||null
  }
}));
app.get("/api/db-health", async (_req,res)=>{
  if (!db) return res.json({ ok:false, reason:"DATABASE_URL missing" });
  try { const r = await db.query("select 1 ok"); res.json({ ok: r.rows[0].ok===1 }); }
  catch(e){ res.json({ ok:false, error:String(e) }); }
});
app.get("/api/redis-health", async (_req,res)=>{
  if (!redis) return res.json({ ok:false, reason:"REDIS_URL missing" });
  try { const pong = await redis.ping(); res.json({ ok: pong==="PONG" }); }
  catch(e){ res.json({ ok:false, error:String(e) }); }
});

// M2
app.get("/api/macro/m2", async (_req,res)=>{
  try {
    const series = await fetchFREDCSV("M2SL", 240);
    let yoy = null;
    if (series.length > 12) {
      const last = series[series.length - 1].v;
      const prev = series[series.length - 13].v;
      yoy = ((last - prev) / prev) * 100;
    }
    res.json({ updatedAt: Date.now(), series, yoy });
  } catch { res.status(502).json({ error:"M2 unavailable" }); }
});
// Treasuries
app.get("/api/macro/treasury", async (_req,res)=>{
  try {
    const dgs2  = await fetchFREDCSV("DGS2", 90);
    const dgs10 = await fetchFREDCSV("DGS10", 90);
    const latest2  = dgs2.filter(x=>x.v!=null).slice(-1)[0]?.v ?? null;
    const latest10 = dgs10.filter(x=>x.v!=null).slice(-1)[0]?.v ?? null;
    const curve = { "2Y": latest2, "10Y": latest10, "2s10s": (latest10!=null && latest2!=null) ? (latest10 - latest2) : null };
    res.json({ updatedAt: Date.now(), dgs2, dgs10, curve });
  } catch { res.status(502).json({ error:"Treasury data unavailable" }); }
});
// Dominance
app.get("/api/macro/stablecoin-dominance", async (_req,res)=>{
  try {
    const global = await fetchCoingeckoGlobal();
    const totalMcap = global?.data?.total_market_cap?.usd ?? null;
    const cats = await fetchCoingeckoCategories();
    let stableCap = 0;
    for (const c of (cats||[])) {
      const name = (c?.name||"").toLowerCase();
      if (name === "stablecoins" || name.includes("stablecoin")) stableCap += (c?.market_cap ?? 0);
    }
    const dominance = (totalMcap && stableCap) ? (stableCap / totalMcap) * 100 : null;
    res.json({ updatedAt: Date.now(), totalMcap, stableCap, dominance });
  } catch { res.status(502).json({ error:"Dominance unavailable" }); }
});
// SOFR
app.get("/api/macro/sofr", async (_req,res)=>{
  try {
    const series = await fetchSOFRLast30();
    const latest = series.slice(-1)[0]?.v ?? null;
    res.json({ updatedAt: Date.now(), series, latest });
  } catch { res.status(502).json({ error:"SOFR unavailable" }); }
});

// ===== Core (coins/platforms/yields/news/alerts/metrics) =====
app.get("/api/stablecoins", async (_req,res)=>{
  try{
    if (!memory.stablecoins.data || Date.now()-memory.stablecoins.t>TTL.stablecoins)
      memory.stablecoins = { data: buildStablecoinList(), t: Date.now() };
    res.json({ stablecoins: memory.stablecoins.data });
  }catch{ res.json({ stablecoins: buildStablecoinList() }); }
});
app.get("/api/stablecoins/:symbol", async (req,res)=>{
  const sym=(req.params.symbol||"").toUpperCase();
  try{
    if (!memory.stablecoins.data) memory.stablecoins={ data: buildStablecoinList(), t: Date.now() };
    const found = memory.stablecoins.data.find(s => (s.symbol||"").toUpperCase()===sym);
    if (!found) return res.status(404).json({ error:"not_found" });

    if (!memory.yields.data || Date.now()-memory.yields.t>TTL.yields)
      memory.yields = { data: await fetchYieldsFromLlama(), t: Date.now() };
    const pools=(memory.yields.data||[])
      .filter(p => (p.symbol||"").toUpperCase()===sym)
      .sort((a,b)=>(b.apy||0)-(a.apy||0)).slice(0,12)
      .map(p=>({ project:p.project, chain:p.chain, symbol:p.symbol, apy:p.apy, apyBase:p.apyBase, apyReward:p.apyReward, tvlUsd:p.tvlUsd, pool:p.pool }));

    res.json({ stablecoin: found, breakdown: scoreBreakdown(found, 0), topPools: pools });
  }catch{ res.status(500).json({ error:"server_error" }); }
});
app.get("/api/platforms", async (_req,res)=>{
  try{
    if (!memory.platforms.data || Date.now()-memory.platforms.t>TTL.platforms)
      memory.platforms = { data: buildPlatforms(), t: Date.now() };
    res.json(memory.platforms.data);
  }catch{ res.json(buildPlatforms()); }
});
app.get("/api/platforms/:name", async (req,res)=>{
  const name=decodeURIComponent(req.params.name||"");
  try{
    if (!memory.platforms.data) memory.platforms={ data: buildPlatforms(), t: Date.now() };
    const all=memory.platforms.data;
    const item=(all.cefi||[]).find(p=>p.name.toLowerCase()===name.toLowerCase()) ||
               (all.defi||[]).find(p=>p.name.toLowerCase()===name.toLowerCase());
    if (!item) return res.status(404).json({ error:"not_found" });
    res.json({ platform: item, breakdown: platformBreakdown(item) });
  }catch{ res.status(500).json({ error:"server_error" }); }
});
app.get("/api/yields", async (req,res)=>{
  const symbol=(req.query.symbol||"").toUpperCase();
  const chain=req.query.chain||"";
  const sort=(req.query.sort||"apy").toLowerCase();
  const order=(req.query.order||"desc").toLowerCase();
  const minScore=parseFloat(req.query.minScore||"0");

  try{
    if (!memory.yields.data || Date.now()-memory.yields.t>TTL.yields)
      memory.yields={ data: await fetchYieldsFromLlama(), t: Date.now() };
    if (!memory.stablecoins.data) memory.stablecoins={ data: buildStablecoinList(), t: Date.now() };
    const scoreMap=new Map(memory.stablecoins.data.map(s=>[s.symbol.toUpperCase(), s.score||0]));

    let rows=memory.yields.data||[];
    if (symbol) rows=rows.filter(p=>(p.symbol||"").toUpperCase()===symbol);
    if (chain) rows=rows.filter(p=>(p.chain||"").toLowerCase()===chain.toLowerCase());
    if (minScore>0) rows=rows.filter(p => (scoreMap.get((p.symbol||"").toUpperCase())||0)>=minScore);
    rows=rows.map(p=>({ project:p.project, chain:p.chain, symbol:p.symbol, apy:p.apy, apyBase:p.apyBase, apyReward:p.apyReward, tvlUsd:p.tvlUsd, pool:p.pool }));

    const key=sort==="tvl"?"tvlUsd":"apy";
    rows.sort((a,b)=> order==="asc" ? ((a[key]||0)-(b[key]||0)) : ((b[key]||0)-(a[key]||0)));

    res.json({ pools: rows.slice(0,200) });
  }catch{ res.json({ pools:[] }); }
});
app.get("/api/best", async (req,res)=>{
  const minScore=parseFloat(req.query.minScore||"0");
  const chain=req.query.chain||"";
  const top=Math.min(200, parseInt(req.query.top||"20",10));
  try{
    if (!memory.yields.data || Date.now()-memory.yields.t>TTL.yields)
      memory.yields={ data: await fetchYieldsFromLlama(), t: Date.now() };
    if (!memory.stablecoins.data) memory.stablecoins={ data: buildStablecoinList(), t: Date.now() };
    const scoreMap=new Map(memory.stablecoins.data.map(s=>[s.symbol.toUpperCase(), s.score||0]));

    let rows=memory.yields.data||[];
    if (chain) rows=rows.filter(p=>(p.chain||"").toLowerCase()===chain.toLowerCase());
    if (minScore>0) rows=rows.filter(p => (scoreMap.get((p.symbol||"").toUpperCase())||0)>=minScore);

    rows=rows.filter(p=>p.symbol && typeof p.apy==="number")
      .sort((a,b)=>(b.apy||0)-(a.apy||0)).slice(0,top)
      .map(p=>({ project:p.project, chain:p.chain, symbol:p.symbol, apy:p.apy, tvlUsd:p.tvlUsd, pool:p.pool, complianceScore: scoreMap.get((p.symbol||"").toUpperCase())||0 }));

    res.json({ results: rows });
  }catch{ res.json({ results: [] }); }
});
app.get("/api/news", async (_req,res)=>{
  try{
    const key="news:feeds";
    let items = await cacheGet(key);
    if (!items) { items = await fetchNewsFeeds(); await cacheSet(key, items, 600); }
    memory.news={ data: items, t: Date.now() };
    res.json({ items });
  }catch{ res.json({ items: [] }); }
});
app.get("/api/alerts", async (_req,res)=>{
  try{
    if (!memory.stablecoins.data) memory.stablecoins={ data: buildStablecoinList(), t: Date.now() };
    let items = await cacheGet("news:feeds");
    if (!items) { items = await fetchNewsFeeds(); await cacheSet("news:feeds", items, 600); }
    memory.news={ data: items, t: Date.now() };
    const data=buildAlerts({ stablecoins: memory.stablecoins.data, news: memory.news.data });
    data.filter(a => a.severity==="high").slice(0,1).forEach(a => slackNotify(`⚠️ ${a.type.toUpperCase()}: ${a.message}`));
    memory.alerts={ data, t: Date.now() };
    res.json({ alerts: data });
  }catch{ res.json({ alerts: [] }); }
});
app.get("/api/metrics", async (_req,res)=>{
  try{
    if (!memory.stablecoins.data) memory.stablecoins={ data: buildStablecoinList(), t: Date.now() };
    if (!memory.platforms.data)  memory.platforms={ data: buildPlatforms(), t: Date.now() };
    if (!memory.yields.data || Date.now()-memory.yields.t>TTL.yields) memory.yields={ data: await fetchYieldsFromLlama(), t: Date.now() };
    res.json(buildMetrics(memory.stablecoins.data, memory.platforms.data, memory.yields.data));
  }catch{
    const st=buildStablecoinList(); const pl=buildPlatforms();
    res.json(buildMetrics(st,pl,[]));
  }
});

// ===== Payments Endpoints =====
app.get("/api/payments/corridors", async (_req,res)=>{
  try {
    const rows = SEEDED_CORRIDORS.map(c => {
      const base = corridorBaseCalc(c);
      return {
        id: c.id, from: c.from, to: c.to,
        legacySettleDays: c.legacySettleDays, prefundDays: c.prefundDays, onchainHours: c.onchainHours,
        timeSavedDays: base.timeSavedDays, rampCount: base.rampCount, notes: c.notes
      };
    });
    res.json({ corridors: rows });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});
app.get("/api/payments/corridors/:id", async (req,res)=>{
  const id = req.params.id;
  try {
    const c = SEEDED_CORRIDORS.find(x => x.id.toLowerCase() === id.toLowerCase());
    if (!c) return res.status(404).json({ error: "not_found" });
    const base = corridorBaseCalc(c);

    const volumeUsd = Number(req.query.volumeUsd || c.avgDailyVolUsd || 0);
    const wacc = Number(req.query.wacc || c.wacc || 0.1);
    const scen = corridorScenario(c, volumeUsd, wacc);

    res.json({
      corridor: {
        id: c.id, from: c.from, to: c.to,
        legacySettleDays: c.legacySettleDays, prefundDays: c.prefundDays, onchainHours: c.onchainHours,
        avgDailyVolUsd: c.avgDailyVolUsd, wacc: c.wacc, ramps: c.ramps || [], notes: c.notes
      },
      base, scenario: { volumeUsd, wacc, ...scen }
    });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

// Issuer carry estimator: supplyUsd & investablePct optional (defaults: 0, 0.8)
// Uses max(SOFR_latest, DGS3MO_latest) as carry rate proxy
app.get("/api/issuer-carry/:symbol", async (req,res)=>{
  try {
    const supplyUsd = Number(req.query.supplyUsd || 0);
    const investablePct = Math.max(0, Math.min(1, Number(req.query.investablePct || 0.8)));
    const sofrSeries = await fetchSOFRLast30();
    const sofr = sofrSeries.slice(-1)[0]?.v ?? null;
    const dgs3m = (await fetchFREDCSV("DGS3MO", 30)).slice(-1)[0]?.v ?? null;
    const estRatePct = (sofr!=null && dgs3m!=null) ? Math.max(sofr, dgs3m) : (sofr ?? dgs3m ?? null);
    const investableUsd = supplyUsd * investablePct;
    const estIncomeUsd = (estRatePct!=null) ? investableUsd * (estRatePct/100) : null;
    res.json({ updatedAt: Date.now(), symbol: req.params.symbol.toUpperCase(), inputs: { supplyUsd, investablePct }, estRatePct, investableUsd, estIncomeUsd });
  } catch {
    res.status(500).json({ error: "server_error" });
  }
});

// ----- Email alerts (optional) -----
app.post("/api/send-alerts-email", async (req, res) => {
  if (!resend) return res.status(501).json({ error:"email_not_configured" });
  const { to, subject = "StableLens Alerts", html } = req.body || {};
  if (!to || !html) return res.status(400).json({ error:"bad_request" });
  try {
    await resend.emails.send({ from: process.env.ALERTS_FROM || "alerts@stablelens.net", to, subject, html });
    if (db) await db.query("insert into sl_alerts_sent (kind, payload) values ($1,$2)", ["email", { to, subject }]);
    res.json({ ok:true });
  } catch (e) { res.status(500).json({ ok:false, error:String(e) }); }
});

// ----- Watchlist (optional) -----
app.post("/api/watchlist", requireAuth, async (req, res) => {
  if (!db) return res.status(501).json({ error: "db_not_configured" });
  const { item_type, item_id } = req.body || {};
  if (!item_type || !item_id) return res.status(400).json({ error: "bad_request" });
  await db.query(
    "insert into sl_watchlists (user_email, item_type, item_id) values ($1,$2,$3) on conflict do nothing",
    [req.user?.email || "user@unknown", item_type, item_id]
  );
  res.json({ ok:true });
});

// ----- Cron task (optional) -----
app.get("/api/tasks/prewarm", async (_req,res) => {
  try {
    memory.stablecoins = { data: buildStablecoinList(), t: Date.now() };
    const [y, n] = await Promise.all([ fetchYieldsFromLlama(), fetchNewsFeeds() ]);
    memory.yields = { data: y, t: Date.now() };
    memory.news   = { data: n, t: Date.now() };
    res.json({ ok:true, refreshedAt: Date.now(), sizes:{ yields: (y||[]).length, news: (n||[]).length }});
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e) });
  }
});

// ----- Static UI -----
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (_req,res)=> res.sendFile(path.join(__dirname, "public", "index.html")));

// ----- Sentry error handler (optional) -----
if (process.env.SENTRY_DSN) {
  app.use(Sentry.Handlers.errorHandler());
}

// ----- Warm & Start -----
(async function prewarm(){
  try {
    memory.stablecoins = { data: buildStablecoinList(), t: Date.now() };
    memory.platforms   = { data: buildPlatforms(), t: Date.now() };
    const [y, n] = await Promise.all([fetchYieldsFromLlama(), fetchNewsFeeds()]);
    memory.yields = { data: y, t: Date.now() };
    memory.news   = { data: n, t: Date.now() };
  } catch {}
})();
app.listen(PORT, ()=> console.log(`StableLens v1 listening on :${PORT}`));


