// app/routes/webhooks.orders-create.jsx
export const action = async ({ request }) => {
  try {
    const payload = await request.json().catch(() => {
      throw new Error("Invalid JSON");
    });

    const shop = request.headers.get("x-shopify-shop-domain") || process.env.HOST;
    const topicHeader = request.headers.get("x-shopify-topic") || "";
    const normalizedTopic = topicHeader.toLowerCase();

    if (!shop) return new Response("Bad Request", { status: 400 });
    if (!(normalizedTopic === "orders/create" || normalizedTopic === "orders_create"))
      return new Response("Ignored", { status: 200 });

    const ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    if (!ACCESS_TOKEN) return new Response("Server misconfiguration", { status: 500 });

    const extractVariantId = (v) => (v?.includes("/") ? v.split("/").pop() : v);

    const shopifyFetch = async (path, options = {}) => {
      const url = `https://${shop}/admin/api/2025-07/${path}`;
      const res = await fetch(url, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": ACCESS_TOKEN,
          ...(options.headers || {}),
        },
      });
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch {}
      return { ok: res.ok, status: res.status, body, raw: text };
    };

    const lineItems = payload?.line_items || [];
    const noteAttributes = payload.note_attributes || [];
console.log(lineItems);
    for (const line of lineItems) {
      // Find bundle properties
      const bundlePropIndex = line.properties?.findIndex(
        (p) => p.name === "_bundle_variants"
      );
      if (bundlePropIndex < 0) continue;

      const bundleProp = line.properties[bundlePropIndex];
      if (!bundleProp?.value) continue;

      // 1️⃣ Move bundle data to note_attributes
      // noteAttributes.push({ name: bundleProp.name, value: bundleProp.value });

      // 2️⃣ Remove from line.properties so it doesn't show on order page
      // line.properties.splice(bundlePropIndex, 1);

      // 3️⃣ Parse child items and adjust inventory
      const childItems = bundleProp.value.split(",").map((s) => s.trim()).filter(Boolean);

      for (const child of childItems) {
        const [rawVariantId, qtyStr] = child.split("_");
        const variantId = extractVariantId(rawVariantId);
        const quantity = Number(qtyStr || 0);
        if (!variantId || quantity <= 0) continue;

        try {
          const variantRes = await shopifyFetch(`variants/${variantId}.json`);
          const inventoryItemId = variantRes.body?.variant?.inventory_item_id;
          if (!inventoryItemId) continue;

          const levelsRes = await shopifyFetch(
            `inventory_levels.json?inventory_item_ids=${inventoryItemId}`
          );
          const levels = levelsRes.body?.inventory_levels || [];

          for (const level of levels) {
            if (!level.location_id) continue;
            await shopifyFetch(`inventory_levels/adjust.json`, {
              method: "POST",
              body: JSON.stringify({
                location_id: level.location_id,
                inventory_item_id: inventoryItemId,
                available_adjustment: -quantity,
              }),
            });
          }
        } catch (err) {
          console.error(`Error adjusting inventory for variant ${variantId}:`, err);
        }
      }
    }

    return new Response("Webhook processed", { status: 200 });
  } catch (err) {
    console.error("Webhook error:", err);
    return new Response("Webhook failed", { status: 500 });
  }
};
