import { TransfusionWorkspace } from "@/components/hospital-os/TransfusionWorkspace";

export default async function TransfusionWorkspacePage({ params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  return <TransfusionWorkspace requestId={requestId} />;
}
