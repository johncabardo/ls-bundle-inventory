// app/routes/webhooks.orders-create.jsx
import { Graphql } from '@shopify/shopify-api';


export const action = async ({ request }) => {
  try {
    // Parse the JSON payload
    const payload = await request.json();

    // Get shop domain from headers
    const shop = request.headers.get("x-shopify-shop-domain") || "unknown-shop";

    // Optional: Check webhook topic
    const topic = request.headers.get("x-shopify-topic") || "orders/create";

    console.log(`🔓 Processing webhook from ${shop}`);
    console.log("Order payload:", payload);

    if (topic === "orders/create") {
      console.log(`🛒 New order ${payload.id}`);

      const client = new Graphql({
        shop: shop,
        accessToken: process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
      });

      // Iterate through line items
      for (const line of payload.line_items) {
        const bundleAttr = line.properties?._bundle_variants;
        if (!bundleAttr) continue;

        const childDefs = bundleAttr.split(",");
        for (const def of childDefs) {
          const [variantId, qty] = def.split("_");
          const quantity = Number(qty);
          if (!variantId || !quantity) continue;

          const variantGid = `gid://shopify/ProductVariant/${variantId}`;

          // Fetch inventory levels
          const inventoryQuery = await client.query({
            data: {
              query: `
                query getVariantInventory($id: ID!) {
                  productVariant(id: $id) {
                    inventoryItem {
                      inventoryLevels(first: 5) {
                        edges {
                          node {
                            id
                            available
                            location { name }
                          }
                        }
                      }
                    }
                  }
                }
              `,
              variables: { id: variantGid },
            },
          });

          const levels =
            inventoryQuery.body?.data?.productVariant?.inventoryItem
              ?.inventoryLevels?.edges || [];

          if (levels.length === 0) {
            console.warn(`⚠️ No inventory levels for ${variantGid}`);
            continue;
          }

          // Adjust inventory
          for (const { node } of levels) {
            const adjust = await client.query({
              data: {
                query: `
                  mutation adjustInventory($id: ID!, $delta: Int!) {
                    inventoryAdjustQuantity(
                      input: { inventoryLevelId: $id, availableDelta: $delta }
                    ) {
                      inventoryLevel { id available }
                      userErrors { field message }
                    }
                  }
                `,
                variables: { id: node.id, delta: -quantity },
              },
            });

            const errors =
              adjust.body?.data?.inventoryAdjustQuantity?.userErrors || [];
            if (errors.length > 0) {
              console.error(`❌ Error adjusting ${variantId}:`, errors);
            } else {
              console.log(
                `✅ Adjusted child variant ${variantId} (-${quantity}) at ${node.location.name}`
              );
            }
          }
        }
      }
    }

    return new Response("Webhook processed", { status: 200 });
  } catch (err) {
    console.error("❌ Webhook processing error:", err);
    return new Response("Webhook failed", { status: 500 });
  }
};
