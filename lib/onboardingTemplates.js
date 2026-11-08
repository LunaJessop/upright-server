/**
 * Starter shops for a new handmaker. Defined in code so setup does not need
 * a migration. Units are canonical codes from lib/units.js.
 */
const TEMPLATES = [
  {
    key: "soap",
    name: "Soap and cosmetics",
    description: "Oils, lye, and a small-batch soap day.",
    phases: [
      { name: "Melt oils", description: "Weigh and melt the oils.", estimated_minutes: 40 },
      { name: "Blend", description: "Add lye and blend to trace.", estimated_minutes: 20 },
      { name: "Pour", description: "Pour into molds and insulate.", estimated_minutes: 15 },
      { name: "Unmold and cut", description: "Unmold, cut, and stamp.", estimated_minutes: 30 },
      { name: "Label", description: "Label after the cure.", estimated_minutes: 20 },
    ],
    items: [
      { name: "Olive oil", unit_of_measure: "fl_oz", description: "Liquid oil for the base." },
      { name: "Coconut oil", unit_of_measure: "oz", description: "Hard oil." },
      { name: "Sodium hydroxide", unit_of_measure: "oz", description: "Lye." },
      { name: "Distilled water", unit_of_measure: "fl_oz", description: "Water for the lye solution." },
      { name: "Essential oil", unit_of_measure: "fl_oz", description: "Scent." },
    ],
  },
  {
    key: "candles",
    name: "Candles",
    description: "Wax, wicks, and jars.",
    phases: [
      { name: "Prep jars", description: "Set wicks and warm the jars.", estimated_minutes: 20 },
      { name: "Melt wax", description: "Melt the wax to pouring temperature.", estimated_minutes: 40 },
      { name: "Fragrance and pour", description: "Add fragrance and pour.", estimated_minutes: 25 },
      { name: "Finish", description: "Trim wicks and label.", estimated_minutes: 15 },
    ],
    items: [
      { name: "Soy wax", unit_of_measure: "oz", description: "Container wax." },
      { name: "Cotton wicks", unit_of_measure: "ea", description: "One wick per candle." },
      { name: "Fragrance oil", unit_of_measure: "fl_oz", description: "Candle scent." },
      { name: "Jars", unit_of_measure: "ea", description: "Empty candle jars." },
    ],
  },
  {
    key: "baked",
    name: "Baked goods",
    description: "A short bake from mix to pack.",
    phases: [
      { name: "Mix", description: "Scale and mix the dough or batter.", estimated_minutes: 20 },
      { name: "Shape", description: "Portion and pan.", estimated_minutes: 15 },
      { name: "Bake", description: "Bake and check doneness.", estimated_minutes: 45 },
      { name: "Cool and pack", description: "Cool, then bag or box.", estimated_minutes: 20 },
    ],
    items: [
      { name: "Flour", unit_of_measure: "oz", description: "All-purpose or bread flour." },
      { name: "Butter", unit_of_measure: "oz", description: "Fat for the formula." },
      { name: "Sugar", unit_of_measure: "oz", description: "Sweetener." },
      { name: "Eggs", unit_of_measure: "ea", description: "Whole eggs." },
    ],
  },
  {
    key: "jewelry",
    name: "Jewelry",
    description: "Findings and a bench sequence.",
    phases: [
      { name: "Design", description: "Sketch the piece and pull materials.", estimated_minutes: 30 },
      { name: "Fabricate", description: "Form, solder, or assemble.", estimated_minutes: 60 },
      { name: "Finish", description: "File, polish, and inspect.", estimated_minutes: 30 },
      { name: "Tag", description: "Photograph and tag for sale.", estimated_minutes: 20 },
    ],
    items: [
      { name: "Jump rings", unit_of_measure: "ea", description: "Connectors." },
      { name: "Ear wires", unit_of_measure: "ea", description: "Earring findings." },
      { name: "Chain", unit_of_measure: "ft", description: "Chain by length." },
      { name: "Beads", unit_of_measure: "ea", description: "Beads or stones." },
    ],
  },
  {
    key: "textiles",
    name: "Textiles and sewing",
    description: "Cut, sew, and finish a sewn piece.",
    phases: [
      { name: "Cut", description: "Mark and cut the pieces.", estimated_minutes: 30 },
      { name: "Sew", description: "Sew the main seams.", estimated_minutes: 60 },
      { name: "Press", description: "Press seams and shape.", estimated_minutes: 15 },
      { name: "Finish", description: "Closures, trim, and label.", estimated_minutes: 20 },
    ],
    items: [
      { name: "Fabric", unit_of_measure: "sq_ft", description: "Main fabric." },
      { name: "Thread", unit_of_measure: "ea", description: "Spool of thread." },
      { name: "Elastic", unit_of_measure: "ft", description: "Elastic by length." },
      { name: "Buttons", unit_of_measure: "ea", description: "Buttons or snaps." },
    ],
  },
  {
    key: "generic",
    name: "Generic workshop",
    description: "A plain prep, make, finish, and pack day.",
    phases: [
      { name: "Prep", description: "Gather tools and materials.", estimated_minutes: 15 },
      { name: "Make", description: "Do the main work.", estimated_minutes: 45 },
      { name: "Finish", description: "Clean up the piece.", estimated_minutes: 20 },
      { name: "Pack", description: "Pack it for sale or shipping.", estimated_minutes: 15 },
    ],
    items: [
      { name: "Main material", unit_of_measure: "ea", description: "The thing you use most." },
      { name: "Packaging", unit_of_measure: "ea", description: "Bags, boxes, or mailers." },
      { name: "Labels", unit_of_measure: "ea", description: "Product labels." },
    ],
  },
];

export const ONBOARDING_TEMPLATES = Object.freeze(
  TEMPLATES.map((template) => Object.freeze({
    ...template,
    phases: Object.freeze(template.phases.map((phase) => Object.freeze({ ...phase }))),
    items: Object.freeze(template.items.map((item) => Object.freeze({ ...item }))),
  }))
);

export function onboardingTemplate(key) {
  const wanted = String(key ?? "").trim().toLowerCase();
  return ONBOARDING_TEMPLATES.find((template) => template.key === wanted) ?? null;
}

export function publicOnboardingTemplates() {
  return ONBOARDING_TEMPLATES.map((template) => ({
    key: template.key,
    name: template.name,
    description: template.description,
    phases: template.phases.map((phase) => ({ ...phase })),
    items: template.items.map((item) => ({ ...item })),
  }));
}
