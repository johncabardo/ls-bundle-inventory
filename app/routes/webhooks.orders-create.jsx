// app/routes/webhooks.orders-create.jsx
/**
 * REST-only Shopify webhook handler for orders/create
 * - Adjusts inventory for bundle child variants
 * - Logs every step for debugging
 * - Bypasses Shopify API client entirely
 *
 * Env required:
 *   SHOPIFY_ADMIN_API_ACCESS_TOKEN
 */

export const action = async ({ request }) => {
  try {
    // Parse incoming webhook payload
    const payload = await request.json().catch((e) => {
      console.error("❌ Failed to parse JSON body:", e);
      throw new Error("Invalid JSON");
    });

    // Determine shop from headers
    const shop = request.headers.get("x-shopify-shop-domain") || process.env.HOST;
    const topicHeader = request.headers.get("x-shopify-topic") || "";
    const normalizedTopic = topicHeader.toLowerCase();

    if (!shop) {
      console.error("❌ Shop domain not provided (x-shopify-shop-domain missing)");
      return new Response("Bad Request", { status: 400 });
    }

    // Only handle orders/create
    if (!(normalizedTopic === "orders/create" || normalizedTopic === "orders_create")) {
      console.log(`Ignored webhook topic: ${topicHeader}`);
      return new Response("Ignored", { status: 200 });
    }

    const ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    if (!ACCESS_TOKEN) {
      console.error("❌ SHOPIFY_ADMIN_API_ACCESS_TOKEN is not set");
      return new Response("Server misconfiguration", { status: 500 });
    }

    // Helper: extract numeric variant id from plain or gid string
    const extractVariantId = (v) => {
      if (!v) return null;
      const str = String(v);
      if (str.includes("/")) {
        const parts = str.split("/");
        return parts[parts.length - 1];
      }
      return str;
    };

    // Helper: Shopify REST request
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
      try {
        body = text ? JSON.parse(text) : null;
      } catch (e) {
        console.warn("⚠️ Non-JSON response from Shopify:", text);
      }
      return { ok: res.ok, status: res.status, body, raw: text };
    };
    const notes = payload.note_attributes || [];
    // Iterate order line items
    const lineItems = payload?.line_items || [];
    for (const line of lineItems) {
      const bundleProp = line.properties?.find(p => p.name === "_bundle_variants");
      const bundleAttr = bundleProp?.value;
      notes.push({ name: "_bundle_variants", value: bundleAttr });
      if (!bundleAttr) continue;

      const childDefs = bundleAttr
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(1); // remove first element

      for (const def of childDefs) {
        const [rawVariantId, qtyStr] = def.split("_");
        const variantId = extractVariantId(rawVariantId);
        const quantity = Number(qtyStr || 0);
        if (!variantId || !quantity || Number.isNaN(quantity)) {
          console.warn(`⚠️ Skipping invalid child def "${def}"`);
          continue;
        }

        try {
          // 1) Get variant to find inventory_item_id
          const variantRes = await shopifyFetch(`variants/${variantId}.json`, { method: "GET" });

          if (!variantRes.ok || !variantRes.body?.variant) {
            console.warn(
              `⚠️ Failed to fetch variant ${variantId} (status ${variantRes.status})`,
              variantRes.body || variantRes.raw
            );
            continue;
          }

          const inventoryItemId = variantRes.body.variant.inventory_item_id;
          if (!inventoryItemId) {
            console.warn(`⚠️ Variant ${variantId} missing inventory_item_id`);
            continue;
          }

          // 2) Get inventory levels for the inventory_item_id
          const levelsRes = await shopifyFetch(
            `inventory_levels.json?inventory_item_ids=${inventoryItemId}`,
            { method: "GET" }
          );

          const levels = levelsRes.body?.inventory_levels || [];
          if (!Array.isArray(levels) || levels.length === 0) {
            console.warn(`⚠️ No inventory levels for inventory_item ${inventoryItemId}`);
            continue;
          }

          // 3) For each level, call adjust endpoint
          for (const level of levels) {
            const location_id = level.location_id;
            if (!location_id) {
              console.warn("⚠️ Level missing location_id:", level);
              continue;
            }

            const adjustBody = {
              location_id,
              inventory_item_id: inventoryItemId,
              available_adjustment: -quantity,
            };

            console.log("Adjusting inventory:", {
              inventory_item_id: inventoryItemId,
              location_id,
              available_adjustment: -quantity,
            });

            const adjustRes = await shopifyFetch(`inventory_levels/adjust.json`, {
              method: "POST",
              body: JSON.stringify(adjustBody),
            });

            if (!adjustRes.ok) {
              console.error(
                `❌ Failed to adjust inventory for inventory_item ${inventoryItemId} at location ${location_id}`,
                adjustRes.status,
                adjustRes.body || adjustRes.raw
              );
            } else {
              console.log(
                `✅ Adjusted inventory_item ${inventoryItemId} by -${quantity} at location ${location_id}`
              );
            }
          }
        } catch (childErr) {
          console.error(`❌ Error processing child def "${def}":`, childErr);
        }
      }
    }
    await shopifyFetch(`orders/${payload.id}.json`, {
      method: "PUT",
      body: JSON.stringify({ order: { note_attributes: notes } }),
    });

    return new Response("Webhook processed", { status: 200 });
  } catch (err) {
    console.error("❌ Webhook processing error:", err);
    return new Response("Webhook failed", { status: 500 });
  }
};
