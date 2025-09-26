import { shopify } from "../shopify.server";

export const action = async ({ request }) => {
  try {
    // ✅ Use processWebhook, not webhooks.process
    const { topic, shop, payload } = await shopify.processWebhook(request);

    console.log(`✅ Webhook received: ${topic} from ${shop}`);
    console.log("Order payload:", payload);

    if (topic === "ORDERS_CREATE") {
      try {
        console.log(`🛒 New order ${payload.id} on ${shop}`);

        // Use Admin API client (needs your app’s Admin API token)
        const client = new shopify.api.clients.Graphql({
          shop,
          accessToken: process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
        });

        for (const line of payload.line_items) {
          const bundleAttr = line.properties?._bundle_variants;
          if (!bundleAttr) continue;

          const childDefs = bundleAttr.split(",");
          for (const def of childDefs) {
            const [variantId, qty] = def.split("_");
            const quantity = Number(qty);
            if (!variantId || !quantity) continue;

            const variantGid = `gid://shopify/ProductVariant/${variantId}`;

            // Fetch inventory
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
      } catch (err) {
        console.error("❌ Webhook error:", err);
        return new Response("Webhook failed", { status: 500 });
      }
    }

    return new Response("Webhook processed", { status: 200 });
  } catch (error) {
    console.error("❌ Webhook verification failed:", error);
    return new Response("Unauthorized", { status: 401 });
  }
};
