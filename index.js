// index.js (updated for Printful API v2 "placements")
import express from "express";
import crypto from "crypto";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import QRCode from "qrcode";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();
app.use(bodyParser.json({ type: "application/json", limit: "2mb" }));

const PRINTFUL_API = "https://api.printful.com";
const IMGBB_API = "https://api.imgbb.com/1/upload";
const SKU_MAP_FILE = path.resolve(process.cwd(), "skuMap.json");
const PRINTFUL_TOKEN = process.env.PRINTFUL_TOKEN || "";
const IMGBB_API_KEY = process.env.IMGBB_API_KEY || "";
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || "";
const PORT = Number(process.env.PORT || 3000);

// ---------------- verify HMAC (Shopify) ----------------
function verifyShopifyWebhook(req, res, buf) {
  if (!SHOPIFY_WEBHOOK_SECRET) return;
  const header = req.get("X-Shopify-Hmac-Sha256");
  const digest = crypto.createHmac("sha256", SHOPIFY_WEBHOOK_SECRET).update(buf).digest("base64");
  if (!header || header !== digest) {
    throw new Error("Invalid Shopify webhook signature");
  }
}
app.use(express.json({
  verify: (req, res, buf) => {
    try {
      verifyShopifyWebhook(req, res, buf);
    } catch (e) {
      throw e;
    }
  }
}));

// ---------------- maps + persistence ----------------
let skuMap = {};
let externalMap = {};

function loadSkuMapFromFile() {
  try {
    if (fs.existsSync(SKU_MAP_FILE)) {
      const raw = fs.readFileSync(SKU_MAP_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && parsed.skuMap && parsed.externalMap) {
        skuMap = parsed.skuMap || {};
        externalMap = parsed.externalMap || {};
      } else {
        skuMap = parsed || {};
        externalMap = {};
      }
      console.log(`✅ Loaded skuMap.json (sku keys: ${Object.keys(skuMap).length}, external keys: ${Object.keys(externalMap).length})`);
      return;
    }
  } catch (err) {
    console.warn("⚠️ Could not load skuMap.json:", err.message || err);
  }
  skuMap = {};
  externalMap = {};
}

function saveSkuMapToFileIfChanged(newSkuMap, newExternalMap) {
  try {
    const newObj = { skuMap: newSkuMap, externalMap: newExternalMap };
    const newJson = JSON.stringify(newObj, null, 2);
    if (fs.existsSync(SKU_MAP_FILE)) {
      const oldJson = fs.readFileSync(SKU_MAP_FILE, "utf8");
      if (oldJson === newJson) return;
    }
    fs.writeFileSync(SKU_MAP_FILE, newJson);
    console.log(`✅ Saved skuMap.json (sku keys: ${Object.keys(newSkuMap).length}, external keys: ${Object.keys(newExternalMap).length})`);
  } catch (err) {
    console.error("❌ Failed to save skuMap.json:", err.message || err);
  }
}

