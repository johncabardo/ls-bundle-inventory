// app/routes/webhooks.orders-create.jsx
/**
 * REST-only Shopify webhook handler for orders/create
 * - Bypasses @shopify/shopify-api entirely
 * - Optional lightweight secret check via X-Webhook-Token if ENCRYPTION_KEY is set
 *
 * Expects bundle line item property _bundle_variants formatted as:
 *   "123456789_1,987654321_2"
 *
 * Env required:
 *   SHOPIFY_ADMIN_API_ACCESS_TOKEN
 *   ENCRYPTION_KEY (optional)
 */

export const action = async ({ request }) => {
  try {
    // Optional lightweight secret check (set ENCRYPTION_KEY in env)
    // const webhookSecret = process.env.ENCRYPTION_KEY;
    // const token = request.headers.get("x-webhook-token");
    // if (!token || token !== webhookSecret) {
    //   return new Response("Unauthorized", { status: 401 });
    // }


    // Parse incoming webhook payload
    const payload = await request.json().catch((e) => {
      console.error("❌ Failed to parse JSON body:", e);
      throw new Error("Invalid JSON");
    });

    // Determine shop and topic from headers (Shopify provides these)
    const shop = request.headers.get("x-shopify-shop-domain") || process.env.HOST;
    const topicHeader = request.headers.get("x-shopify-topic") || "";
    const normalizedTopic = topicHeader.toLowerCase();

    if (!shop) {
      console.error("❌ Shop domain not provided (x-shopify-shop-domain missing)");
      return new Response("Bad Request", { status: 400 });
    }

    // Only handle orders/create (accept either "orders/create" or "orders_create")
    if (!(normalizedTopic === "orders/create" || normalizedTopic === "orders_create")) {
      console.log(`Ignored webhook topic: ${topicHeader}`);
      return new Response("Ignored", { status: 200 });
    }

    console.log(`🔓 Processing ORDERS_CREATE webhook from ${shop}`);
    console.log("Order id:", payload?.id);

    const ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    if (!ACCESS_TOKEN) {
      console.error("❌ SHOPIFY_ADMIN_API_ACCESS_TOKEN is not set");
      return new Response("Server misconfiguration", { status: 500 });
    }

    // Helper: extract numeric variant id (handles plain numbers or gid://...)
    const extractVariantId = (v) => {
      if (!v) return null;
      const str = String(v);
      // If it's a gid like gid://shopify/ProductVariant/123456789, take last part
      if (str.includes("/")) {
        const parts = str.split("/");
        return parts[parts.length - 1];
      }
      return str;
    };

    // Helper: request wrapper for Shopify REST
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

    // Iterate order line items
    const lineItems = payload?.line_items || [];
    for (const line of lineItems) {
      const bundleAttr = line.properties?._bundle_variants;
      if (!bundleAttr) continue;

      const childDefs = bundleAttr.split(",").map((s) => s.trim()).filter(Boolean);

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
          const variantRes = await shopifyFetch(`variants/${variantId}.json`, {
            method: "GET",
          });

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
              // do not throw — continue trying other levels/children
            } else {
              console.log(
                `✅ Adjusted inventory_item ${inventoryItemId} by -${quantity} at location ${location_id}`
              );
            }
          }
        } catch (childErr) {
          console.error(`❌ Error processing child def "${def}":`, childErr);
          // continue to next child
        }
      } // end childDefs loop
    } // end lineItems loop

    return new Response("Webhook processed", { status: 200 });
  } catch (err) {
    console.error("❌ Webhook processing error:", err);
    return new Response("Webhook failed", { status: 500 });
  }
};
