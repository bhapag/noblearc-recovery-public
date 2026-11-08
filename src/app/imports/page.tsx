import { getImportContextAction } from "./actions";
import { ImportWizard } from "./ImportWizard";
import styles from "./imports.module.css";

// This page reads restaurants/aggregators directly from the database (not
// via fetch()), so Next's static optimization would otherwise cache it at
// build time — restaurant data must always be current, not a build-time
// snapshot.
export const dynamic = "force-dynamic";

export default async function ImportsPage() {
  const { restaurants, aggregators } = await getImportContextAction();

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>NobleArc — Internal</p>
        <h1 className={styles.title}>Import a file</h1>
        <p className={styles.subtitle}>
          Aggregator settlement, POS order, or bank credit files — CSV or
          XLSX. No reconciliation happens here; this only converts a file
          into normalized records with an explicit, editable column mapping.
        </p>
      </header>
      <ImportWizard restaurants={restaurants} aggregators={aggregators} />
    </div>
  );
}
