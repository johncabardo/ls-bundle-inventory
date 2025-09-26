// app/routes/auth.$.jsx
import { authenticate, registerWebhooks, login } from "../shopify.server";

export const loader = async ({ request }) => {
  // Let Shopify handle the auth flow
  const { session, shop, isOnline } = await authenticate(request);

  // ✅ After successful auth, register webhooks for this shop
  if (session) {
    try {
      const results = await registerWebhooks({ session });
      console.log("✅ Webhooks registered:", results);
    } catch (err) {
      console.error("❌ Failed to register webhooks:", err);
    }
  }

  // Send user to app home
  return login({ request, session, shop, isOnline });
};
