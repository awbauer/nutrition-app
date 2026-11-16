// Trimmed USDA FoodData Central responses used by tests.
export const chickenDetail = {
  fdcId: 171477,
  description: 'Chicken, broilers or fryers, breast, meat only, cooked, roasted',
  dataType: 'SR Legacy',
  foodCategory: { id: 5, code: '0500', description: 'Poultry Products' },
  foodNutrients: [
    { nutrient: { id: 1008, unitName: 'kcal' }, amount: 165 },
    { nutrient: { id: 1003, unitName: 'g' }, amount: 31.0 },
    { nutrient: { id: 1004, unitName: 'g' }, amount: 3.57 },
    { nutrient: { id: 1005, unitName: 'g' }, amount: 0 },
    { nutrient: { id: 1093, unitName: 'mg' }, amount: 74 },
  ],
  foodPortions: [
    { gramWeight: 140, amount: 1, modifier: 'cup, chopped or diced', measureUnit: { name: 'undetermined' } },
    { gramWeight: 172, amount: 1, modifier: 'breast, bone and skin removed', measureUnit: { name: 'undetermined' } },
  ],
};

export const riceDetail = {
  fdcId: 168878,
  description: 'Rice, white, long-grain, regular, enriched, cooked',
  dataType: 'SR Legacy',
  foodNutrients: [
    { nutrient: { id: 1008, unitName: 'kcal' }, amount: 130 },
    { nutrient: { id: 1003, unitName: 'g' }, amount: 2.69 },
    { nutrient: { id: 1004, unitName: 'g' }, amount: 0.28 },
    { nutrient: { id: 1005, unitName: 'g' }, amount: 28.2 },
    { nutrient: { id: 1079, unitName: 'g' }, amount: 0.4 },
  ],
  foodPortions: [{ gramWeight: 158, amount: 1, modifier: 'cup', measureUnit: { name: 'undetermined' } }],
};

export const foundationEgg = {
  fdcId: 748967,
  description: 'Eggs, Grade A, Large, egg whole',
  dataType: 'Foundation',
  foodNutrients: [
    { nutrient: { id: 2047, unitName: 'kcal' }, amount: 148 },
    { nutrient: { id: 1003, unitName: 'g' }, amount: 12.4 },
  ],
  foodPortions: [{ gramWeight: 50, amount: 1, measureUnit: { name: 'egg' } }],
};

export const searchResults = {
  foods: [
    {
      fdcId: 171477,
      description: 'Chicken, broilers or fryers, breast, meat only, cooked, roasted',
      dataType: 'SR Legacy',
      foodCategory: 'Poultry Products',
      foodNutrients: [
        { nutrientId: 1008, unitName: 'KCAL', value: 165 },
        { nutrientId: 1003, unitName: 'G', value: 31 },
      ],
      foodMeasures: [{ disseminationText: '1 cup, chopped or diced', gramWeight: 140, rank: 1 }],
    },
  ],
};

export const DETAILS: Record<string, unknown> = {
  '171477': chickenDetail,
  '168878': riceDetail,
  '748967': foundationEgg,
};
