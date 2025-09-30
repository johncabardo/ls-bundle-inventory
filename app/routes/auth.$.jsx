// app/routes/auth.$.jsx
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  try {
    const response = await authenticate.admin(request);
    console.log("✅ Auth granted:", response.session?.shop);
    return response;
  } catch (error) {
    console.error("❌ Auth error:", error);
    throw error;
  }
};
