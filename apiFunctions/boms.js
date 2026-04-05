import {
  deleteRow,
  getRow,
  insertRow,
  listRows,
  updateRow,
} from "../lib/tableCrud.js";

const TABLE = "boms";
const COLUMNS = [
  "organization_id",
  "parent_item_id",
  "version",
  "is_active",
  "created_by",
];

export function listBoms() {
  return listRows(TABLE);
}

export function getBomById(id) {
  return getRow(TABLE, id);
}

export function createBom(body) {
  return insertRow(TABLE, body, COLUMNS);
}

export function updateBom(id, body) {
  return updateRow(TABLE, id, body, COLUMNS, false);
}

export function deleteBom(id) {
  return deleteRow(TABLE, id);
}
