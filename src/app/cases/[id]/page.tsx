import { CaseDetailView } from "./CaseDetailView";
import styles from "../cases.module.css";

export const dynamic = "force-dynamic";

export default async function CaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className={styles.page}>
      <CaseDetailView recoveryCaseId={id} />
    </div>
  );
}
