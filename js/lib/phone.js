// Phone numbers in E.164 ("+919876543210"). Pure functions, unit-tested.
import { UserError } from './utils.js';

export const COUNTRIES = [['+91', 'India'], ['+971', 'UAE'], ['+1', 'US/Canada'], ['+44', 'UK'], ['+65', 'Singapore'], ['+61', 'Australia'], ['+977', 'Nepal']];

function validate(e164) {
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) throw new UserError('Enter a valid mobile number.');
  return e164;
}

/** "+91" + "098765 43210" → "+919876543210". A number typed with "+" keeps its own country code. */
export function toE164(code, number) {
  const raw = String(number || '').trim();
  let digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) return validate(`+${digits}`);
  if (code === '+91') {
    digits = digits.replace(/^0+/, '').replace(/^91(?=\d{10}$)/, '');
    if (!/^[6-9]\d{9}$/.test(digits)) throw new UserError('Enter a 10-digit Indian mobile number.');
  }
  return validate(`${code}${digits}`);
}

/** Whether a login field holds a phone number rather than an email. */
export const looksLikePhone = (s) => !String(s).includes('@') && String(s).replace(/\D/g, '').length >= 8 && /^[+\d\s()-]+$/.test(String(s).trim());

/** "+919876543210" → "+91 98765 43210" for display. */
export function formatPhone(e164) {
  const m = /^\+91(\d{5})(\d{5})$/.exec(e164 || '');
  return m ? `+91 ${m[1]} ${m[2]}` : e164 || '';
}
