import { CaseWorkspace } from "@/components/student/CaseWorkspace";

export default async function StudentCaseWorkspacePage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  return <CaseWorkspace caseId={caseId} />;
}
