import { getCasesContextAction } from "./actions";
import { CasesWorkspace } from "./CasesWorkspace";
import styles from "./cases.module.css";

export const dynamic = "force-dynamic";

export default async function CasesPage() {
  const { restaurants, aggregators } = await getCasesContextAction();

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>NobleArc — Internal</p>
        <h1 className={styles.title}>Recovery cases</h1>
        <p className={styles.subtitle}>
          Build a recovery case from Confirmed Discrepancy items, assemble its evidence pack, and record what happened
          when a findings report is sent — nothing here files a dispute or contacts a client automatically.
        </p>
      </header>
      <CasesWorkspace restaurants={restaurants} aggregators={aggregators} />
    </div>
  );
}
