/**
 * Unit families + conversion to a base unit within the same family.
 * Cross-family conversion is not supported (no density/etc.).
 *
 * Canonical codes are the keys of UNIT_TO_BASE. They match the frontend
 * unit picker. normalizeUnit maps spelling, case, plural, and spacing
 * aliases onto those codes. Unknown values are returned trimmed.
 * Write paths use resolveWrittenUnit / resolveBomLineUnit to reject a
 * new unknown unit while still allowing a blank unit and an unchanged
 * legacy value.
 */

const UNIT_TO_BASE = {
  ea: { family: "count", toBase: 1 },

  oz: { family: "weight_imperial", toBase: 1 },
  lb: { family: "weight_imperial", toBase: 16 },
  short_ton: { family: "weight_imperial", toBase: 32000 },

  mg: { family: "weight_metric", toBase: 1 },
  g: { family: "weight_metric", toBase: 1000 },
  kg: { family: "weight_metric", toBase: 1_000_000 },
  t: { family: "weight_metric", toBase: 1_000_000_000 },

  mm: { family: "length", toBase: 1 },
  cm: { family: "length", toBase: 10 },
  m: { family: "length", toBase: 1000 },
  ft: { family: "length", toBase: 304.8 },
  yd: { family: "length", toBase: 914.4 },

  sq_mm: { family: "area", toBase: 1 },
  sq_cm: { family: "area", toBase: 100 },
  sq_m: { family: "area", toBase: 1_000_000 },
  sq_ft: { family: "area", toBase: 92903.04 },
  sq_yd: { family: "area", toBase: 836127.36 },

  // Volume — imperial (base: fl_oz). tsp/tbsp match the frontend (US): 6 tsp = 2 tbsp = 1 fl oz.
  tsp: { family: "volume_imperial", toBase: 1 / 6 },
  tbsp: { family: "volume_imperial", toBase: 0.5 },
  fl_oz: { family: "volume_imperial", toBase: 1 },
  cup: { family: "volume_imperial", toBase: 8 },
  pt: { family: "volume_imperial", toBase: 16 },
  qt: { family: "volume_imperial", toBase: 32 },
  gal: { family: "volume_imperial", toBase: 128 },

  mL: { family: "volume_metric", toBase: 1 },
  cL: { family: "volume_metric", toBase: 10 },
  dL: { family: "volume_metric", toBase: 100 },
  L: { family: "volume_metric", toBase: 1000 },
};

/**
 * Extra spellings for each canonical code. The canonical code itself is
 * always accepted. Bare "ton" / "tons" is intentionally unmapped: it could
 * mean short_ton or metric t.
 */
const UNIT_ALIASES = {
  ea: ["each", "eaches", "pc", "pcs", "piece", "pieces"],
  oz: ["ounce", "ounces"],
  lb: ["lbs", "pound", "pounds"],
  short_ton: ["short ton", "short tons", "shortton", "us ton", "us tons"],
  mg: ["milligram", "milligrams", "milligramme", "milligrammes"],
  g: ["gram", "grams", "gramme", "grammes"],
  kg: ["kilogram", "kilograms", "kilogramme", "kilogrammes"],
  t: ["tonne", "tonnes", "metric ton", "metric tons"],
  mm: ["millimeter", "millimeters", "millimetre", "millimetres"],
  cm: ["centimeter", "centimeters", "centimetre", "centimetres"],
  m: ["meter", "meters", "metre", "metres"],
  ft: ["foot", "feet"],
  yd: ["yard", "yards"],
  sq_mm: [
    "sq mm",
    "sq. mm",
    "square mm",
    "square millimeter",
    "square millimeters",
    "square millimetre",
    "square millimetres",
    "mm2",
    "mm²",
  ],
  sq_cm: [
    "sq cm",
    "sq. cm",
    "square cm",
    "square centimeter",
    "square centimeters",
    "square centimetre",
    "square centimetres",
    "cm2",
    "cm²",
  ],
  sq_m: [
    "sq m",
    "sq. m",
    "square m",
    "square meter",
    "square meters",
    "square metre",
    "square metres",
    "m2",
    "m²",
  ],
  sq_ft: ["sq ft", "sq. ft", "square foot", "square feet", "ft2", "ft²"],
  sq_yd: ["sq yd", "sq. yd", "square yard", "square yards", "yd2", "yd²"],
  tsp: ["teaspoon", "teaspoons", "tsps"],
  tbsp: ["tablespoon", "tablespoons", "tbs", "tbsp."],
  fl_oz: [
    "floz",
    "fl oz",
    "fl. oz",
    "fl.oz",
    "fluid oz",
    "fluid ounce",
    "fluid ounces",
    "fluidounce",
  ],
  cup: ["cups"],
  pt: ["pint", "pints"],
  qt: ["quart", "quarts"],
  gal: ["gallon", "gallons", "gallon(s)"],
  mL: ["ml", "milliliter", "milliliters", "millilitre", "millilitres"],
  cL: ["cl", "centiliter", "centiliters", "centilitre", "centilitres"],
  dL: ["dl", "deciliter", "deciliters", "decilitre", "decilitres"],
  L: ["l", "liter", "liters", "litre", "litres"],
};

