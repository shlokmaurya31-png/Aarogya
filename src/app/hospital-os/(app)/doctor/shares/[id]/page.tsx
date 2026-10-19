import { SharedRecordView } from "@/components/hospital-os/SharedRecordView";

export default async function SharedRecordPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SharedRecordView shareId={id} />;
}
