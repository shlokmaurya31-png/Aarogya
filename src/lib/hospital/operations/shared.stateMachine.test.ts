import { describe, it, expect } from "vitest";
import {
  isTransitionAllowed, HOUSEKEEPING_TRANSITIONS, TRANSPORT_TRANSITIONS,
  AMBULANCE_TRIP_TRANSITIONS, MAINTENANCE_TRANSITIONS, INFECTION_TRANSITIONS, MEAL_TRANSITIONS,
} from "./shared";

/**
 * Phase B9 operational state machines. Every workflow has explicit legal
 * transitions; a completed/terminal record can never return to an earlier
 * state (corrections are explicit, not a status rewind).
 */
describe("housekeeping lifecycle", () => {
  it("follows REQUESTED->ASSIGNED->IN_PROGRESS->COMPLETED->INSPECTED->CLOSED", () => {
    expect(isTransitionAllowed(HOUSEKEEPING_TRANSITIONS, "REQUESTED", "ASSIGNED")).toBe(true);
    expect(isTransitionAllowed(HOUSEKEEPING_TRANSITIONS, "IN_PROGRESS", "COMPLETED")).toBe(true);
    expect(isTransitionAllowed(HOUSEKEEPING_TRANSITIONS, "COMPLETED", "INSPECTED")).toBe(true);
    expect(isTransitionAllowed(HOUSEKEEPING_TRANSITIONS, "INSPECTED", "CLOSED")).toBe(true);
  });
  it("rejects rewinds and terminal mutation", () => {
    expect(isTransitionAllowed(HOUSEKEEPING_TRANSITIONS, "COMPLETED", "REQUESTED")).toBe(false);
    expect(isTransitionAllowed(HOUSEKEEPING_TRANSITIONS, "CLOSED", "IN_PROGRESS")).toBe(false);
    expect(isTransitionAllowed(HOUSEKEEPING_TRANSITIONS, "CANCELLED", "ASSIGNED")).toBe(false);
  });
});

describe("transport lifecycle", () => {
  it("follows the pickup->transit->arrival->completion path", () => {
    expect(isTransitionAllowed(TRANSPORT_TRANSITIONS, "ASSIGNED", "EN_ROUTE_TO_PICKUP")).toBe(true);
    expect(isTransitionAllowed(TRANSPORT_TRANSITIONS, "PATIENT_PICKED_UP", "IN_TRANSIT")).toBe(true);
    expect(isTransitionAllowed(TRANSPORT_TRANSITIONS, "IN_TRANSIT", "ARRIVED")).toBe(true);
    expect(isTransitionAllowed(TRANSPORT_TRANSITIONS, "ARRIVED", "COMPLETED")).toBe(true);
  });
  it("rejects skipping and double completion", () => {
    expect(isTransitionAllowed(TRANSPORT_TRANSITIONS, "REQUESTED", "IN_TRANSIT")).toBe(false);
    expect(isTransitionAllowed(TRANSPORT_TRANSITIONS, "COMPLETED", "ARRIVED")).toBe(false);
  });
});

describe("ambulance trip lifecycle", () => {
  it("follows REQUESTED->DISPATCHED->...->COMPLETED", () => {
    expect(isTransitionAllowed(AMBULANCE_TRIP_TRANSITIONS, "REQUESTED", "DISPATCHED")).toBe(true);
    expect(isTransitionAllowed(AMBULANCE_TRIP_TRANSITIONS, "PATIENT_ONBOARD", "IN_TRANSIT")).toBe(true);
    expect(isTransitionAllowed(AMBULANCE_TRIP_TRANSITIONS, "ARRIVED", "COMPLETED")).toBe(true);
  });
  it("rejects dispatching a completed/cancelled trip", () => {
    expect(isTransitionAllowed(AMBULANCE_TRIP_TRANSITIONS, "COMPLETED", "DISPATCHED")).toBe(false);
    expect(isTransitionAllowed(AMBULANCE_TRIP_TRANSITIONS, "CANCELLED", "DISPATCHED")).toBe(false);
  });
});

describe("maintenance + infection + meal lifecycles reject rewinds", () => {
  it("maintenance REPORTED->ASSIGNED->...->CLOSED, no rewind", () => {
    expect(isTransitionAllowed(MAINTENANCE_TRANSITIONS, "IN_PROGRESS", "RESOLVED")).toBe(true);
    expect(isTransitionAllowed(MAINTENANCE_TRANSITIONS, "RESOLVED", "VERIFIED")).toBe(true);
    expect(isTransitionAllowed(MAINTENANCE_TRANSITIONS, "CLOSED", "REPORTED")).toBe(false);
  });
  it("infection REPORTED->...->CLOSED, no diagnosis shortcut", () => {
    expect(isTransitionAllowed(INFECTION_TRANSITIONS, "UNDER_REVIEW", "INVESTIGATION")).toBe(true);
    expect(isTransitionAllowed(INFECTION_TRANSITIONS, "RESOLVED", "CLOSED")).toBe(true);
    expect(isTransitionAllowed(INFECTION_TRANSITIONS, "REPORTED", "RESOLVED")).toBe(false);
    expect(isTransitionAllowed(INFECTION_TRANSITIONS, "CLOSED", "REPORTED")).toBe(false);
  });
  it("meal PLANNED->PREPARING->READY->DELIVERED, cannot deliver a planned meal directly", () => {
    expect(isTransitionAllowed(MEAL_TRANSITIONS, "READY", "DELIVERED")).toBe(true);
    expect(isTransitionAllowed(MEAL_TRANSITIONS, "READY", "REFUSED")).toBe(true);
    expect(isTransitionAllowed(MEAL_TRANSITIONS, "PLANNED", "DELIVERED")).toBe(false);
    expect(isTransitionAllowed(MEAL_TRANSITIONS, "DELIVERED", "READY")).toBe(false);
  });
});
