import "dotenv/config";
import cors from "cors";
import express from "express";
import { closePool } from "./db/pool.js";
import { createCrudRouter } from "./lib/crudRouter.js";
import { errorHandler } from "./lib/errorHandler.js";
import * as bomItems from "./apiFunctions/bomItems.js";
import * as boms from "./apiFunctions/boms.js";
import * as inventory from "./apiFunctions/inventory.js";
import * as inventoryTransactions from "./apiFunctions/inventoryTransactions.js";
import * as items from "./apiFunctions/items.js";
import * as jobComponents from "./apiFunctions/jobComponents.js";
import * as jobs from "./apiFunctions/jobs.js";
import * as locations from "./apiFunctions/locations.js";
import * as organizations from "./apiFunctions/organizations.js";
import * as salesOrderItems from "./apiFunctions/salesOrderItems.js";
import * as salesOrders from "./apiFunctions/salesOrders.js";
import * as users from "./apiFunctions/users.js";

const port = Number(process.env.PORT ?? 3001);

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use(
  "/api/organizations",
  createCrudRouter({
    list: organizations.listOrganizations,
    getById: organizations.getOrganizationById,
    create: organizations.createOrganization,
    update: organizations.updateOrganization,
    remove: organizations.deleteOrganization,
  }),
);
app.use(
  "/api/users",
  createCrudRouter({
    list: users.listUsers,
    getById: users.getUserById,
    create: users.createUser,
    update: users.updateUser,
    remove: users.deleteUser,
  }),
);
app.use(
  "/api/items",
  createCrudRouter({
    list: items.listItems,
    getById: items.getItemById,
    create: items.createItem,
    update: items.updateItem,
    remove: items.deleteItem,
  }),
);
app.use(
  "/api/boms",
  createCrudRouter({
    list: boms.listBoms,
    getById: boms.getBomById,
    create: boms.createBom,
    update: boms.updateBom,
    remove: boms.deleteBom,
  }),
);
app.use(
  "/api/bom-items",
  createCrudRouter({
    list: bomItems.listBomItems,
    getById: bomItems.getBomItemById,
    create: bomItems.createBomItem,
    update: bomItems.updateBomItem,
    remove: bomItems.deleteBomItem,
  }),
);
app.use(
  "/api/locations",
  createCrudRouter({
    list: locations.listLocations,
    getById: locations.getLocationById,
    create: locations.createLocation,
    update: locations.updateLocation,
    remove: locations.deleteLocation,
  }),
);
app.use(
  "/api/inventory",
  createCrudRouter({
    list: inventory.listInventory,
    getById: inventory.getInventoryById,
    create: inventory.createInventory,
    update: inventory.updateInventory,
    remove: inventory.deleteInventory,
  }),
);
app.use(
  "/api/inventory-transactions",
  createCrudRouter({
    list: inventoryTransactions.listInventoryTransactions,
    getById: inventoryTransactions.getInventoryTransactionById,
    create: inventoryTransactions.createInventoryTransaction,
    update: inventoryTransactions.updateInventoryTransaction,
    remove: inventoryTransactions.deleteInventoryTransaction,
  }),
);
app.use(
  "/api/sales-orders",
  createCrudRouter({
    list: salesOrders.listSalesOrders,
    getById: salesOrders.getSalesOrderById,
    create: salesOrders.createSalesOrder,
    update: salesOrders.updateSalesOrder,
    remove: salesOrders.deleteSalesOrder,
  }),
);
app.use(
  "/api/sales-order-items",
  createCrudRouter({
    list: salesOrderItems.listSalesOrderItems,
    getById: salesOrderItems.getSalesOrderItemById,
    create: salesOrderItems.createSalesOrderItem,
    update: salesOrderItems.updateSalesOrderItem,
    remove: salesOrderItems.deleteSalesOrderItem,
  }),
);
app.use(
  "/api/jobs",
  createCrudRouter({
    list: jobs.listJobs,
    getById: jobs.getJobById,
    create: jobs.createJob,
    update: jobs.updateJob,
    remove: jobs.deleteJob,
  }),
);
app.use(
  "/api/job-components",
  createCrudRouter({
    list: jobComponents.listJobComponents,
    getById: jobComponents.getJobComponentById,
    create: jobComponents.createJobComponent,
    update: jobComponents.updateJobComponent,
    remove: jobComponents.deleteJobComponent,
  }),
);

app.use(errorHandler);

const server = app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[api] Port ${port} is already in use. Stop the other Node process using it (e.g. another terminal running the API), or set PORT to a free port.`,
    );
  } else {
    console.error(err);
  }
  process.exit(1);
});

function shutdown(signal) {
  console.log(`Received ${signal}, closing server and database pool…`);
  server.close(() => {
    void closePool().then(() => process.exit(0));
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
