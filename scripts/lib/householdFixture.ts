/**
 * Week 5b — fixtures for the household gates: a manager (a Person with a
 * login and a verified phone), a household, a managed child (through the real
 * parental-consent flow, its code read from the SMS outbox), and adults.
 */
import { readFileSync, existsSync } from "node:fs";
import { prisma } from "../../src/lib/db";
import { SMS_OUTBOX_FILE } from "../../src/lib/messaging/sms";
import { confirmAddMinor, createHousehold, startAddMinor } from "../../src/lib/household/households";
import { sharer, tag } from "./shareFixture";

let seq = 0;

/** The last code sent by SMS to a number ending in `last4` (the outbox, SMS_PROVIDER=outbox). */
export function lastSmsCode(phone: string): string {
  if (!existsSync(SMS_OUTBOX_FILE)) throw new Error("no SMS outbox");
  const lines = readFileSync(SMS_OUTBOX_FILE, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { to: string; text: string }).filter((m) => m.to === phone);
  const m = /(\d{6,8})/.exec(lines[lines.length - 1]?.text ?? "");
  if (!m) throw new Error(`no code for ${phone}`);
  return m[1];
}

export async function verifiedPhone(personId: string): Promise<string> {
  seq += 1;
  const phone = `+9197${String(Date.now()).slice(-6)}${String(seq).padStart(2, "0")}`;
  await prisma.personContact.create({ data: { personId, kind: "PHONE", value: phone, verifiedAt: new Date() } });
  return phone;
}

/** A manager with a household. */
export async function manager() {
  const m = await sharer();
  const phone = await verifiedPhone(m.personId);
  const h = await createHousehold(m.userId, `Family ${tag}`);
  return { ...m, phone, householdId: h.id };
}

/** A managed child of `mgr`, `ageYears` old (DAY-precision date of birth), through the real flow. */
export async function child(mgr: { userId: string; phone: string; householdId: string }, ageYears: number, name?: string) {
  seq += 1;
  const dob = new Date();
  dob.setUTCFullYear(dob.getUTCFullYear() - ageYears);
  dob.setUTCDate(dob.getUTCDate() - 3);
  const s = await startAddMinor(mgr.userId, mgr.householdId, { displayName: name ?? `Child ${tag} ${seq}`, dateOfBirth: dob.toISOString().slice(0, 10), sex: "F", relationship: "MOTHER", declaration: true });
  const out = await confirmAddMinor(mgr.userId, s.consentId, lastSmsCode(mgr.phone));
  await prisma.person.update({ where: { id: out.childPersonId }, data: { dataClassification: "SYNTHETIC" } });
  return out;
}