const ALIAS_TO_CANONICAL = new Map();

for (const canonical of Object.keys(UNIT_TO_BASE)) {
  const aliases = UNIT_ALIASES[canonical];
  if (!aliases) {
    throw new Error(`Missing alias list for canonical unit ${canonical}`);
  }
  for (const alias of [canonical, ...aliases]) {
    const key = unitAliasKey(alias);
    const previous = ALIAS_TO_CANONICAL.get(key);
    if (previous && previous !== canonical) {
      throw new Error(
        `Unit alias "${alias}" maps to both ${previous} and ${canonical}`
      );
    }
    ALIAS_TO_CANONICAL.set(key, canonical);
  }
}

export const CANONICAL_UNITS = Object.freeze(Object.keys(UNIT_TO_BASE));

/** Lookup key: trim, lowercase, drop "(s)", periods, spaces, underscores, hyphens. */
export function unitAliasKey(input) {
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/\(s\)/g, "")
    .replace(/\./g, "")
    .replace(/[\s_-]+/g, "");
}

/**
 * Map a unit to its canonical code.
 * null/blank → "". Known aliases → canonical code. Anything else → trimmed input.
 * @param {unknown} unit
 * @returns {string}
 */
export function normalizeUnit(unit) {
  if (unit == null) return "";
  const trimmed = String(unit).trim();
  if (!trimmed) return "";
  return ALIAS_TO_CANONICAL.get(unitAliasKey(trimmed)) ?? trimmed;
}

export function isCanonicalUnit(unit) {
  return Object.hasOwn(UNIT_TO_BASE, unit);
}

/** Plain-English 400 message for a unit that is not in the canonical list. */
export function unknownUnitError(unit) {
  return `Unknown unit "${unit}". Pick a unit from the list, like each, oz, lb, fl oz, cup, g, or mL.`;
}

/**
 * Decide what to store for an item unit write.
 * Blank stays blank. Aliases become canonical codes.
 * Unknown text is rejected unless `existing` is set and the value is
 * omitted or unchanged (a legacy unit already on the row).
 *
 * @param {unknown} incoming undefined means the field was omitted
 * @param {{ existing?: boolean, stored?: unknown }} [options]
 * @returns {{ ok: true, unit: string | null } | { ok: false, error: string }}
 */
export function resolveWrittenUnit(incoming, options = {}) {
  const { existing = false, stored } = options;
  if (existing && incoming === undefined) {
    return { ok: true, unit: stored == null ? null : String(stored) };
  }

  const normalized = normalizeUnit(incoming);
  if (!normalized) return { ok: true, unit: "" };
  if (isCanonicalUnit(normalized)) return { ok: true, unit: normalized };
  if (
    existing &&
    stored != null &&
    String(stored).trim() !== "" &&
    normalizeUnit(stored) === normalized
  ) {
    return { ok: true, unit: String(stored) };
  }
  return { ok: false, error: unknownUnitError(normalized) };
}

/**
 * Decide what to store for a BOM line unit.
 * A blank line keeps the component stock unit, even when that stock unit
 * is a legacy unmapped value. An explicit unknown unit is rejected unless
 * it is the same value already stored on that line.
 *
 * @param {unknown} rawLineUnit
 * @param {unknown} rawStockUnit
 * @param {unknown} [storedLineUnit]
 * @returns {{ ok: true, unit: string | null } | { ok: false, error: string }}
 */
export function resolveBomLineUnit(rawLineUnit, rawStockUnit, storedLineUnit) {
  const stockUnit = normalizeUnit(rawStockUnit);
  const explicit = rawLineUnit != null && String(rawLineUnit).trim() !== "";
  if (!explicit) {
    return { ok: true, unit: stockUnit || null };
  }

  const normalized = normalizeUnit(rawLineUnit);
  if (isCanonicalUnit(normalized)) return { ok: true, unit: normalized };
  if (
    storedLineUnit != null &&
    String(storedLineUnit).trim() !== "" &&
    normalizeUnit(storedLineUnit) === normalized
  ) {
    return { ok: true, unit: String(storedLineUnit) };
  }
  return { ok: false, error: unknownUnitError(normalized) };
}

