import {
  deleteRow,
  getRow,
  insertRow,
  listRows,
  updateRow,
} from "../lib/tableCrud.js";

const TABLE = "sales_order_items";
const COLUMNS = ["sales_order_id", "item_id", "quantity", "unit_price", "total"];

export function listSalesOrderItems() {
  return listRows(TABLE);
}

export function getSalesOrderItemById(id) {
  return getRow(TABLE, id);
}

export function createSalesOrderItem(body) {
  return insertRow(TABLE, body, COLUMNS);
}

export function updateSalesOrderItem(id, body) {
  return updateRow(TABLE, id, body, COLUMNS, false);
}

export function deleteSalesOrderItem(id) {
  return deleteRow(TABLE, id);
}
