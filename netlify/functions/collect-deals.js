// Scheduled function - runs automatically on the cron defined in netlify.toml.
// Fetches Moneycontrol's large deals API, dedupes, and stores results in
// Netlify Blobs (one JSON blob per calendar date: "deals-2026-08-16" etc).

import { getStore } from "@netlify/blobs";

const API_URL = "https://api.moneycontrol.com/mcapi/v1/deals/list";
const PAGE_SIZE = 24;
const MAX_PAGES = 10; // up to 240 deals per run

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Referer: "https://www.moneycontrol.com/markets/stock-deals/large-deals/",
  Accept: "application/json",
};

async function fetchPage(start) {
  const params = new URLSearchParams({
    start: String(start),
    limit: String(PAGE_SIZE),
    orderBy: "deal_date",
    sortBy: "DESC",
    dealType: "large",
    deviceType: "W",
    apiVersion: "177",
  });
  const res = await fetch(`${API_URL}?${params}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const json = await res.json();
  if (!json.success) throw new Error("API returned success=0");
  return json.data || [];
}

async function fetchAll() {
  let all = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const rows = await fetchPage(i * PAGE_SIZE);
    if (!rows.length) break;
    all = all.concat(rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

// Round to 2 decimals to avoid floating-point noise (e.g. 411.0299999999
// vs 411.03) making two genuinely identical deals look different.
function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

// Normalized identity for a deal. Uses deal_time (minute-level) plus
// quantity + rounded price + rounded value. Two deals only collide here
// if they share stock, minute, quantity, price AND value.
function dealKey(d) {
  return [
    d.scriptcode,
    d.deal_date,
    d.deal_time,
    d.quantity,
    round2(d.tradedPrice),
    round2(d.dealValue),
  ].join("|");
}

function dedupeList(list) {
  const seen = new Set();
  const out = [];
  for (const d of list) {
    const k = dealKey(d);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(d);
    }
  }
  return out;
}

export default async () => {
  const store = getStore("mc-deals");

  // --- Step 1: sweep EVERY stored date and purge existing duplicates ---
  // (not just dates present in today's fetch — otherwise older dates'
  // duplicates, created before this fix, would never get cleaned since
  // the API mostly returns recent dates each run.)
  const { blobs } = await store.list({ prefix: "deals-" });
  let totalCleaned = 0;
  for (const { key } of blobs) {
    const rawExisting = (await store.get(key, { type: "json" })) || [];
    const cleaned = dedupeList(rawExisting);
    if (cleaned.length !== rawExisting.length) {
      await store.setJSON(key, cleaned);
      totalCleaned += rawExisting.length - cleaned.length;
    }
  }

  // --- Step 2: fetch fresh data and add genuinely new deals ---
  const fresh = await fetchAll();
  const uniqueFresh = dedupeList(fresh); // dedupe within this batch itself

  const byDate = {};
  for (const d of uniqueFresh) {
    (byDate[d.deal_date] ||= []).push(d);
  }

  let totalNew = 0;

  for (const [date, deals] of Object.entries(byDate)) {
    const blobKey = `deals-${date}`;
    const existing = (await store.get(blobKey, { type: "json" })) || [];
    const existingKeys = new Set(existing.map(dealKey));

    const newOnes = deals
      .filter((d) => !existingKeys.has(dealKey(d)))
      .map((d) => ({ ...d, collected_at: new Date().toISOString() }));

    if (newOnes.length > 0) {
      const merged = existing.concat(newOnes);
      await store.setJSON(blobKey, merged);
      totalNew += newOnes.length;
    }
  }

  return new Response(
    JSON.stringify({ ok: true, totalNew, totalCleaned, ranAt: new Date().toISOString() }),
    { headers: { "Content-Type": "application/json" } }
  );
};
