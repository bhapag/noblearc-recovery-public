import type { POSRecord, SettlementRecord } from "@/generated/prisma/client";

export interface MatchedPair {
  settlement: SettlementRecord;
  pos: POSRecord;
}

export interface MatchResult {
  matched: MatchedPair[];
  /** No confident match — includes both "no counterpart" and ambiguous groups. */
  unmatchedSettlements: SettlementRecord[];
  unmatchedPos: POSRecord[];
  /** orderRefs excluded from matched/unmatched-cleanly because more than one record collided — surfaced for diagnostics, never silently resolved. */
  ambiguousOrderRefs: string[];
}

/**
 * Matches settlement records to POS records by exact, trimmed orderRef only
 * — no fuzzy/heuristic matching. Deliberately conservative: any ambiguity
 * (a POS orderRef claimed by settlements from more than one aggregator, or
 * more than one record on either side sharing a key — correction lines,
 * duplicates) leaves every record in the group unmatched with the ambiguity
 * surfaced, rather than guessing which pair belongs together.
 *
 * `posRecords` has no aggregatorId (a known Phase 1 limitation — POS systems
 * don't tag which channel an order came from), so POS matching is scoped by
 * restaurant only; the multi-aggregator collision is exactly what the
 * ambiguity rule above catches instead of silently guessing.
 */
export function matchSettlementsToPos(
  settlements: SettlementRecord[],
  posRecords: POSRecord[],
): MatchResult {
  const settlementsByRef = groupByTrimmedOrderRef(settlements, (s) => s.orderRef);
  const posByRef = groupByTrimmedOrderRef(posRecords, (p) => p.orderRef);

  const matched: MatchedPair[] = [];
  const unmatchedSettlements: SettlementRecord[] = [];
  const unmatchedPos: POSRecord[] = [];
  const ambiguousOrderRefs: string[] = [];

  const allRefs = new Set([...settlementsByRef.keys(), ...posByRef.keys()]);

  for (const ref of allRefs) {
    const settlementGroup = settlementsByRef.get(ref) ?? [];
    const posGroup = posByRef.get(ref) ?? [];
    const distinctAggregators = new Set(settlementGroup.map((s) => s.aggregatorId));

    const isAmbiguous = settlementGroup.length > 1 || posGroup.length > 1 || distinctAggregators.size > 1;

    if (isAmbiguous) {
      ambiguousOrderRefs.push(ref);
      unmatchedSettlements.push(...settlementGroup);
      unmatchedPos.push(...posGroup);
      continue;
    }

    if (settlementGroup.length === 1 && posGroup.length === 1) {
      matched.push({ settlement: settlementGroup[0], pos: posGroup[0] });
    } else {
      unmatchedSettlements.push(...settlementGroup);
      unmatchedPos.push(...posGroup);
    }
  }

  // Records with no orderRef at all can never be matched.
  for (const s of settlements) {
    if (!s.orderRef?.trim()) unmatchedSettlements.push(s);
  }
  for (const p of posRecords) {
    if (!p.orderRef?.trim()) unmatchedPos.push(p);
  }

  return { matched, unmatchedSettlements, unmatchedPos, ambiguousOrderRefs };
}

function groupByTrimmedOrderRef<T>(records: T[], getRef: (record: T) => string | null): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const record of records) {
    const ref = getRef(record)?.trim();
    if (!ref) continue;
    const list = map.get(ref) ?? [];
    list.push(record);
    map.set(ref, list);
  }
  return map;
}
