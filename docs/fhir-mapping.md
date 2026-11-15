# FHIR mapping

| Table | FHIR resource | Notes |
| --- | --- | --- |
| `users` | Patient | Subject of every record |
| `nutrition_intake` | NutritionIntake | `status` = event status; `meal_type` → `code`; `occurrence_at` → `occurrenceDateTime`; `recorded_at` → `recorded` |
| `consumed_item` | NutritionIntake.consumedItem | `food_id` → `nutritionProduct`; `amount_value`/`amount_unit` → `amount` (UCUM) |
| `intake_nutrient` | NutritionIntake.consumedItem.totalIntake | `nutrient_code` = INFOODS tagname, `usda_nutrient_id` kept as a second coding |
| `food` | NutritionProduct | `source`/`source_id` → `code` (FDC ID or GTIN) |
| `food_nutrient` | NutritionProduct.nutrient | Values per 100 g |
| `goal` | Goal | `type` → `target.measure`; energy/protein/... and body-weight |
| `observation` | Observation | Body weight, LOINC 29463-7, stored in kg |

## Nutrient codes

| INFOODS | USDA nutrient id | Unit |
| --- | --- | --- |
| ENERC_KCAL | 1008 (fallback 2047, 2048) | kcal |
| PROCNT | 1003 | g |
| FAT | 1004 | g |
| CHOCDF | 1005 | g |
| FIBTG | 1079 | g |
| SUGAR | 2000 (fallback 1063) | g |
| FASAT | 1258 | g |
| CHOLE | 1253 | mg |
| NA | 1093 | mg |
| K | 1092 | mg |
| CA | 1087 | mg |
| FE | 1089 | mg |
