import {
  deleteRow,
  getRow,
  insertRow,
  listRows,
  updateRow,
} from "../lib/tableCrud.js";

const TABLE = "items";
const COLUMNS = [
  "organization_id",
  "name",
  "sku",
  "description",
  "item_type",
  "make_or_buy",
  "unit_of_measure",
  "default_cost",
  "active",
  "created_by",
  "updated_by",
];

export function listItems() {
  return listRows(TABLE);
}

export function getItemById(id) {
  return getRow(TABLE, id);
}

export function createItem(body) {
  return insertRow(TABLE, body, COLUMNS);
}

export function updateItem(id, body) {
  return updateRow(TABLE, id, body, COLUMNS, true);
}

export function deleteItem(id) {
  return deleteRow(TABLE, id);
}
