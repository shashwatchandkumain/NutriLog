import { assert, assertEquals } from 'jsr:@std/assert@1';
import { hmacHex, rowFromEntity, safeEqual, verifySubscriptionPayment, verifyWebhook, withGst } from './razorpay.ts';
import { normalizePlan, weeklyStats } from './reports.ts';

// Vectors computed independently with Node's crypto.
Deno.test('Razorpay payment signature: HMAC(payment_id|subscription_id)', async () => {
  const sig = '7c6e9bf10280cbacd0eb302a5e1b37cf86790be7696ab58a4ba83c2446767e12';
  assertEquals(await hmacHex('test_secret', 'pay_ABC123|sub_XYZ789'), sig);
  assert(await verifySubscriptionPayment('pay_ABC123', 'sub_XYZ789', sig, 'test_secret'));
  assert(!(await verifySubscriptionPayment('pay_ABC123', 'sub_OTHER', sig, 'test_secret')), 'another subscription');
  assert(!(await verifySubscriptionPayment('pay_ABC123', 'sub_XYZ789', sig, '')), 'no secret configured → never valid');
});

Deno.test('Razorpay webhook signature over the raw body', async () => {
  const sig = '54bfe331de51726bbf97e21be2326a4b18ed797604e8e922a3e1b6daba87b5ef';
  assert(await verifyWebhook('{"event":"x"}', sig, 'wh_secret'));
  assert(!(await verifyWebhook('{"event":"x" }', sig, 'wh_secret')), 'any change to the body fails');
  assert(!safeEqual('abc', 'abd'));
});

Deno.test('GST is added on top and rounded to the paisa', () => {
  assertEquals([withGst(14900, 0.18), withGst(29900, 0.18), withGst(99900, 0.18), withGst(199900, 0.18)], [17582, 35282, 117882, 235882]);
});

Deno.test('Razorpay entity → billing row', () => {
  const r = rowFromEntity({ id: 'sub_1', plan_id: 'plan_1', status: 'active', start_at: 1700000000, current_start: 1700000000, current_end: 1702592000 });
  assertEquals([r.status, r.current_end], ['active', '2023-12-14T22:13:20.000Z']);
});

Deno.test('weekly report numbers come from the logs, not the AI', () => {
  const s = weeklyStats({
    start: '2026-09-27', end: '2026-10-03',
    items: [
      { meal_date: '2026-09-27', calories: 1800, protein: 100, carbs: 200, fat: 60, fiber: 20 },
      { meal_date: '2026-09-28', calories: 2500, protein: 60, carbs: 300, fat: 90, fiber: 15 },
      { meal_date: '2026-09-28', calories: 100, protein: 5, carbs: 10, fat: 3, fiber: 1 },
      { meal_date: '2026-09-20', calories: 9999, protein: 0, carbs: 0, fat: 0, fiber: 0 }, // outside the week
    ],
    goals: { calories: 1900, protein_g: 110 },
    weights: [{ recorded_on: '2026-09-25', weight_kg: 80 }, { recorded_on: '2026-10-02', weight_kg: 79.4 }],
    activities: [{ activity_date: '2026-09-29', duration_min: 30, calories_burned: 150 }],
    water: [{ log_date: '2026-09-27', ml: 2000 }, { log_date: '2026-09-28', ml: 1000 }],
    waterGoalMl: 2500,
  });
  assertEquals([s.days_logged, s.avg_calories, s.calorie_days_on_target, s.avg_protein, s.protein_days_hit], [2, 2200, 1, 82.5, 1]);
  assertEquals([s.weight_start, s.weight_end, s.weight_change, s.activity_minutes, s.avg_water_ml], [80, 79.4, -0.6, 30, 1500]);
});

Deno.test('meal plans: calories from macros, impossible portions dropped, totals per day', () => {
  const plan = normalizePlan({ days: [{ day: 1, meals: [
    { meal_type: 'breakfast', items: [{ food_name: 'Poha', portion: '1 plate', grams: 200, protein: 7, carbs: 60, fat: 10, fiber: 3 },
      { food_name: 'Impossible', portion: '10 g', grams: 10, protein: 50, carbs: 0, fat: 0, fiber: 0 }] },
    { meal_type: 'midnight feast', items: [{ food_name: 'Cake', portion: '1', grams: 100, protein: 5, carbs: 50, fat: 20, fiber: 1 }] },
    { meal_type: 'dinner', items: [{ food_name: 'Dal', portion: '1 katori', grams: 150, protein: 9, carbs: 22.5, fat: 7.5, fiber: 6 }] },
  ] }], grocery: [{ item: 'Poha', quantity: '200 g', category: 'Grains' }], notes: '' }, 1);
  assertEquals(plan.days[0].meals.map((m) => [m.meal_type, m.items.length, m.calories]), [['breakfast', 1, 358], ['dinner', 1, 194]]);
  assertEquals([plan.days[0].calories, plan.grocery[0].category], [552, 'grains']);
});
