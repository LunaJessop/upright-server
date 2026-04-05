import {
  deleteRow,
  getRow,
  insertRow,
  listRows,
  updateRow,
} from "../lib/tableCrud.js";

const TABLE = "inventory";
const COLUMNS = ["organization_id", "item_id", "location_id", "quantity"];

export function listInventory() {
  return listRows(TABLE);
}

export function getInventoryById(id) {
  return getRow(TABLE, id);
}

export function createInventory(body) {
  return insertRow(TABLE, body, COLUMNS);
}

export function updateInventory(id, body) {
  return updateRow(TABLE, id, body, COLUMNS, true);
}

export function deleteInventory(id) {
  return deleteRow(TABLE, id);
}
