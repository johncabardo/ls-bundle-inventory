// app/routes/webhooks.orders-create.jsx
import { json } from "@remix-run/node";
import { Shopify } from "@shopify/shopify-api";

export const action = async ({ request }) => {
  try {
    // 1️⃣ Get raw body for verification
    const rawBody = await request.text();

    // 2️⃣ Get Shopify HMAC header
    const hmac = request.headers.get("x-shopify-hmac-sha256");
    const topic = request.headers.get("x-shopify-topic");
    const shop = request.headers.get("x-shopify-shop-domain");

    // 3️⃣ Verify webhook signature
    const verified = Shopify.Webhooks.Registry.isWebhookRequestValid(
      rawBody,
      hmac,
      process.env.SHOPIFY_API_SECRET
    );

    if (!verified) {
      console.error("❌ Webhook HMAC verification failed");
      return new Response("Unauthorized", { status: 401 });
    }

    // 4️⃣ Parse payload
    const payload = JSON.parse(rawBody);
    console.log(`✅ Webhook received: ${topic} from ${shop}`);

    // 5️⃣ Process ORDERS_CREATE
    if (topic === "ORDERS_CREATE") {
      try {
        console.log(`🛒 New order ${payload.id} on ${shop}`);

        // Shopify Admin GraphQL client
        const client = new Shopify.Clients.Graphql(
          shop,
          process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN
        );

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

            // Adjust inventory for each location
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
