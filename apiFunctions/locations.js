import {
  deleteRow,
  getRow,
  insertRow,
  listRows,
  updateRow,
} from "../lib/tableCrud.js";

const TABLE = "locations";
const COLUMNS = ["organization_id", "name", "type"];

export function listLocations() {
  return listRows(TABLE);
}

export function getLocationById(id) {
  return getRow(TABLE, id);
}

export function createLocation(body) {
  return insertRow(TABLE, body, COLUMNS);
}

export function updateLocation(id, body) {
  return updateRow(TABLE, id, body, COLUMNS, false);
}

export function deleteLocation(id) {
  return deleteRow(TABLE, id);
}