/**
 * Classify a value already stored in the database.
 * Unmapped values keep the original string, including surrounding whitespace.
 * @param {unknown} unit
 * @returns {{ kind: "empty" } | { kind: "canonical", value: string } | { kind: "alias", value: string } | { kind: "unmapped", value: string }}
 */
export function classifyStoredUnit(unit) {
  if (unit == null) return { kind: "empty" };
  const raw = String(unit);
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "empty" };
  const canonical = ALIAS_TO_CANONICAL.get(unitAliasKey(trimmed));
  if (!canonical) return { kind: "unmapped", value: raw };
  if (raw === canonical) return { kind: "canonical", value: canonical };
  return { kind: "alias", value: canonical };
}

export function getUnitFamily(unit) {
  const meta = UNIT_TO_BASE[normalizeUnit(unit)];
  return meta?.family ?? null;
}

export function unitsAreCompatible(fromUnit, toUnit) {
  const from = normalizeUnit(fromUnit);
  const to = normalizeUnit(toUnit);
  if (!from || !to) return false;
  if (from === to) return true;
  const a = getUnitFamily(from);
  const b = getUnitFamily(to);
  return Boolean(a && b && a === b);
}

export function convertQuantity(quantity, fromUnit, toUnit) {
  const qty = Number(quantity);
  if (!Number.isFinite(qty)) return null;

  const from = normalizeUnit(fromUnit);
  const to = normalizeUnit(toUnit);
  if (!from || !to) return null;
  if (from === to) return qty;

  const fromMeta = UNIT_TO_BASE[from];
  const toMeta = UNIT_TO_BASE[to];
  if (!fromMeta || !toMeta || fromMeta.family !== toMeta.family) {
    return null;
  }
  if (toMeta.toBase === 0) return null;
  return (qty * fromMeta.toBase) / toMeta.toBase;
}

export function bomQuantityInStockUnit(lineQuantity, lineUnit, stockUnit) {
  const qty = Number(lineQuantity);
  if (!Number.isFinite(qty)) return null;

  const stock = normalizeUnit(stockUnit);
  const line = normalizeUnit(lineUnit);

  if (!line || !stock || line === stock) return qty;

  return convertQuantity(qty, line, stock);
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** Postgres expression matching unitAliasKey(). */
export function sqlUnitAliasKey(column) {
  return `lower(regexp_replace(regexp_replace(regexp_replace(btrim(${column}), '\\(s\\)', '', 'gi'), '\\.', '', 'g'), '[\\s_-]+', '', 'g'))`;
}

/**
 * Idempotent UPDATE that rewrites known spellings to canonical codes and
 * leaves everything else unchanged.
 */
export function sqlNormalizeUnitColumn(table, column = "unit_of_measure") {
  const byCanonical = new Map();
  for (const [key, canonical] of ALIAS_TO_CANONICAL) {
    const keys = byCanonical.get(canonical) ?? [];
    keys.push(key);
    byCanonical.set(canonical, keys);
  }

  const whens = CANONICAL_UNITS.map((canonical) => {
    const keys = [...new Set(byCanonical.get(canonical) ?? [])].sort();
    return `WHEN ${sqlUnitAliasKey(column)} IN (${keys.map(sqlLiteral).join(", ")}) THEN ${sqlLiteral(canonical)}`;
  });

  const caseExpr = `CASE\n    ${whens.join("\n    ")}\n    ELSE ${column}\n  END`;
  return `UPDATE ${table}\nSET ${column} = ${caseExpr}\nWHERE ${column} IS NOT NULL\n  AND ${column} IS DISTINCT FROM ${caseExpr};`;
}

export function sqlUnmappedUnits(table, column = "unit_of_measure") {
  const keys = [...ALIAS_TO_CANONICAL.keys()].sort().map(sqlLiteral).join(", ");
  return `SELECT ${sqlLiteral(table)} AS table_name, ${column} AS unit, COUNT(*)::int AS rows\nFROM ${table}\nWHERE ${column} IS NOT NULL\n  AND btrim(${column}) <> ''\n  AND ${sqlUnitAliasKey(column)} NOT IN (${keys})\nGROUP BY ${column}\nORDER BY ${column};`;
}
