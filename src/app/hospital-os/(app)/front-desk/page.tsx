import { FrontDeskWorkspace } from "@/components/hospital-os/FrontDeskWorkspace";
import { PreRegistered } from "@/components/hospital-os/PreRegistered";

export default function FrontDeskPage() {
  return (
    <div className="space-y-4">
      <PreRegistered />
      <FrontDeskWorkspace />
    </div>
  );
}
