import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { session, redirectUrl } = await authenticate.admin(request);
  console.log(`✅ Authenticated ${session.shop}`);

  return redirect(redirectUrl);
};
