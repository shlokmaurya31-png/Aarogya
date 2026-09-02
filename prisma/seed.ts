/**
 * Seeds demo users (dev-only, clearly documented) + Institution + 25
 * synthetic teaching cases + achievement catalog. Run with `npm run db:seed`.
 * Safe to re-run: uses upsert-by-unique-key throughout.
 */
import { PrismaClient, Role, Course, LearningTrack, VerificationStatus, VerificationMethod } from "@prisma/client";
import { hashPassword } from "../src/lib/auth/password";
import { allCaseDefs } from "./seedData";
import { buildCase } from "./seedData/builder";
import { seedHospital } from "./seedData/hospital";
import { seedPhase1Extensions } from "./seedData/hospitalPhase1";

const prisma = new PrismaClient();

const ACHIEVEMENTS = [
  { code: "FIRST_DIAGNOSIS", title: "First Diagnosis", description: "Submitted your first case diagnosis.", icon: "stethoscope" },
  { code: "HUNDRED_CASES", title: "100 Cases", description: "Completed 100 clinical cases.", icon: "trophy" },
  { code: "CARDIOLOGY_EXPLORER", title: "Cardiology Explorer", description: "Completed 5 cardiology cases.", icon: "heart-pulse" },
  { code: "ECG_APPRENTICE", title: "ECG Apprentice", description: "Correctly interpreted 10 ECGs.", icon: "activity" },
  { code: "EMERGENCY_READY", title: "Emergency Ready", description: "Passed 3 emergency-acuity cases.", icon: "siren" },
  { code: "SAFE_PRESCRIBER", title: "Safe Prescriber", description: "Completed 10 RxLab prescriptions with zero danger-level warnings.", icon: "pill" },
  { code: "DIAGNOSTIC_DETECTIVE", title: "Diagnostic Detective", description: "Matched the full reference differential on 5 cases.", icon: "search" },
  { code: "SEVEN_DAY_STREAK", title: "Seven-Day Streak", description: "Maintained a 7-day learning streak.", icon: "flame" },
];

async function seedUsers() {
  const institution = await prisma.institution.upsert({
    where: { id: "inst-demo-aims" },
    update: {},
    create: {
      id: "inst-demo-aims",
      name: "Aarogya Institute of Medical Sciences (Demo)",
      type: "medical-college",
      city: "Bengaluru",
    },
  });

  await prisma.institutionDomain.upsert({
    where: { domain: "aims-demo.edu.in" },
    update: {},
    create: { domain: "aims-demo.edu.in", institutionId: institution.id },
  });

  const password = await hashPassword("Scholar@123");

  async function upsertUser(email: string, role: Role, displayName: string) {
    return prisma.user.upsert({
      where: { email },
      update: {},
      create: { email, role, displayName, passwordHash: password },
    });
  }

  const student = await upsertUser("student@demo.aarogya", Role.STUDENT, "Ananya Iyer");
  const studentFirstYear = await upsertUser("student.firstyear@demo.aarogya", Role.STUDENT, "Rohan Deshmukh");
  const studentNursing = await upsertUser("student.nursing@demo.aarogya", Role.STUDENT, "Priya Nair");
  const studentPharmacy = await upsertUser("student.pharmacy@demo.aarogya", Role.STUDENT, "Farhan Sheikh");
  await upsertUser("educator@demo.aarogya", Role.EDUCATOR, "Dr. Vikram Rao");
  await upsertUser("admin@demo.aarogya", Role.AAROGYA_ADMIN, "Aarogya Platform Admin");
  await upsertUser("doctor@demo.aarogya", Role.DOCTOR, "Dr. Meera Kapoor");

  async function upsertStudentProfile(
    userId: string,
    fullLegalName: string,
    course: Course,
    learningTrack: LearningTrack,
    academicYear: number,
    verified: boolean
  ) {
    await prisma.studentProfile.upsert({
      where: { userId },
      update: {},
      create: {
        userId,
        fullLegalName,
        preferredName: fullLegalName.split(" ")[0],
        institutionId: institution.id,
        institutionNameFreeText: institution.name,
        course,
        learningTrack,
        academicYear,
        enrollmentYear: new Date().getFullYear() - academicYear + 1,
        expectedGraduation: new Date().getFullYear() + (5 - academicYear),
        institutionEmail: `${fullLegalName.toLowerCase().split(" ")[0]}@aims-demo.edu.in`,
        currentRotation: "Internal Medicine",
        clinicalInterests: JSON.stringify(["Cardiology", "Emergency Medicine"]),
        verificationStatus: verified ? VerificationStatus.VERIFIED : VerificationStatus.UNDER_REVIEW,
        verificationMethod: verified ? VerificationMethod.INSTITUTIONAL_EMAIL : undefined,
        verifiedAt: verified ? new Date() : undefined,
        streakDays: verified ? 4 : 0,
        clinicalXp: verified ? 1250 : 0,
      },
    });
  }

  await upsertStudentProfile(student.id, "Ananya Iyer", Course.MBBS, LearningTrack.MEDICINE, 5, true);
  await upsertStudentProfile(studentFirstYear.id, "Rohan Deshmukh", Course.MBBS, LearningTrack.MEDICINE, 1, true);
  await upsertStudentProfile(studentNursing.id, "Priya Nair", Course.BSC_NURSING, LearningTrack.NURSING, 2, true);
  await upsertStudentProfile(studentPharmacy.id, "Farhan Sheikh", Course.PHARM_D, LearningTrack.PHARMACY, 1, true);

  console.log("Seeded demo users:");
  console.log("  student@demo.aarogya         / Scholar@123  (STUDENT, MBBS final year, verified)");
  console.log("  student.firstyear@demo.aarogya / Scholar@123 (STUDENT, MBBS year 1, verified)");
  console.log("  student.nursing@demo.aarogya  / Scholar@123  (STUDENT, BSc Nursing, verified)");
  console.log("  student.pharmacy@demo.aarogya / Scholar@123  (STUDENT, PharmD, verified)");
  console.log("  educator@demo.aarogya         / Scholar@123  (EDUCATOR)");
  console.log("  admin@demo.aarogya            / Scholar@123  (AAROGYA_ADMIN)");
  console.log("  doctor@demo.aarogya           / Scholar@123  (DOCTOR — placeholder for future migration)");
}

