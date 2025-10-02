import fetch from "node-fetch";

const shopifyDomain = process.env.SHOPIFY_STORE_DOMAIN;
const shopifyKey = process.env.SHOPIFY_API_KEY;
const shopifyPassword = process.env.SHOPIFY_API_PASSWORD;
const printfulToken = process.env.PRINTFUL_TOKEN;
const printfulStoreId = process.env.PRINTFUL_STORE_ID;

// Function to fetch Shopify products
async function getShopifyVariants() {
  const url = `https://${shopifyKey}:${shopifyPassword}@${shopifyDomain}/admin/api/2025-01/products.json?limit=250`;
  const res = await fetch(url);
  const data = await res.json();

  const variants = {};
  data.products.forEach(product => {
    product.variants.forEach(variant => {
      variants[variant.sku] = variant.id; // map SKU -> Shopify variant ID
    });
  });
  return variants;
}

// Function to fetch Printful products
async function getPrintfulVariants() {
  const url = `https://api.printful.com/store/products`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${printfulToken}` }
  });
  const data = await res.json();

  const variants = {};
  for (const product of data.result) {
    const productRes = await fetch(`https://api.printful.com/store/products/${product.id}`, {
      headers: { Authorization: `Bearer ${printfulToken}` }
    });
    const productData = await productRes.json();

    productData.result.variants.forEach(v => {
      variants[v.sku] = v.id; // map SKU -> Printful variant ID
    });
  }
  return variants;
}

// Build mapping between Shopify and Printful
export async function buildVariantMap() {
  const shopify = await getShopifyVariants();
  const printful = await getPrintfulVariants();

  const map = {};
  for (const sku in shopify) {
    if (printful[sku]) {
      map[shopify[sku]] = printful[sku]; // Shopify variant ID → Printful variant ID
    }
  }
  console.log("✅ Variant mapping:", map);
  return map;
}
