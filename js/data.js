// ============================================================
//  DATA.JS — Static game data
// ============================================================

const RARITY = { C: 0, U: 1, R: 2, E: 3, L: 4 };

const PLANTS = {
  "Dandelion of Qi":         { score: [12],  rarity: "C", family: "SPIRIT" },
  "Basic Herb":              { score: [19],  rarity: "C", family: "VITALITY" },
  "Common Spirit Grass":     { score: [19],  rarity: "C", family: "AGILITY" },
  "Wild Bitter Grass":       { score: [25],  rarity: "U", family: "ENDURANCE" },
  "Mountain Green Herb":     { score: [50],  rarity: "U", family: "ENDURANCE" },
  "Wild Spirit Grass":       { score: [62],  rarity: "U", family: "SPIRIT" },
  "Red Ginseng":             { score: [69],  rarity: "U", family: "VITALITY" },
  "Healing Sunflower":       { score: [74],  rarity: "U", family: "VITALITY" },
  "Spirit Spring Herb":      { score: [77],  rarity: "R", family: "SPIRIT" },
  "Cloud Mist Herb":         { score: [80, 81],  rarity: "R", family: "AGILITY" },
  "Seven Star Flower":       { score: [81],  rarity: "R", family: "SPIRIT" },
  "Ironbone Grass":          { score: [82, 83],  rarity: "R", family: "ENDURANCE" },
  "Bitter Jade Grass":       { score: [84],  rarity: "R", family: "VITALITY" },
  "Silverleaf Herb":         { score: [85],  rarity: "E", family: "AGILITY" },
  "Purple Lightning Orchid": { score: [91],  rarity: "E", family: "AGILITY" },
  "Azure Serpent Grass":     { score: [91],  rarity: "E", family: "AGILITY" },
  "Blue Wave Coral Herb":    { score: [92],  rarity: "E", family: "SPIRIT" },
  "Crimson Flame Mushroom":  { score: [93],  rarity: "E", family: "ENDURANCE" },
  "Black Iron Root":         { score: [94],  rarity: "E", family: "ENDURANCE" },
  "Heavenly Spirit Vine":    { score: [96],  rarity: "L", family: "AGILITY" },
  "Moonlight Jade Leaf":     { score: [97, 98],  rarity: "L", family: "ENDURANCE" },
  "Nine Suns Flame Grass":   { score: [97],  rarity: "L", family: "ENDURANCE" },
  "Starlight Dew Herb":      { score: [98, 99],  rarity: "L", family: "SPIRIT" },
  "Thousand Year Lotus":     { score: [100], rarity: "L", family: "SPIRIT" },
};

