import { shopify } from "../shopify.server";
import { Graphql } from "@shopify/shopify-api"; 

export const action = async ({ request }) => {
  try {
    const body = await request.text();
    const headers = Object.fromEntries(request.headers);

    const topic = headers["x-shopify-topic"];
    const shop = headers["x-shopify-shop-domain"];

    if (topic === "orders/create") {
      try {
        const payload = JSON.parse(body);
        console.log(`🛒 New order ${payload.id} on ${shop}`);

        // ✅ Admin GraphQL client
        const client = new Graphql({
          session: {
            shop,
            accessToken: process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
          },
        });

        // Iterate line items
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
    return new Response("ok", { status: 200 });
  } catch (error) {
    console.error("❌ Webhook route error:", error);
    return new Response("failed", { status: 500 });
  }
};
// // app/routes/webhooks.orders-create.jsx
// import { authenticate } from "../shopify.server";

// export const action = async ({ request }) => {
//   try {
//     console.log("🔑 API Key:", process.env.SHOPIFY_API_KEY);
// console.log("🔑 Secret length:", process.env.SHOPIFY_API_SECRET?.length);
//     // ✅ Use authenticate.webhook (built-in verification + parsing)
//     const { topic, shop, payload } = await authenticate.webhook(request);

//     console.log(`✅ Webhook received: ${topic} from ${shop}`);
//     console.log("Order payload:", payload);

//     if (topic === "ORDERS_CREATE") {
//       try {
//         console.log(`🛒 New order ${payload.id} on ${shop}`);

//         // ✅ Admin GraphQL client
//         const client = new shopify.clients.Graphql({
//           shop,
//           accessToken: process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
//         });

//         // Iterate line items
//         for (const line of payload.line_items) {
//           const bundleAttr = line.properties?._bundle_variants;
//           if (!bundleAttr) continue;

//           const childDefs = bundleAttr.split(",");
//           for (const def of childDefs) {
//             const [variantId, qty] = def.split("_");
//             const quantity = Number(qty);
//             if (!variantId || !quantity) continue;

//             const variantGid = `gid://shopify/ProductVariant/${variantId}`;

//             // Fetch inventory
//             const inventoryQuery = await client.query({
//               data: {
//                 query: `
//                   query getVariantInventory($id: ID!) {
//                     productVariant(id: $id) {
//                       inventoryItem {
//                         inventoryLevels(first: 5) {
//                           edges {
//                             node {
//                               id
//                               available
//                               location { name }
//                             }
//                           }
//                         }
//                       }
//                     }
//                   }
//                 `,
//                 variables: { id: variantGid },
//               },
//             });

//             const levels =
//               inventoryQuery.body?.data?.productVariant?.inventoryItem
//                 ?.inventoryLevels?.edges || [];

//             if (levels.length === 0) {
//               console.warn(`⚠️ No inventory levels for ${variantGid}`);
//               continue;
//             }

//             // Adjust inventory
//             for (const { node } of levels) {
//               const adjust = await client.query({
//                 data: {
//                   query: `
//                     mutation adjustInventory($id: ID!, $delta: Int!) {
//                       inventoryAdjustQuantity(
//                         input: { inventoryLevelId: $id, availableDelta: $delta }
//                       ) {
//                         inventoryLevel { id available }
//                         userErrors { field message }
//                       }
//                     }
//                   `,
//                   variables: { id: node.id, delta: -quantity },
//                 },
//               });

//               const errors =
//                 adjust.body?.data?.inventoryAdjustQuantity?.userErrors || [];
//               if (errors.length > 0) {
//                 console.error(`❌ Error adjusting ${variantId}:`, errors);
//               } else {
//                 console.log(
//                   `✅ Adjusted child variant ${variantId} (-${quantity}) at ${node.location.name}`
//                 );
//               }
//             }
//           }
//         }
//       } catch (err) {
//         console.error("❌ Webhook error:", err);
//         return new Response("Webhook failed", { status: 500 });
//       }
//     }

//     return new Response("Webhook processed", { status: 200 });
//   } catch (error) {
//     console.error("❌ Webhook verification failed:", error);
//     return new Response("Unauthorized", { status: 401 });
//   }
// };
