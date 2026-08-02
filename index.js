import "dotenv/config";
import cors from "cors";
import express from "express";
import { createItem, deleteItem, getItemById, getItemProductionTree, getItems, updateItem } from "./api-functions/items.js";
import { createBatch, getBatchById, getBatches, updateBatchPhase, cancelBatch, completeBatch } from "./api-functions/batches.js";
import {
  createRouterPhaseTemplate,
  deleteRouterPhaseTemplate,
  getRouterPhaseTemplates,
  updateRouterPhaseTemplate,
} from "./api-functions/routerPhases.js";
import {
  createVendor,
  deleteVendor,
  getVendors,
  updateVendor,
} from "./api-functions/vendors.js";
import { createTag, getTags } from "./api-functions/tags.js";
import {
  getInventoryList,
  getItemInventory,
  updateItemInventory,
  updateItemInventoryGoal,
} from "./api-functions/inventory.js";
import {
  createPurchaseLot,
  deletePurchaseLot,
  getPurchaseLotsForItem,
} from "./api-functions/purchaseLots.js";
import { getMe, login, register } from "./api-functions/auth.js";
import { createCheckout, createPortal } from "./api-functions/billing.js";
import { createClientUser, getClient } from "./api-functions/clients.js";
import { listClients } from "./api-functions/admin.js";
import { stripeWebhook } from "./api-functions/stripeWebhook.js";
import { requireAuth, requirePlatformAdmin } from "./lib/auth.js";
import {
  requireActiveSubscription,
  requireReadableSubscription,
  requireAdminOrFounder,
  requireFounder,
} from "./lib/billing.js";
import { pool } from "./lib/db.js";

export { pool };

const app = express();
app.use(cors());

// Stripe webhooks need the raw body for signature verification.
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  stripeWebhook
);

app.use(express.json());

app.post("/api/auth/login", login);
app.post("/api/auth/register", register);
app.get("/api/auth/me", requireAuth, getMe);

app.post("/api/billing/checkout", requireAuth, requireFounder, createCheckout);
app.post("/api/billing/portal", requireAuth, requireFounder, createPortal);

app.get(
  "/api/admin/clients",
  requireAuth,
  requirePlatformAdmin,
  listClients
);

app.get("/api/client", requireAuth, requireReadableSubscription, getClient);
app.post(
  "/api/client/users",
  requireAuth,
  requireActiveSubscription,
  requireFounder,
  createClientUser
);

app.get("/api/items", requireAuth, requireReadableSubscription, getItems);
app.get(
  "/api/inventory",
  requireAuth,
  requireReadableSubscription,
  getInventoryList
);
app.get(
  "/api/items/:id/production-tree",
  requireAuth,
  requireReadableSubscription,
  getItemProductionTree
);
app.get("/api/items/:id", requireAuth, requireReadableSubscription, getItemById);
app.get(
  "/api/items/:id/inventory",
  requireAuth,
  requireReadableSubscription,
  getItemInventory
);
app.put(
  "/api/items/:id/inventory",
  requireAuth,
  requireActiveSubscription,
  updateItemInventory
);
app.put(
  "/api/items/:id/inventory/goal",
  requireAuth,
  requireActiveSubscription,
  requireAdminOrFounder,
  updateItemInventoryGoal
);
app.get(
  "/api/items/:id/purchase-lots",
  requireAuth,
  requireReadableSubscription,
  getPurchaseLotsForItem
);
app.post(
  "/api/items/:id/purchase-lots",
  requireAuth,
  requireActiveSubscription,
  createPurchaseLot
);
app.delete(
  "/api/items/:id/purchase-lots/:lotId",
  requireAuth,
  requireActiveSubscription,
  deletePurchaseLot
);
app.post("/api/items", requireAuth, requireActiveSubscription, createItem);
app.put("/api/items/:id", requireAuth, requireActiveSubscription, updateItem);
app.delete("/api/items/:id", requireAuth, requireActiveSubscription, deleteItem);

app.get("/api/batches", requireAuth, requireReadableSubscription, getBatches);
app.get(
  "/api/batches/:id",
  requireAuth,
  requireReadableSubscription,
  getBatchById
);
app.post("/api/batches", requireAuth, requireActiveSubscription, createBatch);
app.post(
  "/api/batches/:id/cancel",
  requireAuth,
  requireActiveSubscription,
  cancelBatch
);
app.post(
  "/api/batches/:id/complete",
  requireAuth,
  requireActiveSubscription,
  completeBatch
);
app.patch(
  "/api/batches/:id/phases/:phaseId",
  requireAuth,
  requireActiveSubscription,
  updateBatchPhase
);

app.get(
  "/api/router-phase-templates",
  requireAuth,
  requireReadableSubscription,
  getRouterPhaseTemplates
);
app.post(
  "/api/router-phase-templates",
  requireAuth,
  requireActiveSubscription,
  createRouterPhaseTemplate
);
app.put(
  "/api/router-phase-templates/:id",
  requireAuth,
  requireActiveSubscription,
  updateRouterPhaseTemplate
);
app.delete(
  "/api/router-phase-templates/:id",
  requireAuth,
  requireActiveSubscription,
  deleteRouterPhaseTemplate
);

app.get("/api/vendors", requireAuth, requireReadableSubscription, getVendors);
app.post("/api/vendors", requireAuth, requireActiveSubscription, createVendor);
app.put("/api/vendors/:id", requireAuth, requireActiveSubscription, updateVendor);
app.delete(
  "/api/vendors/:id",
  requireAuth,
  requireActiveSubscription,
  deleteVendor
);

app.get("/api/tags", requireAuth, requireReadableSubscription, getTags);
app.post("/api/tags", requireAuth, requireActiveSubscription, createTag);

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

// Vercel: the default export IS the handler — no listen() needed
export default app;

// Local dev: bind a port as usual
if (!process.env.VERCEL) {
  const port = Number(process.env.PORT ?? 3001);
  const server = app.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });

  const shutdown = (signal) => {
    console.log(`Received ${signal}, closing server and database pool…`);
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
