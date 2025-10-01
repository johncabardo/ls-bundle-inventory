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

    // Step 1: collect all child variant IDs from bundles
    const childVariantIds = new Set();
    for (const line of lineItems) {
      const bundleAttr = line.attributes?.find(a => a.name === "_bundle_variants");
      if (!bundleAttr) continue;

      const childDefs = bundleAttr.value.split(",").map(s => s.trim()).filter(Boolean).slice(1);
      for (const def of childDefs) {
        const [variantId] = def.split("_");
        if (variantId) childVariantIds.add(variantId);
      }
    }

    // Step 2: process bundles
    const noteAttributes = payload.note_attributes || [];
    for (const line of lineItems) {
      const bundleAttrIndex = line.attributes?.findIndex(a => a.name === "_bundle_variants");
      const bundleAttr = bundleAttrIndex >= 0 ? line.attributes[bundleAttrIndex] : null;
      if (!bundleAttr) continue;

      // Optional: move to note_attributes for order-level tracking
      noteAttributes.push({ name: "_bundle_variants", value: bundleAttr.value });

      const childDefs = bundleAttr.value.split(",").map(s => s.trim()).filter(Boolean).slice(1);
      for (const def of childDefs) {
        const [rawVariantId, qtyStr] = def.split("_");
        const variantId = extractVariantId(rawVariantId);
        const quantity = Number(qtyStr || 0);
        if (!variantId || !quantity || Number.isNaN(quantity)) continue;

        try {
          // Skip if this variant is also a standalone line item (prevent double decrement)
          if (!childVariantIds.has(variantId)) continue;

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
