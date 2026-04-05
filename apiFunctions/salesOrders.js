import {
  deleteRow,
  getRow,
  insertRow,
  listRows,
  updateRow,
} from "../lib/tableCrud.js";

const TABLE = "sales_orders";
const COLUMNS = [
  "organization_id",
  "customer_name",
  "customer_email",
  "status",
  "order_date",
  "shipping_date",
  "total",
  "created_by",
  "updated_by",
];

export function listSalesOrders() {
  return listRows(TABLE);
}

export function getSalesOrderById(id) {
  return getRow(TABLE, id);
}

export function createSalesOrder(body) {
  return insertRow(TABLE, body, COLUMNS);
}

export function updateSalesOrder(id, body) {
  return updateRow(TABLE, id, body, COLUMNS, true);
}

export function deleteSalesOrder(id) {
  return deleteRow(TABLE, id);
}
