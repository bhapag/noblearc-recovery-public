import { getReconciliationContextAction } from "./actions";
import { ReconciliationWorkspace } from "./ReconciliationWorkspace";
import styles from "./reconciliation.module.css";

// Restaurant/aggregator data must always be current, not a build-time
// snapshot — same reasoning as /imports.
export const dynamic = "force-dynamic";

export default async function ReconciliationPage() {
  const { restaurants, aggregators } = await getReconciliationContextAction();

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>NobleArc — Internal</p>
        <h1 className={styles.title}>Reconciliation</h1>
        <p className={styles.subtitle}>
          The software calculates expected vs. actual settlement amounts from
          imported records. It never decides what a difference means — every
          case starts unclassified until a human reviews it and records why.
        </p>
      </header>
      <ReconciliationWorkspace restaurants={restaurants} aggregators={aggregators} />
    </div>
  );
}