// ---------------- build maps from Printful ----------------
async function buildSkuMaps() {
  if (!PRINTFUL_TOKEN) throw new Error("PRINTFUL_TOKEN not set in .env");
  console.log("🔄 Fetching Printful sync catalog...");

  const headers = { Authorization: `Bearer ${PRINTFUL_TOKEN}` };
  let offset = 0;
  const limit = 100;
  const newSkuMap = {};
  const newExternalMap = {};

  while (true) {
    const url = `${PRINTFUL_API}/sync/products?offset=${offset}&limit=${limit}`;
    const resp = await fetch(url, { headers });
    const data = await resp.json();
    if (!resp.ok) {
      console.error("⚠️ Printful sync fetch failed:", data);
      throw new Error("Printful sync fetch failed");
    }

    const products = data.result || [];
    for (const p of products) {
      const pr = await fetch(`${PRINTFUL_API}/sync/products/${p.id}`, { headers });
      const prData = await pr.json();
      if (!pr.ok) {
        console.warn("⚠️ Skipping product detail (failed):", p.id, prData);
        continue;
      }
      const variants = prData.result?.sync_variants || [];
      for (const v of variants) {
        const syncIdRaw = (v.id ?? v.sync_variant_id ?? null);
        const syncId = syncIdRaw != null ? Number(syncIdRaw) : null;
        if (!syncId || Number.isNaN(syncId)) continue;
        if (v.sku) newSkuMap[v.sku] = syncId;
        if (v.external_id != null) newExternalMap[String(v.external_id)] = syncId;
      }
    }

    if (products.length < limit) break;
    offset += limit;
  }

  if (JSON.stringify(skuMap) !== JSON.stringify(newSkuMap) || JSON.stringify(externalMap) !== JSON.stringify(newExternalMap)) {
    skuMap = newSkuMap;
    externalMap = newExternalMap;
    saveSkuMapToFileIfChanged(skuMap, externalMap);
  } else {
    console.log("ℹ️ SKU maps unchanged — no file write");
  }

  const sample = Object.entries(skuMap).slice(0, 8);
  if (sample.length) {
    console.log("🔎 Sample SKU -> sync_variant_id (first 8):");
    sample.forEach(([sku, sid]) => console.log("   ", sku, "→", sid));
  } else {
    console.log("⚠️ SKU map empty after sync.");
  }
}

// ---------------- ImgBB upload ----------------
async function uploadToImgBB(base64Image) {
  if (!IMGBB_API_KEY) throw new Error("IMGBB_API_KEY not set in .env");
  const payload = new URLSearchParams();
  payload.append("image", base64Image);

  const url = `${IMGBB_API}?key=${encodeURIComponent(IMGBB_API_KEY)}`;
  const resp = await fetch(url, { method: "POST", body: payload });
  const data = await resp.json();
  if (!resp.ok || data.success !== true) {
    console.error("❌ ImgBB failed:", data);
    throw new Error("ImgBB upload failed");
  }
  return data.data?.url || data.data?.display_url || null;
}

