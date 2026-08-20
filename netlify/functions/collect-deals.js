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

function dealKey(d) {
  return [d.scriptcode, d.deal_time, d.deal_date, d.quantity, d.dealValue].join("|");
}

export default async () => {
  const store = getStore("mc-deals");
  const fresh = await fetchAll();

  // group fresh deals by their deal_date
  const byDate = {};
  for (const d of fresh) {
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
    JSON.stringify({ ok: true, totalNew, ranAt: new Date().toISOString() }),
    { headers: { "Content-Type": "application/json" } }
  );
};
