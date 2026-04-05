import {
  deleteRow,
  getRow,
  insertRow,
  listRows,
  updateRow,
} from "../lib/tableCrud.js";

const TABLE = "job_components";
const COLUMNS = ["job_id", "item_id", "quantity_allocated", "unit_of_measure"];

export function listJobComponents() {
  return listRows(TABLE);
}

export function getJobComponentById(id) {
  return getRow(TABLE, id);
}

export function createJobComponent(body) {
  return insertRow(TABLE, body, COLUMNS);
}

export function updateJobComponent(id, body) {
  return updateRow(TABLE, id, body, COLUMNS, false);
}

export function deleteJobComponent(id) {
  return deleteRow(TABLE, id);
}
