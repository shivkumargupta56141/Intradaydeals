// Returns every stored deal (across all dates) as a single JSON array.
// The frontend dashboard calls this on load to render all the tables.

import { getStore } from "@netlify/blobs";

export default async () => {
  const store = getStore("mc-deals");
  const { blobs } = await store.list({ prefix: "deals-" });

  let all = [];
  for (const { key } of blobs) {
    const rows = await store.get(key, { type: "json" });
    if (rows) all = all.concat(rows);
  }

  return new Response(JSON.stringify({ count: all.length, data: all }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
};
