import { BillingSettings } from "@/components/hospital-os/BillingSettings";
import { PaymentGatewaySettings } from "@/components/hospital-os/PaymentGatewaySettings";

export default function HospitalOsBillingSettingsPage() {
  return (
    <div className="space-y-4">
      <PaymentGatewaySettings />
      <BillingSettings />
    </div>
  );
}
