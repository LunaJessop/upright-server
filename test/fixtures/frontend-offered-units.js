/**
 * Units the Upright frontend offers in item and BOM unit pickers.
 *
 * Copied from https://github.com/LunaJessop/upright @ eb2f30d
 * ("added more fluid units of measurement"):
 *   - values: app/items/unitOfMeasureOptions.js
 *   - family and toBase: lib/units.js
 *
 * When the frontend adds or changes a unit, update this fixture and
 * lib/units.js together. test/units.test.js fails if the server map
 * is missing any unit listed here.
 */
export const FRONTEND_OFFERED_UNITS = [
  { value: "ea", family: "count", toBase: 1 },

  { value: "oz", family: "weight_imperial", toBase: 1 },
  { value: "lb", family: "weight_imperial", toBase: 16 },
  { value: "short_ton", family: "weight_imperial", toBase: 32000 },

  { value: "mg", family: "weight_metric", toBase: 1 },
  { value: "g", family: "weight_metric", toBase: 1000 },
  { value: "kg", family: "weight_metric", toBase: 1_000_000 },
  { value: "t", family: "weight_metric", toBase: 1_000_000_000 },

  { value: "yd", family: "length", toBase: 914.4 },
  { value: "ft", family: "length", toBase: 304.8 },
  { value: "m", family: "length", toBase: 1000 },
  { value: "cm", family: "length", toBase: 10 },
  { value: "mm", family: "length", toBase: 1 },

  { value: "sq_yd", family: "area", toBase: 836127.36 },
  { value: "sq_ft", family: "area", toBase: 92903.04 },
  { value: "sq_m", family: "area", toBase: 1_000_000 },
  { value: "sq_cm", family: "area", toBase: 100 },
  { value: "sq_mm", family: "area", toBase: 1 },

  { value: "tsp", family: "volume_imperial", toBase: 1 / 6 },
  { value: "tbsp", family: "volume_imperial", toBase: 0.5 },
  { value: "fl_oz", family: "volume_imperial", toBase: 1 },
  { value: "cup", family: "volume_imperial", toBase: 8 },
  { value: "pt", family: "volume_imperial", toBase: 16 },
  { value: "qt", family: "volume_imperial", toBase: 32 },
  { value: "gal", family: "volume_imperial", toBase: 128 },

  { value: "mL", family: "volume_metric", toBase: 1 },
  { value: "cL", family: "volume_metric", toBase: 10 },
  { value: "dL", family: "volume_metric", toBase: 100 },
  { value: "L", family: "volume_metric", toBase: 1000 },
];
