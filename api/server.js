// Vercel serverless entry point — re-exports the Express app from the root.
// Vercel invokes this default export as the request handler for /api/* routes.
import app from "../server.js";
export default app;