async function seedAchievements() {
  for (const a of ACHIEVEMENTS) {
    await prisma.achievement.upsert({ where: { code: a.code }, update: {}, create: a });
  }
  console.log(`Seeded ${ACHIEVEMENTS.length} achievements.`);
}

async function seedCases() {
  let created = 0;
  for (const def of allCaseDefs) {
    const built = buildCase(def);
    await prisma.clinicalCase.upsert({
      where: { slug: built.slug },
      update: {
        title: built.title,
        specialty: built.specialty,
        subspecialty: built.subspecialty,
        difficulty: built.difficulty,
        acuity: built.acuity,
        sourceType: built.sourceType,
        learnerTracks: JSON.stringify(built.learnerTracks),
        patientName: built.patientName,
        patientAgeBand: built.patientAgeBand,
        patientAgeExact: built.patientAgeExact,
        patientSex: built.patientSex,
        chiefComplaint: built.chiefComplaint,
        learningObjectives: JSON.stringify(built.learningObjectives),
        content: built.content as object,
        referenceDx: built.referenceDx,
        rubric: built.rubric as object,
        viva: built.viva as object,
        isPublished: true,
      },
      create: {
        slug: built.slug,
        title: built.title,
        specialty: built.specialty,
        subspecialty: built.subspecialty,
        difficulty: built.difficulty,
        acuity: built.acuity,
        sourceType: built.sourceType,
        learnerTracks: JSON.stringify(built.learnerTracks),
        patientName: built.patientName,
        patientAgeBand: built.patientAgeBand,
        patientAgeExact: built.patientAgeExact,
        patientSex: built.patientSex,
        chiefComplaint: built.chiefComplaint,
        learningObjectives: JSON.stringify(built.learningObjectives),
        content: built.content as object,
        referenceDx: built.referenceDx,
        rubric: built.rubric as object,
        viva: built.viva as object,
        isPublished: true,
      },
    });
    created += 1;
  }
  console.log(`Seeded ${created} synthetic teaching cases.`);
}

async function main() {
  await seedUsers();
  await seedAchievements();
  await seedCases();
  await seedHospital(prisma);
  await seedPhase1Extensions(prisma);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
