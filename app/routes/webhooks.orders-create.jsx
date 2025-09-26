// app/routes/webhooks.orders-create.jsx
import { shopify } from "../shopify.server";

export const action = async ({ request }) => {
  try {
    // ✅ Verify + parse webhook
    const { topic, shop, payload } = await shopify.authenticate.webhook(request);

    console.log(`✅ Webhook received: ${topic} from ${shop}`);

    if (topic === "ORDERS_CREATE") {
      const order = payload;
      console.log(`🛒 New order ${order.id} on ${shop}`);

      // ✅ Create an *admin* GraphQL client (no session needed for webhooks)
      const client = new shopify.clients.Graphql({ shop, accessToken: process.env.SHOPIFY_API_SECRET });

      // Loop through each line item
      for (const line of order.line_items) {
        const bundleAttr = line.properties?._bundle_variants;
        if (!bundleAttr) continue; // skip non-bundle items

        // Example: "43188327448623_1_23700,41613760266287_4_0"
        const childDefs = bundleAttr.split(",");

        for (const def of childDefs) {
          const [variantId, qty] = def.split("_");
          const quantity = Number(qty);
          if (!variantId || !quantity) continue;

          const variantGid = `gid://shopify/ProductVariant/${variantId}`;

          // 1. Fetch inventory levels
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
            inventoryQuery.body?.data?.productVariant?.inventoryItem?.inventoryLevels?.edges || [];

          if (levels.length === 0) {
            console.warn(`⚠️ No inventory levels for ${variantGid}`);
            continue;
          }

          // 2. Adjust inventory at each location
          for (const { node } of levels) {
            const inventoryLevelId = node.id;

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
                variables: { id: inventoryLevelId, delta: -quantity },
              },
            });

            const errorMsg = adjust.body?.data?.inventoryAdjustQuantity?.userErrors || [];
            if (errorMsg.length > 0) {
              console.error(`❌ Error adjusting ${variantId}:`, errorMsg);
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
  } catch (error) {
    console.error("❌ Webhook verification failed:", error);
    return new Response("Unauthorized", { status: 401 });
  }
};
