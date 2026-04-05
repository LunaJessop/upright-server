import {
  deleteRow,
  getRow,
  insertRow,
  listRows,
  updateRow,
} from "../lib/tableCrud.js";

const TABLE = "inventory_transactions";
const COLUMNS = [
  "organization_id",
  "item_id",
  "location_id",
  "quantity_change",
  "reason",
  "reference_type",
  "reference_id",
  "created_by",
];

export function listInventoryTransactions() {
  return listRows(TABLE);
}

export function getInventoryTransactionById(id) {
  return getRow(TABLE, id);
}

export function createInventoryTransaction(body) {
  return insertRow(TABLE, body, COLUMNS);
}

export function updateInventoryTransaction(id, body) {
  return updateRow(TABLE, id, body, COLUMNS, false);
}

export function deleteInventoryTransaction(id) {
  return deleteRow(TABLE, id);
}
