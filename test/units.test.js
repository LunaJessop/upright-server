import assert from "node:assert/strict";
import test from "node:test";
import {
  bomQuantityInStockUnit,
  convertQuantity,
  getUnitFamily,
  normalizeUnit,
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
  assert.equal(unitsAreCompatible("tbsp", "mL"), true);

  // 6 tsp = 2 tbsp = 1 fl oz; 3 tsp = 1 tbsp.
  assert.equal(convertQuantity(1, "tsp", "fl_oz"), 1 / 6);
  assert.equal(convertQuantity(1, "tbsp", "fl_oz"), 0.5);
  assert.equal(bomQuantityInStockUnit(6, "tsp", "fl_oz"), 1);
  assert.equal(bomQuantityInStockUnit(2, "tbsp", "fl_oz"), 1);
  assert.equal(bomQuantityInStockUnit(3, "tsp", "tbsp"), 1);
  assert.equal(bomQuantityInStockUnit(1, "tbsp", "tsp"), 3);
});

test("normalizeUnit maps aliases onto the canonical code and leaves unknown text trimmed", () => {
  assert.equal(normalizeUnit(null), "");
  assert.equal(normalizeUnit(undefined), "");
  assert.equal(normalizeUnit("   "), "");

  assert.equal(normalizeUnit("ea"), "ea");
  assert.equal(normalizeUnit(" each "), "ea");
  assert.equal(normalizeUnit("pieces"), "ea");

  assert.equal(normalizeUnit("oz"), "oz");
  assert.equal(normalizeUnit("ounces"), "oz");
  assert.equal(normalizeUnit("lb"), "lb");
  assert.equal(normalizeUnit("lbs"), "lb");
  assert.equal(normalizeUnit("Pounds"), "lb");

  assert.equal(normalizeUnit("g"), "g");
  assert.equal(normalizeUnit("grams"), "g");
  assert.equal(normalizeUnit("kg"), "kg");
  assert.equal(normalizeUnit("kilograms"), "kg");

  assert.equal(normalizeUnit("tsp"), "tsp");
  assert.equal(normalizeUnit("teaspoons"), "tsp");
  assert.equal(normalizeUnit("tbsp"), "tbsp");
  assert.equal(normalizeUnit("Tbsp"), "tbsp");
  assert.equal(normalizeUnit("tablespoons"), "tbsp");

  assert.equal(normalizeUnit("fl_oz"), "fl_oz");
  assert.equal(normalizeUnit("fl oz"), "fl_oz");
  assert.equal(normalizeUnit("floz"), "fl_oz");
  assert.equal(normalizeUnit("FL. OZ."), "fl_oz");
  assert.equal(normalizeUnit("fluid ounces"), "fl_oz");

  assert.equal(normalizeUnit("gal"), "gal");
  assert.equal(normalizeUnit("gallon"), "gal");
  assert.equal(normalizeUnit("gallons"), "gal");
  assert.equal(normalizeUnit("gallon(s)"), "gal");

  assert.equal(normalizeUnit("mL"), "mL");
  assert.equal(normalizeUnit("ml"), "mL");
  assert.equal(normalizeUnit("ML"), "mL");
  assert.equal(normalizeUnit("milliliters"), "mL");
  assert.equal(normalizeUnit("L"), "L");
  assert.equal(normalizeUnit("l"), "L");
  assert.equal(normalizeUnit("liters"), "L");
  assert.equal(normalizeUnit("cL"), "cL");
  assert.equal(normalizeUnit("dL"), "dL");

  assert.equal(normalizeUnit("sq ft"), "sq_ft");
  assert.equal(normalizeUnit("square feet"), "sq_ft");
  assert.equal(normalizeUnit("short ton"), "short_ton");

  assert.equal(normalizeUnit("  Custom Box  "), "Custom Box");
  assert.equal(normalizeUnit("ton"), "ton");

  for (const unit of FRONTEND_OFFERED_UNITS) {
    assert.equal(
      normalizeUnit(unit.value),
      unit.value,
      `frontend picker value ${unit.value} should already be canonical`
    );
  }
});

