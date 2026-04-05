import {
  deleteRow,
  getRow,
  insertRow,
  listRows,
  updateRow,
} from "../lib/tableCrud.js";

const TABLE = "bom_items";
const COLUMNS = [
  "bom_id",
  "component_item_id",
  "quantity_required",
  "unit_of_measure",
  "scrap_factor",
];

export function listBomItems() {
  return listRows(TABLE);
}

export function getBomItemById(id) {
  return getRow(TABLE, id);
}

export function createBomItem(body) {
  return insertRow(TABLE, body, COLUMNS);
}

export function updateBomItem(id, body) {
  return updateRow(TABLE, id, body, COLUMNS, false);
}

export function deleteBomItem(id) {
  return deleteRow(TABLE, id);
}
