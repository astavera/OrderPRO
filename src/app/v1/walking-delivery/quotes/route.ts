import { createWalkingQuotePostHandler } from "../../../../application/fulfillment/walking-quote-http-handler";

export const dynamic = "force-dynamic";

export const POST = createWalkingQuotePostHandler({
  // The application handler is complete, but no OAuth issuer/client inventory
  // has been approved for this runtime. Never fall back to human cookies.
  async authenticate() {
    return {
      authenticated: false,
      code: "M2M_AUTH_NOT_CONFIGURED",
    } as const;
  },
  async evaluate() {
    throw new Error("Walking quote runtime dependencies are not configured.");
  },
});
