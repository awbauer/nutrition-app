import { describe, expect, it } from 'vitest';
import { csvCell } from '../src/worker/routes/export';
import { api } from './helpers';

const U = { DEV_USER_EMAIL: 'export@example.test' };

describe('export', () => {
  it('escapes CSV and neutralises formulas', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(null)).toBe('');
  });

  it('exports items CSV, daily CSV with targets and weight, and FHIR-aligned JSON', async () => {
    await api('/settings', { method: 'PUT', json: { timezone: 'America/New_York' } }, U);
    const food = await api('/foods', { method: 'POST', json: { name: 'Bagel, plain', per_100g: { ENERC_KCAL: 250, PROCNT: 10, FAT: 1.5, CHOCDF: 49, FIBTG: 2 } } }, U);
    const meal = await api(
      '/intake',
      { method: 'POST', json: { meal_type: 'breakfast', occurrence_at: '2026-11-02T12:30:00Z', items: [{ food_id: food.data.id, amount: 100, unit: 'g' }] } },
      U,
    );
    const gone = await api('/intake', { method: 'POST', json: { occurrence_at: '2026-11-02T16:00:00Z', items: [{ food_id: food.data.id, amount: 50, unit: 'g' }] } }, U);
    await api(`/intake/${gone.data.id}`, { method: 'DELETE' }, U);
    await api('/weight', { method: 'POST', json: { value: 80, effective_at: '2026-11-02T12:00:00Z' } }, U);
    await api('/weight', { method: 'POST', json: { value: 79, effective_at: '2026-11-03T12:00:00Z' } }, U);

    const items = await api('/export?format=csv&kind=items&from=2026-11-01&to=2026-11-03', {}, U);
    expect(items.res.headers.get('Content-Type')).toMatch(/text\/csv/);
    expect(items.res.headers.get('Content-Disposition')).toMatch(/attachment/);
    const rows = (items.data as string).trim().split('\r\n');
    expect(rows[0]).toBe('date,time,meal_type,food,fdc_id,grams,kcal,protein_g,fat_g,carbs_g,fiber_g,confidence,source,status');
    expect(rows).toHaveLength(2); // deleted meal excluded
    expect(rows[1]).toBe('2026-11-02,07:30,breakfast,"Bagel, plain",,100,250,10,1.5,49,2,1,manual,completed');

    const daily = await api('/export?format=csv&kind=daily&from=2026-11-01&to=2026-11-03', {}, U);
    const d = (daily.data as string).trim().split('\r\n');
    expect(d).toHaveLength(4);
    expect(d[1]).toBe('2026-11-01,0,,,,,,,,,');
    expect(d[2]).toBe('2026-11-02,1,250,,10,,1.5,49,2,80,80');
    expect(d[3]!.startsWith('2026-11-03,0,,,,,,,,79,79.75')).toBe(true);

    const json = await api('/export?format=json&from=2026-11-01&to=2026-11-03', {}, U);
    expect(json.data.nutrition_intake).toHaveLength(2); // JSON keeps entered-in-error records
    const ni = json.data.nutrition_intake.find((x: any) => x.id === meal.data.id);
    expect(ni).toMatchObject({ status: 'completed', code: 'breakfast', occurrence_time_zone: 'America/New_York' });
    expect(ni.consumed_item[0].total_intake).toContainEqual({ nutrient: 'ENERC_KCAL', value: 250 });
    expect(json.data.observation[0].code).toEqual({ system: 'http://loinc.org', code: '29463-7' });

    expect((await api('/export?format=xml', {}, U)).status).toBe(400);
    expect((await api('/export?from=2020-01-01&to=2026-01-01', {}, U)).status).toBe(400);
  });
});
