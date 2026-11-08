import { toMoney, type Money } from "@/lib/money";

/**
 * Strictly parses a money value from an ingested file cell. Normalizes only
 * unambiguous formatting — comma thousands separators, accounting-style
 * parentheses for negatives, a leading/adjacent currency symbol/code (with
 * an optional minus sign on either side of it, e.g. "-₹500" or "₹-500"),
 * surrounding whitespace — none of which have any other reasonable reading
 * in this context. Anything else (letters, multiple decimal points, blank,
 * "N/A", scientific notation, or more than one negative indicator at once)
 * is rejected rather than guessed at.
 */
export function parseStrictMoney(rawValue: string): Money | null {
  let value = rawValue.trim();
  if (!value) return null;

  let negativeMarkers = 0;

  if (value.startsWith("(") && value.endsWith(")")) {
    negativeMarkers += 1;
    value = value.slice(1, -1).trim();
  }

  const currencyMatch = value.match(/^(-?)\s*(₹|rs\.?|inr)\s*(-?)\s*/i);
  if (currencyMatch) {
    if (currencyMatch[1] === "-") negativeMarkers += 1;
    if (currencyMatch[3] === "-") negativeMarkers += 1;
    value = value.slice(currencyMatch[0].length);
  }

  value = value.replace(/,/g, "");

  if (value.startsWith("-")) {
    negativeMarkers += 1;
    value = value.slice(1);
  }

  if (negativeMarkers > 1) return null; // e.g. "(-5)" or "-₹-5" — more than one negative indicator, genuinely ambiguous
  if (!/^\d+(\.\d+)?$/.test(value)) return null;

  try {
    return toMoney(negativeMarkers === 1 ? `-${value}` : value);
  } catch {
    return null;
  }
}
