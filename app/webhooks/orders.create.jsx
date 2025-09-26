import { DeliveryMethod } from "@shopify/shopify-api";
import shopify from "../shopify.server";

// Register the webhook
shopify.webhooks.addHandlers({
  ORDERS_CREATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/webhooks/orders-create",
    callback: async (topic, shop, body, webhookId) => {
      const order = JSON.parse(body);

      for (const line of order.line_items) {
        const bundleAttr = line.properties?._bundle_variants;
        if (!bundleAttr) continue;

        // Example: "43188327448623_1_23700,41613760266287_4_0"
        const childDefs = bundleAttr.split(",");
        for (const def of childDefs) {
          const [variantId, qty] = def.split("_");
          await decrementInventory(shop, variantId, parseInt(qty, 10));
        }
      }
    },
  },
});

// Helper to adjust inventory
async function decrementInventory(shop, variantId, qty) {
  // Step 1: Query inventory level for variant
  const query = `
    query getInventoryLevel($id: ID!) {
      productVariant(id: $id) {
        inventoryItem {
          inventoryLevels(first: 1) {
            edges {
              node {
                id
              }
            }
          }
        }
      }
    }
  `;

  const response = await shopify.graphql({
    shop,
    data: {
      query,
      variables: { id: `gid://shopify/ProductVariant/${variantId}` },
    },
  });

  const levelId =
    response.data.productVariant.inventoryItem.inventoryLevels.edges[0].node.id;

  // Step 2: Adjust inventory
  const mutation = `
    mutation adjustInventory($id: ID!, $delta: Int!) {
      inventoryAdjustQuantity(
        input: { inventoryLevelId: $id, availableDelta: $delta }
      ) {
        inventoryLevel {
          available
        }
        userErrors {
          message
        }
      }
    }
  `;

  await shopify.graphql({
    shop,
    data: {
      query: mutation,
      variables: { id: levelId, delta: -qty },
    },
  });
}
