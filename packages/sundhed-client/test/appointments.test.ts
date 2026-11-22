import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appointmentStatus,
  appointmentsBetween,
  appointmentsFrom,
  copenhagenDay,
  copenhagenTime,
  instantOf,
  mergeAppointments,
} from "../src/appointments.ts";

// The answer of POST /app/aftalerborger/api/v1/aftaler/cpr, with the fields the
// Aftaler page (sdk.app.aftaler.js) reads. Made up; no real person's data.
const response = {
  appointments: [
    {
      documentId: "b2c4e6f8-0000-4000-8000-000000000002",
      title: "Kontrol hos &oslash;jenl&aelig;ge &amp; synspr&#248;ve",
      appointmentType: "Laege og Speciallaege",
      startTime: "2026-07-01T08:15:00Z",
      endTime: "2026-07-01T08:45:00Z",
      endTimeNotDefined: false,
      anvendGentagneAftaler: false,
      vejledendeIntervalText: null,
      forloebText: "",
      location: { organisation: "Øjenklinikken", ward: null, unitType: "praksis", sorId: "123456789012345", phone: "12345678", address: { street: "Gade 1", postalCode: "8000", city: "Aarhus C" } },
      performer: { organisation: "Øjenklinikken", sorId: "123456789012345", phone: "12345678", address: { street: "Gade 1", postalCode: "8000", city: "Aarhus C" } },
      patient: { givenName: "Test", familyName: "Person", personIdentifier: "0101901234" },
    },
    {
      documentId: "a1b3d5f7-0000-4000-8000-000000000001",
      title: "Ambulant besøg",
      appointmentType: "Hospital",
      startTime: "2026-01-15T09:30:00",
      endTime: null,
      endTimeNotDefined: true,
      anvendGentagneAftaler: true,
      vejledendeIntervalText: "Mødetidspunktet er vejledende",
      forloebText: "Knæoperation",
      location: { organisation: "Aarhus Universitetshospital", ward: "Ortopædkirurgisk Ambulatorium", unitType: "hospital", sorId: "987654321098765", phone: "87654321", address: { formatted: "Palle Juul-Jensens Boulevard 99, 8200 Aarhus N" } },
      performer: { organisation: "Region Midtjylland" },
      patient: { givenName: "Test", familyName: "Person", personIdentifier: "0101901234" },
    },
    { documentId: "no-start", title: "Mangler tid", startTime: null },
  ],
  errorText: null,
  consentFilterApplied: false,
  canOverrideConsent: false,
};

test("instantOf reads times with and without an offset; without one is Danish time", () => {
  assert.equal(instantOf("2026-07-01T08:15:00Z"), Date.UTC(2026, 6, 1, 8, 15));
  assert.equal(instantOf("2026-07-01T10:15:00+02:00"), Date.UTC(2026, 6, 1, 8, 15));
  assert.equal(instantOf("2026-07-01T10:15:00.500+0200"), Date.UTC(2026, 6, 1, 8, 15, 0, 500));
  // Winter is UTC+1, summer UTC+2.
  assert.equal(instantOf("2026-01-15T09:30:00"), Date.UTC(2026, 0, 15, 8, 30));
  assert.equal(instantOf("2026-07-01T09:30:00"), Date.UTC(2026, 6, 1, 7, 30));
  // Right after the change to summer time (2026-03-29 02:00 -> 03:00).
  assert.equal(instantOf("2026-03-29T03:30:00"), Date.UTC(2026, 2, 29, 1, 30));
  assert.equal(instantOf("1. juli"), undefined);
  assert.equal(instantOf(null), undefined);
});

