// app/routes/webhooks.orders-create.jsx
import { authenticate } from "../shopify.server";
import shopify from "../shopify.server"; // make sure you export the shopify client here

// Optional loader for GET requests (avoid 405 surprises)
export const loader = () => {
  return new Response("Method Not Allowed", { status: 405 });
};

export const action = async ({ request }) => {
  try {

    console.log("🔑 API Key:", process.env.SHOPIFY_API_KEY);
    console.log("🔑 Secret length:", process.env.SHOPIFY_API_SECRET?.length);

    // ✅ Read raw request body for HMAC verification
    const rawBody = await request.text();

    // ✅ Verify webhook with headers and raw body
    const { topic, shop, payload } = await authenticate.webhook({
      rawBody,
      headers: request.headers,
    });

    console.log(`✅ Webhook received: ${topic} from ${shop}`);
    console.log("Order payload ID:", payload.id);

    if (topic === "ORDERS_CREATE") {
      try {
        const client = new shopify.clients.Graphql({
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

            if (!levels.length) {
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

              if (errors.length) {
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
        console.error("❌ Webhook processing error:", err);
        return new Response("Webhook failed", { status: 500 });
      }
    }

    return new Response("Webhook processed", { status: 200 });
  } catch (error) {
    console.error("❌ Webhook verification failed:", error);
    return new Response("Unauthorized", { status: 401 });
  }
};
