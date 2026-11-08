import { Decimal } from "decimal.js";

/**
 * Deterministic, 2-decimal-safe money arithmetic for rupee amounts.
 *
 * Every calculation that touches a monetary value must go through this
 * module — never native JS `number` arithmetic, which loses precision on
 * decimal fractions (e.g. 0.1 + 0.2 !== 0.3). Prisma's `Decimal` fields are
 * backed by this same `decimal.js` library, so values returned from or sent
 * to Prisma Client pass through these functions unchanged.
 */

export type Money = Decimal;

/**
 * Parses a value into a Decimal. Prefer passing a `string` — a `number`
 * input may have already lost precision before it reached this function
 * (that loss cannot be recovered here, only prevented by not routing money
 * through `number` in the first place).
 */
export function toMoney(value: string | number | Decimal): Money {
  const parsed = new Decimal(value);
  if (!parsed.isFinite()) {
    throw new RangeError(`toMoney: value is not finite: ${String(value)}`);
  }
  return parsed;
}

export function addMoney(a: Money, b: Money): Money {
  return a.plus(b);
}

export function subtractMoney(a: Money, b: Money): Money {
  return a.minus(b);
}

export function sumMoney(values: readonly Money[]): Money {
  return values.reduce((total, value) => total.plus(value), new Decimal(0));
}

export function multiplyMoney(a: Money, b: Money): Money {
  return a.times(b);
}

export function divideMoney(a: Money, b: Money): Money {
  return a.dividedBy(b);
}

/**
 * `amount * percent / 100` — the common "X% of amount" pattern (e.g.
 * commission = percentageOf(grossAmount, commissionRatePercent)). Added for
 * Phase 2's rate-based calculations; Phase 0/1 never needed multiplication.
 */
export function percentageOf(amount: Money, percent: Money): Money {
  return amount.times(percent).dividedBy(100);
}

/**
 * Rounds to 2 decimal places using ROUND_HALF_UP — the deterministic
 * rounding rule for the whole application. This must be the only rounding
 * mode used for money anywhere in the codebase.
 */
export function roundMoney(value: Money): Money {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/**
 * The single source of truth for the expected/actual sign convention:
 * difference = expected − actual. A positive result means the restaurant
 * appears to be owed money (it received less than expected). A negative
 * result means it was paid more than expected. Never invert or re-derive
 * this convention elsewhere — always call this function.
 */
export function computeDifference(expected: Money, actual: Money): Money {
  return subtractMoney(expected, actual);
}

export function isZero(value: Money): boolean {
  return value.isZero();
}

// Intl.NumberFormat only accepts a native `number`, so formatting for display
// is the one place this module converts away from Decimal. Above this
// magnitude a double can no longer represent every 2-decimal rupee value
// exactly, so formatINR refuses rather than silently drifting.
const MAX_SAFE_DISPLAY_AMOUNT = new Decimal(Number.MAX_SAFE_INTEGER).dividedBy(100);

/**
 * Formats a rupee amount for display, e.g. "₹1,234.55". Rounds to 2dp first
 * (via roundMoney) so display always reflects the canonical stored value.
 */
export function formatINR(value: Money): string {
  const rounded = roundMoney(value);
  if (rounded.abs().greaterThan(MAX_SAFE_DISPLAY_AMOUNT)) {
    throw new RangeError(
      `formatINR: amount exceeds safely displayable magnitude: ${rounded.toString()}`,
    );
  }
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
  }).format(rounded.toNumber());
}
