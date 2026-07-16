import { SmoothScroll } from "@/components/landing/SmoothScroll";
import { Nav } from "@/components/landing/Nav";
import { HeroSection } from "@/components/landing/HeroSection";
import { FeaturesSection } from "@/components/landing/FeaturesSection";
import { AiDiagnosisSection } from "@/components/landing/AiDiagnosisSection";
import { TimelineSection } from "@/components/landing/TimelineSection";
import { SymptomsSection } from "@/components/landing/SymptomsSection";
import { DashboardPreviewSection } from "@/components/landing/DashboardPreviewSection";
import { AnalyticsSection } from "@/components/landing/AnalyticsSection";
import { ReportsSection } from "@/components/landing/ReportsSection";
import { TestimonialsSection } from "@/components/landing/TestimonialsSection";
import { FaqSection } from "@/components/landing/FaqSection";
import { PricingSection } from "@/components/landing/PricingSection";
import { Footer } from "@/components/landing/Footer";

export default function LandingPage() {
  return (
    <SmoothScroll>
      <div className="min-h-screen bg-ink text-text-primary">
        <Nav />
        <main>
          <HeroSection />
          <FeaturesSection />
          <AiDiagnosisSection />
          <TimelineSection />
          <SymptomsSection />
          <DashboardPreviewSection />
          <AnalyticsSection />
          <ReportsSection />
          <TestimonialsSection />
          <FaqSection />
          <PricingSection />
        </main>
        <Footer />
      </div>
    </SmoothScroll>
  );
}