// Effects structure: array of { stat, pct, permanent, duration }
// duration in seconds, 0 = permanent
// stat values: QiMulti, Speed, Vitality, Strength, Lifespan
const RECIPES = [
  {
    name: "Qi Gathering Pill",
    ingredients: { "Common Spirit Grass": 3, "Bitter Jade Grass": 1, "Wild Spirit Grass": 2 },
    effects: [{ stat: "QiMulti", pct: 5, duration: 300 }]
  },
  {
    name: "Minor Healing Pill",
    ingredients: { "Healing Sunflower": 2, "Wild Bitter Grass": 3, "Mountain Green Herb": 1 },
    effects: [{ stat: "Vitality", pct: 3, duration: 120 }]
  },
  {
    name: "Focus Pill",
    ingredients: { "Basic Herb": 6 },
    effects: [{ stat: "QiMulti", pct: 8, duration: 300 }]
  },
  {
    name: "Lesser Swiftfoot Pill",
    ingredients: { "Common Spirit Grass": 3, "Azure Serpent Grass": 1, "Wild Spirit Grass": 2 },
    effects: [{ stat: "Speed", pct: 5, duration: 300 }]
  },
  {
    name: "Endurance Pill",
    ingredients: { "Mountain Green Herb": 6 },
    effects: [{ stat: "Vitality", pct: 8, duration: 600 }]
  },
  {
    name: "Ginseng Recovery Pill",
    ingredients: { "Red Ginseng": 6 },
    effects: [{ stat: "Vitality", pct: 4, duration: 240 }]
  },
  {
    name: "Qi Infusion Pill",
    ingredients: { "Dandelion of Qi": 6 },
    effects: [{ stat: "QiMulti", pct: 5, duration: 300 }]
  },
  {
    name: "Wild Vitality Pill",
    ingredients: { "Wild Spirit Grass": 6 },
    effects: [{ stat: "Vitality", pct: 8, duration: 300 }]
  },
  {
    name: "Bitter Endurance Pill",
    ingredients: { "Wild Bitter Grass": 6 },
    effects: [{ stat: "Vitality", pct: 5, duration: 600 }]
  },
  {
    name: "Spirit Growth Pill",
    ingredients: { "Common Spirit Grass": 6 },
    effects: [{ stat: "QiMulti", pct: 4, duration: 600 }]
  },
  {
    name: "Healing Sun Pill",
    ingredients: { "Healing Sunflower": 6 },
    effects: [{ stat: "Vitality", pct: 6, duration: 1800 }]
  },
  {
    name: "Longevity Restoration Pill",
    ingredients: { "Healing Sunflower": 3, "Wild Bitter Grass": 2, "Common Spirit Grass": 1 },
    effects: [{ stat: "Lifespan", pct: 1, duration: 0 }]
  },
  {
    name: "Emerald Vitality Pill",
    ingredients: { "Dandelion of Qi": 1, "Common Spirit Grass": 1, "Mountain Green Herb": 1, "Red Ginseng": 3 },
    effects: [{ stat: "Lifespan", pct: 3, duration: 0 }]
  },
  {
    name: "Celestial Youth Pill",
    ingredients: { "Silverleaf Herb": 6 },
    effects: [{ stat: "Lifespan", pct: 5, duration: 0 }]
  },
  {
    name: "Fury Pill",
    ingredients: { "Silverleaf Herb": 2, "Ironbone Grass": 2, "Crimson Flame Mushroom": 2 },
    effects: [{ stat: "Strength", pct: 25, duration: 300 }, { stat: "Speed", pct: 15, duration: 300 }]
  },
  {
    name: "Iron Blood Pill",
    ingredients: { "Black Iron Root": 2, "Silverleaf Herb": 1, "Ironbone Grass": 3 },
    effects: [{ stat: "Vitality", pct: 5, duration: 300 }]
  },
  {
    name: "Bird Pill",
    ingredients: { "Azure Serpent Grass": 2, "Purple Lightning Orchid": 1, "Cloud Mist Herb": 2, "Wild Spirit Grass": 1 },
    effects: [{ stat: "Speed", pct: 40, duration: 300 }]
  },
  {
    name: "Stone Skin Pill",
    ingredients: { "Black Iron Root": 6 },
    effects: [{ stat: "Vitality", pct: 15, duration: 900 }]
  },
  {
    name: "Azure Agility Pill",
    ingredients: { "Azure Serpent Grass": 6 },
    effects: [{ stat: "Speed", pct: 35, duration: 300 }]
  },
  {
    name: "MoonLight Serenity Pill",
    ingredients: { "Moonlight Jade Leaf": 6 },
    effects: [{ stat: "QiMulti", pct: 30, duration: 600 }]
  },
  {
    name: "Flame Burst Pill",
    ingredients: { "Crimson Flame Mushroom": 6 },
    effects: [{ stat: "Strength", pct: 25, duration: 480 }]
  },
  {
    name: "Coral Flow Pill",
    ingredients: { "Blue Wave Coral Herb": 6 },
    effects: [{ stat: "Speed", pct: 20, duration: 480 }, { stat: "QiMulti", pct: 10, duration: 480 }]
  },
  {
    name: "Spirit Surge Pill",
    ingredients: { "Spirit Spring Herb": 6 },
    effects: [{ stat: "QiMulti", pct: 25, duration: 600 }]
  },
  {
    name: "Cloudstep Pill",
    ingredients: { "Cloud Mist Herb": 6 },
    effects: [{ stat: "Speed", pct: 30, duration: 480 }]
  },
  {
    name: "Blood Revival Pill",
    ingredients: { "Healing Sunflower": 3, "Red Ginseng": 1, "Wild Spirit Grass": 2 },
    effects: [{ stat: "Vitality", pct: 10, duration: 1800 }]
  },
  {
    name: "Soul Replenishing Pill",
    ingredients: { "Healing Sunflower": 3, "Ironbone Grass": 1, "Blue Wave Coral Herb": 1, "Mountain Green Herb": 1 },
    effects: [{ stat: "Lifespan", pct: 10, duration: 0 }]
  },
  {
    name: "Dragon Essence Pill",
    ingredients: { "Azure Serpent Grass": 2, "Moonlight Jade Leaf": 2, "Cloud Mist Herb": 1, "Nine Suns Flame Grass": 1 },
    effects: [{ stat: "Lifespan", pct: 20, duration: 0 }]
  },
  {
    name: "Immortal Vein Pill",
    ingredients: { "Thousand Year Lotus": 5, "Azure Serpent Grass": 1 },
    effects: [{ stat: "Lifespan", pct: 25, duration: 0 }]
  },
  {
    name: "Ironbone Pill",
    ingredients: { "Black Iron Root": 2, "Crimson Flame Mushroom": 1, "Ironbone Grass": 3 },
    effects: [{ stat: "Strength", pct: 25, duration: 1500 }, { stat: "Vitality", pct: 80, duration: 1500 }]
  },
  {
    name: "Azure Serpent Pill",
    ingredients: { "Azure Serpent Grass": 3, "Moonlight Jade Leaf": 1, "Blue Wave Coral Herb": 2 },
    effects: [{ stat: "Speed", pct: 200, duration: 1800 }, { stat: "QiMulti", pct: 30, duration: 1800 }]
  },
  {
    name: "Cloud Mist Qi Pill",
    ingredients: { "Moonlight Jade Leaf": 2, "Cloud Mist Herb": 2, "Spirit Spring Herb": 2 },
    effects: [{ stat: "QiMulti", pct: 50, duration: 2100 }]
  },
  {
    name: "Mountain Force Pill",
    ingredients: { "Black Iron Root": 2, "Ironbone Grass": 2, "Mountain Green Herb": 2 },
    effects: [{ stat: "Strength", pct: 8, duration: 0 }]
  },
  {
    name: "Stone Vein Pill",
    ingredients: { "Black Iron Root": 2, "Silverleaf Herb": 1, "Mountain Green Herb": 1, "Ironbone Grass": 2 },
    effects: [{ stat: "Vitality", pct: 3, duration: 0 }]
  },
  {
    name: "Phantom Step Pill",
    ingredients: { "Azure Serpent Grass": 1, "Purple Lightning Orchid": 2, "Cloud Mist Herb": 2, "Silverleaf Herb": 1 },
    effects: [{ stat: "Speed", pct: 40, duration: 300 }]
  },
  {
    name: "Death Pill",
    ingredients: { "Heavenly Spirit Vine": 1, "Cloud Mist Herb": 1, "Nine Suns Flame Grass": 1, "Silverleaf Herb": 1, "Wild Bitter Grass": 1, "Bitter Jade Grass": 1 },
    effects: [{ stat: "DEATH", pct: 0, duration: 0 }]
  },
  {
    name: "Thunderstrike Pill",
    ingredients: { "Purple Lightning Orchid": 6 },
    effects: [{ stat: "Strength", pct: 50, duration: 300 }, { stat: "Speed", pct: 20, duration: 300 }]
  },
  {
    name: "Nine Suns Yang Pill",
    ingredients: { "Nine Suns Flame Grass": 6 },
    effects: [{ stat: "Strength", pct: 100, duration: 900 }]
  },
  {
    name: "Lotus Nirvana Pill",
    ingredients: { "Thousand Year Lotus": 6 },
    effects: [{ stat: "Vitality", pct: 100, duration: 1200 }, { stat: "QiMulti", pct: 50, duration: 1200 }]
  },
  {
    name: "Heavenly Vine Pill",
    ingredients: { "Heavenly Spirit Vine": 6 },
    effects: [{ stat: "QiMulti", pct: 60, duration: 900 }]
  },
  {
    name: "Starlight Mind Pill",
    ingredients: { "Starlight Dew Herb": 6 },
    effects: [{ stat: "QiMulti", pct: 40, duration: 900 }]
  },
  {
    name: "Nine Yang Pill",
    ingredients: { "Nine Suns Flame Grass": 2, "Purple Lightning Orchid": 1, "Black Iron Root": 2, "Crimson Flame Mushroom": 1 },
    effects: [{ stat: "Strength", pct: 100, duration: 1800 }, { stat: "QiMulti", pct: 120, duration: 1800 }]
  },
  {
    name: "Concentration Pill",
    ingredients: { "Starlight Dew Herb": 3, "Azure Serpent Grass": 3 },
    effects: [{ stat: "QiMulti", pct: 200, duration: 2700 }]
  },
  {
    name: "Seven Star Enlightenment Pill",
    ingredients: { "Seven Star Flower": 1, "Starlight Dew Herb": 4, "Heavenly Spirit Vine": 1 },
    effects: [{ stat: "QiMulti", pct: 250, duration: 3600 }]
  },
  {
    name: "Dragon Pulse Pill",
    ingredients: { "Blue Wave Coral Herb": 2, "Cloud Mist Herb": 1, "Spirit Spring Herb": 1, "Ironbone Grass": 2 },
    effects: [{ stat: "Strength", pct: 110, duration: 1500 }, { stat: "QiMulti", pct: 160, duration: 1500 }]
  },
  {
    name: "Phoenix Ember Pill",
    ingredients: { "Mountain Green Herb": 1, "Seven Star Flower": 2, "Silverleaf Herb": 1, "Crimson Flame Mushroom": 2 },
    effects: [{ stat: "Vitality", pct: 140, duration: 1200 }, { stat: "Speed", pct: 100, duration: 1200 }]
  },
  {
    name: "Void Clarity Pill",
    ingredients: { "Cloud Mist Herb": 2, "Heavenly Spirit Vine": 1, "Starlight Dew Herb": 2, "Bitter Jade Grass": 1 },
    effects: [{ stat: "QiMulti", pct: 170, duration: 1800 }]
  },
  {
    name: "Tideborn Vigor Pill",
    ingredients: { "Blue Wave Coral Herb": 2, "Silverleaf Herb": 1, "Red Ginseng": 1, "Mountain Green Herb": 2 },
    effects: [{ stat: "Vitality", pct: 150, duration: 1500 }, { stat: "Strength", pct: 90, duration: 1500 }]
  },
  {
    name: "Stormheart Pill",
    ingredients: { "Dandelion of Qi": 1, "Purple Lightning Orchid": 2, "Cloud Mist Herb": 2, "Spirit Spring Herb": 1 },
    effects: [{ stat: "Speed", pct: 120, duration: 1200 }, { stat: "QiMulti", pct: 150, duration: 1200 }]
  },
  {
    name: "Jade Flame Rejuvenation Pill",
    ingredients: { "Healing Sunflower": 2, "Moonlight Jade Leaf": 2, "Bitter Jade Grass": 1, "Red Ginseng": 1 },
    effects: [{ stat: "Vitality", pct: 160, duration: 3000 }]
  },
  {
    name: "Iron Tempest Pill",
    ingredients: { "Black Iron Root": 2, "Purple Lightning Orchid": 1, "Wild Spirit Grass": 1, "Ironbone Grass": 2 },
    effects: [{ stat: "Strength", pct: 130, duration: 1500 }, { stat: "Speed", pct: 100, duration: 1500 }]
  },
  {
    name: "Celestial Harmony Pill",
    ingredients: { "Silverleaf Herb": 1, "Seven Star Flower": 2, "Starlight Dew Herb": 2, "Mountain Green Herb": 1 },
    effects: [{ stat: "Vitality", pct: 110, duration: 1800 }, { stat: "QiMulti", pct: 180, duration: 1800 }]
  },
  {
    name: "Crimson Tide Pill",
    ingredients: { "Bitter Jade Grass": 1, "Ironbone Grass": 1, "Red Ginseng": 2, "Crimson Flame Mushroom": 2 },
    effects: [{ stat: "Strength", pct: 120, duration: 1200 }, { stat: "Vitality", pct: 100, duration: 1200 }]
  },
  {
    name: "Mistveil Focus Pill",
    ingredients: { "Spirit Spring Herb": 2, "Silverleaf Herb": 1, "Cloud Mist Herb": 2, "Wild Spirit Grass": 1 },
    effects: [{ stat: "QiMulti", pct: 190, duration: 2100 }]
  },
  {
    name: "Serpent Fang Pill",
    ingredients: { "Azure Serpent Grass": 2, "Purple Lightning Orchid": 2, "Seven Star Flower": 1, "Dandelion of Qi": 1 },
    effects: [{ stat: "Speed", pct: 130, duration: 1200 }, { stat: "Strength", pct: 100, duration: 1200 }]
  },
  {
    name: "Sun Roses Rebirth Pill",
    ingredients: { "Healing Sunflower": 2, "Mountain Green Herb": 1, "Nine Suns Flame Grass": 2, "Red Ginseng": 1 },
    effects: [{ stat: "Vitality", pct: 40, duration: 0 }]
  },
  {
    name: "Ironclad Resolve Pill",
    ingredients: { "Black Iron Root": 2, "Silverleaf Herb": 1, "Spirit Spring Herb": 1, "Ironbone Grass": 2 },
    effects: [{ stat: "Vitality", pct: 20, duration: 0 }, { stat: "Strength", pct: 30, duration: 0 }]
  },
  {
    name: "Starborn Agility Pill",
    ingredients: { "Dandelion of Qi": 1, "Seven Star Flower": 2, "Starlight Dew Herb": 2, "Cloud Mist Herb": 1 },
    effects: [{ stat: "Speed", pct: 120, duration: 1200 }, { stat: "QiMulti", pct: 160, duration: 1200 }]
  },
  {
    name: "Jade Tide Pill",
    ingredients: { "Blue Wave Coral Herb": 2, "Moonlight Jade Leaf": 2, "Red Ginseng": 1, "Bitter Jade Grass": 1 },
    effects: [{ stat: "Vitality", pct: 130, duration: 1500 }, { stat: "QiMulti", pct: 150, duration: 1500 }]
  },
  {
    name: "Blazewind Pill",
    ingredients: { "Wild Spirit Grass": 1, "Purple Lightning Orchid": 1, "Cloud Mist Herb": 2, "Crimson Flame Mushroom": 2 },
    effects: [{ stat: "Strength", pct: 20, duration: 0 }, { stat: "Speed", pct: 40, duration: 0 }]
  }
];