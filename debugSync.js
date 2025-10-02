// debugSync.js
import fetch from "node-fetch";
import fs from "fs";

const PRINTFUL_TOKEN = process.env.PRINTFUL_TOKEN; // from .env

async function fetchSyncProducts() {
  const url = "https://api.printful.com/store/sync/products";
  let offset = 0;
  const limit = 20; // small chunks for debugging
  let syncMap = {};

  while (true) {
    const res = await fetch(`${url}?offset=${offset}&limit=${limit}`, {
      headers: {
        Authorization: `Bearer ${PRINTFUL_TOKEN}`,
      },
    });

    if (!res.ok) {
      console.error("❌ Printful error:", res.status, await res.text());
      break;
    }

    const data = await res.json();
    if (!data.result?.length) break;

    for (let product of data.result) {
      console.log(`\n🛍️ Product: ${product.name} (id=${product.id})`);
      for (let variant of product.sync_variants) {
        console.log(
          `   - sync_variant_id=${variant.id} | sku=${variant.sku} | name=${variant.name}`
        );
        if (variant.sku) {
          syncMap[variant.sku] = variant.id;
        }
      }
    }

    if (data.result.length < limit) break; // no more pages
    offset += limit;
  }

  // Save map to file
  fs.writeFileSync("syncMap.json", JSON.stringify(syncMap, null, 2));
  console.log(`\n✅ syncMap.json saved with ${Object.keys(syncMap).length} entries`);
}

fetchSyncProducts().catch(console.error);
