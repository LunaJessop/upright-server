import assert from "node:assert/strict";
import test from "node:test";
import {
  bomQuantityInStockUnit,
  convertQuantity,
  getUnitFamily,
  unitsAreCompatible,
} from "../lib/units.js";
import { FRONTEND_OFFERED_UNITS } from "./fixtures/frontend-offered-units.js";

function baseUnitFor(family) {
  const base = FRONTEND_OFFERED_UNITS.find(
    (unit) => unit.family === family && unit.toBase === 1
  );
  assert.ok(base, `fixture has no base unit for family ${family}`);
  return base.value;
}

test("server unit map contains every unit the frontend offers", () => {
  for (const unit of FRONTEND_OFFERED_UNITS) {
    assert.equal(
      getUnitFamily(unit.value),
      unit.family,
      `frontend unit "${unit.value}" is missing from the server map or in the wrong family`
    );
  }
});

test("server conversion factors match the frontend unit map", () => {
  for (const unit of FRONTEND_OFFERED_UNITS) {
    const base = baseUnitFor(unit.family);
    assert.equal(
      convertQuantity(1, unit.value, base),
      unit.toBase,
      `${unit.value} -> ${base}`
    );
  }
});

test("tsp and tbsp are fluid-ounce units and convert in US measures", () => {
  assert.equal(getUnitFamily("tsp"), "volume_imperial");
  assert.equal(getUnitFamily("tbsp"), "volume_imperial");
  assert.equal(unitsAreCompatible("tsp", "fl_oz"), true);
  assert.equal(unitsAreCompatible("tbsp", "fl_oz"), true);
  assert.equal(unitsAreCompatible("tsp", "cup"), true);
  assert.equal(unitsAreCompatible("tbsp", "mL"), false);

  // 6 tsp = 2 tbsp = 1 fl oz; 3 tsp = 1 tbsp.
  assert.equal(convertQuantity(1, "tsp", "fl_oz"), 1 / 6);
  assert.equal(convertQuantity(1, "tbsp", "fl_oz"), 0.5);
  assert.equal(bomQuantityInStockUnit(6, "tsp", "fl_oz"), 1);
  assert.equal(bomQuantityInStockUnit(2, "tbsp", "fl_oz"), 1);
  assert.equal(bomQuantityInStockUnit(3, "tsp", "tbsp"), 1);
  assert.equal(bomQuantityInStockUnit(1, "tbsp", "tsp"), 3);
});
