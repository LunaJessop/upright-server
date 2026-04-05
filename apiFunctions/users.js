import {
  deleteRow,
  getRow,
  insertRow,
  listRows,
  updateRow,
} from "../lib/tableCrud.js";

const TABLE = "users";
const COLUMNS = [
  "organization_id",
  "name",
  "email",
  "password_hash",
  "role",
  "active",
];

export function listUsers() {
  return listRows(TABLE);
}

export function getUserById(id) {
  return getRow(TABLE, id);
}

export function createUser(body) {
  return insertRow(TABLE, body, COLUMNS);
}

export function updateUser(id, body) {
  return updateRow(TABLE, id, body, COLUMNS, true);
}

export function deleteUser(id) {
  return deleteRow(TABLE, id);
}
