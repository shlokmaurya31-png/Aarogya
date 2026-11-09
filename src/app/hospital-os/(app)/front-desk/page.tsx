import { FrontDeskWorkspace } from "@/components/hospital-os/FrontDeskWorkspace";
import { PreRegistered } from "@/components/hospital-os/PreRegistered";
import { ScanShareDesk } from "@/components/hospital-os/ScanShareDesk";

export default function FrontDeskPage() {
  return (
    <div className="space-y-4">
      <ScanShareDesk />
      <PreRegistered />
      <FrontDeskWorkspace />
    </div>
  );
}