// ---------------- Create/Update Printful order ----------------
async function createOrUpdatePrintfulOrder(order, imageUrl) {
  if (!PRINTFUL_TOKEN) throw new Error("PRINTFUL_TOKEN not set in .env");

  const items = [];
  for (const li of order.line_items || []) {
    const sku = (li.sku || "").toString();
    const variantFromSku = sku ? skuMap[sku] : undefined;
    const variantFromExternal = li.variant_id ? externalMap[String(li.variant_id)] : undefined;
    const mapped = variantFromSku || variantFromExternal;

    console.log(
      "🔎 SKU lookup:",
      sku || "-",
      "→",
      variantFromSku ?? "(no sku mapping)",
      "| variant_id lookup:",
      li.variant_id ?? "-",
      "→",
      variantFromExternal ?? "(no external mapping)"
    );

    if (!mapped) {
      console.warn(`⚠️ No Printful mapping for item (sku=${sku}, variant_id=${li.variant_id}). Skipping.`);
      continue;
    }

    // ✅ Updated for Printful API v2
    items.push({
      quantity: li.quantity || 1,
      sync_variant_id: Number(mapped),
      placements: [
        {
          placement: "front",
          technique: "dtg",
          layers: [
            { type: "file", url: "default" } // keep front print
          ]
        },
        {
          placement: "back",
          technique: "dtg",
          layers: [
            { type: "file", url: imageUrl } // QR code on back
          ]
        }
      ]
    });
  }

  if (!items.length) {
    console.warn("⚠️ No mapped items in order — skipping Printful call.");
    return { skipped: true, reason: "no_mapped_items" };
  }

  const payload = {
    external_id: String(order.id),
    confirm: false,
    recipient: {
      name: `${order.shipping_address?.first_name || order.customer?.first_name || ""} ${order.shipping_address?.last_name || order.customer?.last_name || ""}`.trim(),
      address1: order.shipping_address?.address1 || "",
      address2: order.shipping_address?.address2 || "",
      city: order.shipping_address?.city || "",
      state_code: order.shipping_address?.province_code || "",
      country_code: order.shipping_address?.country_code || order.shipping_address?.country || "",
      zip: order.shipping_address?.zip || "",
      email: order.email || order.customer?.email || ""
    },
    items
  };

  console.log("🚚 Printful payload:", JSON.stringify(payload, null, 2));

  const url = `${PRINTFUL_API}/orders/@${payload.external_id}`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${PRINTFUL_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await resp.json();
  if (!resp.ok) {
    console.error("❌ Printful error:", data);
    throw new Error(`Printful order failed: ${JSON.stringify(data)}`);
  }

  return data;
}

// ---------------- Webhook handler ----------------
const processedOrders = new Set();

app.post("/webhook/orders_create", async (req, res) => {
  try {
    const order = req.body;
    console.log("✅ Received Shopify order:", order.id, "| line_items:", (order.line_items || []).length);

    if (processedOrders.has(order.id)) {
      console.log(`⚠️ Duplicate webhook ignored for order ${order.id}`);
      return res.status(200).send("Already processed");
    }

    (order.line_items || []).forEach((li, idx) => {
      console.log(`  item[${idx}] "${li.title}" sku="${li.sku}" variant_id=${li.variant_id} qty=${li.quantity}`);
    });

    let qrText = null;
    for (const li of order.line_items || []) {
      if (li.properties) {
        const prop = li.properties.find((p) => (p.name || "").toLowerCase() === "qr text");
        if (prop && prop.value) {
          qrText = prop.value;
          break;
        }
      }
    }

    if (!qrText) {
      console.log("⚠️ No 'QR Text' found — skipping Printful creation.");
      return res.status(200).send("No QR Text");
    }
    console.log("📝 QR Text:", qrText);

    const qrContent = `${qrText}\nVisit: yosoy1.com`;
    const dataUrl = await QRCode.toDataURL(qrContent);
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
    console.log("🖼️ QR base64 length:", base64.length);

    let imageUrl;
    try {
      imageUrl = await uploadToImgBB(base64);
      console.log("🌍 ImgBB URL:", imageUrl);
    } catch (imgErr) {
      console.error("❌ ImgBB upload failed:", imgErr.message || imgErr);
      return res.status(500).send("ImgBB upload failed");
    }

    try {
      const pfResult = await createOrUpdatePrintfulOrder(order, imageUrl);
      if (pfResult && pfResult.skipped) {
        return res.status(200).send("No mapped items; skipped Printful creation");
      }

      console.log("📦 Printful API Response:", pfResult);
      processedOrders.add(order.id);
      return res.status(200).send("Processed and sent to Printful");
    } catch (pfErr) {
      console.error("❌ Printful order creation failed:", pfErr.message || pfErr);
      return res.status(500).send("Printful order failed");
    }
  } catch (err) {
    console.error("❌ Webhook handler error:", err.message || err);
    return res.status(500).send("Server error");
  }
});

// ---------------- Admin + Startup ----------------
app.post("/admin/rebuild-sku-map", async (req, res) => {
  try {
    await buildSkuMaps();
    return res.json({ ok: true, skuKeys: Object.keys(skuMap).length, externalKeys: Object.keys(externalMap).length });
  } catch (err) {
    console.error("❌ Admin rebuild error:", err.message || err);
    return res.status(500).json({ ok: false, error: err.message || err });
  }
});

loadSkuMapFromFile();

app.listen(PORT, async () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  try {
    await buildSkuMaps();
    console.log("✅ SKU maps ready.");
  } catch (err) {
    console.error("⚠️ buildSkuMaps failed:", err.message || err);
  }
  app.get("/", (req, res) => {
    res.send("🚀 The Back Print QR Mockup Server is running!");
  });
});
