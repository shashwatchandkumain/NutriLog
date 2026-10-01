// Body composition estimated from weight + profile (height, age, sex). The Cult smart scale
// does not expose a usable impedance over Bluetooth, so — like the official app's figures —
// these come from validated anthropometric equations, not from the scale's electrodes.
//   Deurenberg P et al. Br J Nutr 1991;65:105-114 (body fat %)
//   Watson PE et al. Am J Clin Nutr 1980;33:27-39 (total body water)
//   Mifflin MD et al. Am J Clin Nutr 1990;51:241-247 (BMR, via nutrition.js)
// Values are NOT rounded; round only for display.
import { bmr } from './nutrition.js';

/** Body-mass index, kg/m². */
export function bmi(weightKg, heightCm) {
  const w = Number(weightKg), h = Number(heightCm) / 100;
  return w > 0 && h > 0 ? w / (h * h) : null;
}

/** WHO adult BMI category. */
export function bmiClass(b) {
  if (!(b > 0)) return null;
  if (b < 18.5) return 'Underweight';
  if (b < 25) return 'Normal';
  if (b < 30) return 'Overweight';
  if (b < 35) return 'Obese (class I)';
  if (b < 40) return 'Obese (class II)';
  return 'Obese (class III)';
}

// Sex term: 1 for male, 0 for female, 0.5 (the midpoint) when not specified.
const sexTerm = (sex) => (sex === 'male' ? 1 : sex === 'female' ? 0 : 0.5);

/**
 * Body fat % from BMI, age and sex (Deurenberg 1991).
 *   adults:          1.20·BMI + 0.23·age − 10.8·sex − 5.4
 *   children ≤ 15 y: 1.51·BMI − 0.70·age − 3.6·sex + 1.4
 */
export function bodyFatPct(bmiValue, age, sex) {
  const b = Number(bmiValue), a = Number(age);
  if (!(b > 0 && a > 0)) return null;
  const s = sexTerm(sex);
  const pct = a <= 15 ? 1.51 * b - 0.70 * a - 3.6 * s + 1.4 : 1.20 * b + 0.23 * a - 10.8 * s - 5.4;
  return Math.min(80, Math.max(0, pct));
}

/**
 * Total body water in litres (Watson 1980).
 *   men:   2.447 − 0.09156·age + 0.1074·cm + 0.3362·kg
 *   women: −2.097 + 0.1069·cm + 0.2466·kg
 * Unspecified sex uses the mean of the two.
 */
export function totalBodyWater(weightKg, heightCm, age, sex) {
  const w = Number(weightKg), h = Number(heightCm), a = Number(age);
  if (!(w > 0 && h > 0 && a > 0)) return null;
  const male = 2.447 - 0.09156 * a + 0.1074 * h + 0.3362 * w;
  const female = -2.097 + 0.1069 * h + 0.2466 * w;
  const s = sexTerm(sex);
  return s * male + (1 - s) * female;
}

/**
 * Full snapshot for a weigh-in. Fields are null when the profile lacks what they need.
 * @returns {{ bmi, bmiClass, bodyFatPct, fatMassKg, leanMassKg, bodyWaterL, bodyWaterPct, bmrKcal }}
 */
export function bodyComposition({ weightKg, heightCm, age, sex }) {
  const w = Number(weightKg);
  const b = bmi(w, heightCm);
  const fat = b != null ? bodyFatPct(b, age, sex) : null;
  const fatMass = fat != null ? (w * fat) / 100 : null;
  const tbw = totalBodyWater(w, heightCm, age, sex);
  return {
    bmi: b,
    bmiClass: bmiClass(b),
    bodyFatPct: fat,
    fatMassKg: fatMass,
    leanMassKg: fatMass != null ? w - fatMass : null,
    bodyWaterL: tbw,
    bodyWaterPct: tbw != null && w > 0 ? (tbw / w) * 100 : null,
    bmrKcal: bmr({ weightKg: w, heightCm: Number(heightCm), age: Number(age), sex }),
  };
}
