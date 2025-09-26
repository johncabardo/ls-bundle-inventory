// app/routes/webhooks.orders-create.jsx
import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { topic, shop, session, payload } = await authenticate.webhook(request);

  if (topic === "ORDERS_CREATE") {
    try {
      console.log(`🛒 Order created on ${shop}:`, payload.id);

      // Loop through order line items
      for (const line of payload.line_items) {
        const variantId = line.variant_id;
        const quantity = line.quantity;

        // Example: Skip "parent" items (only decrease hidden children)
        if (line.sku?.includes("HIDDEN")) {
          console.log(`Skipping parent ${line.sku}`);
          continue;
        }

        // Decrement inventory via GraphQL
        const client = new shopify.clients.Graphql({ session });

        const mutation = `
          mutation adjustInventory($id: ID!, $delta: Int!) {
            inventoryAdjustQuantity(input: { inventoryLevelId: $id, availableDelta: $delta }) {
              inventoryLevel {
                id
                available
              }
              userErrors {
                field
                message
              }
            }
          }
        `;

        // Get inventoryLevelId first
        const inventoryQuery = await client.query({
          data: {
            query: `
              query getVariantInventory($id: ID!) {
                productVariant(id: $id) {
                  inventoryItem {
                    inventoryLevels(first: 1) {
                      edges {
                        node {
                          id
                          available
                        }
                      }
                    }
                  }
                }
              }
            `,
            variables: { id: `gid://shopify/ProductVariant/${variantId}` },
          },
        });

        const inventoryLevelId =
          inventoryQuery.body.data.productVariant.inventoryItem.inventoryLevels.edges[0].node.id;

        // Adjust inventory
        await client.query({
          data: {
            query: mutation,
            variables: { id: inventoryLevelId, delta: -quantity },
          },
        });

        console.log(`✅ Decreased inventory for variant ${variantId} by ${quantity}`);
      }
    } catch (err) {
      console.error("❌ Webhook error:", err);
      return new Response("Webhook failed", { status: 500 });
    }
  }

  return new Response("Webhook processed", { status: 200 });
};
