import { create } from "zustand";
import {
  reports as initialReports,
  notifications as initialNotifications,
  prescriptions as initialPrescriptions,
  doctorProfile,
} from "@/lib/mock-data";
import type { ReportDoc, NotificationItem, Prescription } from "@/types";

export interface DoctorSignature {
  name: string;
  qualification: string;
  registrationId: string;
  facility: string;
}

interface RecordsState {
  reports: ReportDoc[];
  notifications: NotificationItem[];
  prescriptions: Prescription[];
  doctorSignature: DoctorSignature;
  addReport: (report: ReportDoc) => void;
  addNotification: (notification: NotificationItem) => void;
  addPrescription: (prescription: Prescription) => void;
  setDoctorSignature: (signature: DoctorSignature) => void;
}

export const useRecordsStore = create<RecordsState>((set) => ({
  reports: initialReports,
  notifications: initialNotifications,
  prescriptions: initialPrescriptions,
  doctorSignature: {
    name: doctorProfile.name,
    qualification: doctorProfile.qualification,
    registrationId: doctorProfile.registrationId,
    facility: doctorProfile.facility,
  },
  addReport: (report) => set((s) => ({ reports: [report, ...s.reports] })),
  addNotification: (notification) => set((s) => ({ notifications: [notification, ...s.notifications] })),
  addPrescription: (prescription) => set((s) => ({ prescriptions: [prescription, ...s.prescriptions] })),
  setDoctorSignature: (signature) => set({ doctorSignature: signature }),
}));