test("alias spelling uses the same conversion factors as the canonical code", () => {
  assert.equal(convertQuantity(1, "gallon", "fl oz"), 128);
  assert.equal(convertQuantity(1, "Tbsp", "floz"), 0.5);
  assert.equal(convertQuantity(2, "lbs", "oz"), 32);
  assert.equal(bomQuantityInStockUnit(6, "teaspoons", "fluid ounce"), 1);
  assert.equal(unitsAreCompatible("mL", "liters"), true);
  assert.equal(unitsAreCompatible("tbsp", "ml"), true);
  assert.equal(getUnitFamily("FL OZ"), "volume_imperial");
});

test("weight converts between metric and imperial without disturbing count or volume", () => {
  // 1 lb = 0.45359237 kg exactly, which displays as 453.592 g.
  assert.equal(convertQuantity(1, "lb", "g").toFixed(3), "453.592");
  assert.ok(Math.abs(convertQuantity(1, "lb", "g") - 453.59237) < 1e-6);
  // 1 kg = 2.20462 lb at five decimal places.
  assert.equal(convertQuantity(1, "kg", "lb").toFixed(5), "2.20462");
  assert.equal(convertQuantity(16, "oz", "lb"), 1);
  assert.equal(convertQuantity(1, "lb", "oz"), 16);
  assert.equal(unitsAreCompatible("g", "oz"), true);
  assert.equal(unitsAreCompatible("kg", "lb"), true);
  assert.equal(unitsAreCompatible("mg", "short_ton"), true);
  assert.equal(unitsAreCompatible("g", "mL"), false);
  assert.equal(unitsAreCompatible("oz", "fl_oz"), false);
  assert.equal(unitsAreCompatible("ea", "g"), false);
  assert.equal(unitsAreCompatible("ea", "oz"), false);
  assert.equal(convertQuantity(1, "g", "mL"), null);
  assert.equal(convertQuantity(1, "lb", "gal"), null);
  assert.equal(bomQuantityInStockUnit(1, "ea", "g"), null);

  const backToPounds = convertQuantity(convertQuantity(1, "lb", "g"), "g", "lb");
  assert.ok(Math.abs(backToPounds - 1) < 1e-9);
  const backToGrams = convertQuantity(convertQuantity(1000, "g", "oz"), "oz", "g");
  assert.ok(Math.abs(backToGrams - 1000) < 1e-6);
});

test("US volume converts between metric and imperial", () => {
  // 1 fl oz = 29.5735295625 mL, which displays as 29.5735 mL.
  assert.equal(convertQuantity(1, "fl_oz", "mL").toFixed(4), "29.5735");
  // 1 gal = 3785.411784 mL, which displays as 3785.41 mL.
  assert.equal(convertQuantity(1, "gal", "mL").toFixed(2), "3785.41");
  assert.equal(convertQuantity(1, "gal", "fl_oz"), 128);
  assert.equal(convertQuantity(1, "L", "mL"), 1000);
  assert.equal(unitsAreCompatible("mL", "fl_oz"), true);
  assert.equal(unitsAreCompatible("L", "gal"), true);
  assert.equal(unitsAreCompatible("tsp", "L"), true);
  assert.equal(unitsAreCompatible("cup", "g"), false);
  assert.equal(convertQuantity(1, "mL", "oz"), null);

  const oneFlOz = convertQuantity(convertQuantity(1, "fl_oz", "mL"), "mL", "fl_oz");
  assert.ok(Math.abs(oneFlOz - 1) < 1e-9);
  const oneGallon = convertQuantity(convertQuantity(1, "gal", "L"), "L", "gal");
  assert.ok(Math.abs(oneGallon - 1) < 1e-9);
  // 6 tsp is still exactly 1 fl oz; the metric bridge does not change that.
  assert.equal(bomQuantityInStockUnit(6, "tsp", "fl_oz"), 1);
  assert.ok(
    Math.abs(bomQuantityInStockUnit(29.5735295625, "mL", "fl_oz") - 1) < 1e-9
  );
});
