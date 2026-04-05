import {
  deleteRow,
  getRow,
  insertRow,
  listRows,
  updateRow,
} from "../lib/tableCrud.js";

const TABLE = "organizations";
const COLUMNS = ["name", "slug", "email", "phone", "active"];

export function listOrganizations() {
  return listRows(TABLE);
}

export function getOrganizationById(id) {
  return getRow(TABLE, id);
}

export function createOrganization(body) {
  return insertRow(TABLE, body, COLUMNS);
}

export function updateOrganization(id, body) {
  return updateRow(TABLE, id, body, COLUMNS, true);
}

export function deleteOrganization(id) {
  return deleteRow(TABLE, id);
}
