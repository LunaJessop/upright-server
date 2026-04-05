import {
  deleteRow,
  getRow,
  insertRow,
  listRows,
  updateRow,
} from "../lib/tableCrud.js";

const TABLE = "jobs";
const COLUMNS = [
  "organization_id",
  "item_id",
  "bom_id",
  "quantity",
  "status",
  "start_date",
  "end_date",
  "created_by",
  "updated_by",
];

export function listJobs() {
  return listRows(TABLE);
}

export function getJobById(id) {
  return getRow(TABLE, id);
}

export function createJob(body) {
  return insertRow(TABLE, body, COLUMNS);
}

export function updateJob(id, body) {
  return updateRow(TABLE, id, body, COLUMNS, true);
}

export function deleteJob(id) {
  return deleteRow(TABLE, id);
}