test("copenhagenTime writes RFC 3339 with the Danish offset", () => {
  assert.equal(copenhagenTime(Date.UTC(2026, 0, 15, 8, 30)), "2026-01-15T09:30:00+01:00");
  assert.equal(copenhagenTime(Date.UTC(2026, 6, 1, 8, 15)), "2026-07-01T10:15:00+02:00");
  assert.equal(copenhagenDay("2026-07-01").getTime(), Date.UTC(2026, 5, 30, 22, 0));
  assert.equal(copenhagenDay("2026-01-15", true).getTime(), Date.UTC(2026, 0, 15, 22, 59, 59, 999));
});

test("appointmentsFrom flattens the Aftaler answer, oldest first, without the patient", () => {
  const { appointments, notice, hiddenByConsent } = appointmentsFrom(response);
  assert.equal(notice, undefined);
  assert.equal(hiddenByConsent, undefined);
  assert.deepEqual(appointments, [
    {
      id: "a1b3d5f7-0000-4000-8000-000000000001",
      title: "Ambulant besøg",
      type: "Hospital",
      start: "2026-01-15T09:30:00+01:00",
      endTimeKnown: false,
      location: {
        organisation: "Aarhus Universitetshospital",
        ward: "Ortopædkirurgisk Ambulatorium",
        unitType: "hospital",
        sorId: "987654321098765",
        phone: "87654321",
        address: "Palle Juul-Jensens Boulevard 99, 8200 Aarhus N",
      },
      provider: { organisation: "Region Midtjylland" },
      repeating: true,
      timeNote: "Mødetidspunktet er vejledende",
      course: "Knæoperation",
    },
    {
      id: "b2c4e6f8-0000-4000-8000-000000000002",
      title: "Kontrol hos øjenlæge & synsprøve",
      type: "Laege og Speciallaege",
      start: "2026-07-01T10:15:00+02:00",
      end: "2026-07-01T10:45:00+02:00",
      endTimeKnown: true,
      location: { organisation: "Øjenklinikken", unitType: "praksis", sorId: "123456789012345", phone: "12345678", address: "Gade 1, 8000 Aarhus C" },
      provider: { organisation: "Øjenklinikken", sorId: "123456789012345", phone: "12345678", address: "Gade 1, 8000 Aarhus C" },
      repeating: false,
    },
  ]);
  assert.ok(!JSON.stringify(appointments).includes("0101901234"));
});

test("appointmentsFrom passes on sundhed.dk's notice and the consent filter", () => {
  const out = appointmentsFrom({ appointments: [], errorText: "Aftaler fra en region kunne ikke hentes", consentFilterApplied: true });
  assert.deepEqual(out, { appointments: [], notice: "Aftaler fra en region kunne ikke hentes", hiddenByConsent: true });
  assert.deepEqual(appointmentsFrom(null), { appointments: [] });
});

test("mergeAppointments keeps each appointment once", () => {
  const a = appointmentsFrom(response);
  const merged = mergeAppointments([a, a, { appointments: [], notice: "x" }]);
  assert.equal(merged.appointments.length, 2);
  assert.equal(merged.notice, "x");
});

test("appointmentStatus and appointmentsBetween work from the times", () => {
  const [first, second] = appointmentsFrom(response).appointments;
  const at = (iso: string) => Date.parse(iso);
  assert.equal(appointmentStatus(second, at("2026-07-01T08:00:00Z")), "upcoming");
  assert.equal(appointmentStatus(second, at("2026-07-01T08:30:00Z")), "ongoing");
  assert.equal(appointmentStatus(second, at("2026-07-01T09:00:00Z")), "past");
  // No end time: counts as an hour, as on the Aftaler page.
  assert.equal(appointmentStatus(first, at("2026-01-15T09:00:00Z")), "ongoing");
  assert.equal(appointmentStatus(first, at("2026-01-15T09:31:00Z")), "past");
  const list = [first, second];
  assert.deepEqual(appointmentsBetween(list, copenhagenDay("2026-07-01"), copenhagenDay("2026-07-01", true)), [second]);
  assert.deepEqual(appointmentsBetween(list, copenhagenDay("2026-02-01"), copenhagenDay("2026-06-30", true)), []);
});
