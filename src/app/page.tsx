import Link from "next/link";
import styles from "./page.module.css";

export default function Home() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <p className={styles.eyebrow}>NobleArc — Internal</p>
        <h1 className={styles.title}>Restaurant Payout Recovery</h1>
        <p className={styles.subtitle}>
          Reconcile restaurant payouts from delivery aggregators against POS
          and bank records.
        </p>
        <div className={styles.ctaRow}>
          <Link className={styles.cta} href="/imports">
            Import a file →
          </Link>
          <Link className={styles.ctaSecondary} href="/reconciliation">
            Reconciliation →
          </Link>
          <Link className={styles.ctaSecondary} href="/cases">
            Recovery cases →
          </Link>
        </div>
      </main>
    </div>
  );
}
