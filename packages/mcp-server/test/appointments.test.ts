import { test } from "node:test";
import assert from "node:assert/strict";
import { appointmentAnswer, appointmentRange } from "../src/tools.ts";

test("appointmentRange takes whole Danish days, by default two years each way", () => {
  const now = new Date(Date.UTC(2026, 10, 22, 12));
  const def = appointmentRange(undefined, undefined, now);
  assert.equal(def.from.toISOString(), "2024-11-22T12:00:00.000Z");
  assert.equal(def.to.toISOString(), "2028-11-22T12:00:00.000Z");
  const days = appointmentRange("2026-07-01", "2026-07-31", now);
  assert.equal(days.from.toISOString(), "2026-06-30T22:00:00.000Z");
  assert.equal(days.to.toISOString(), "2026-07-31T21:59:59.999Z");
});

test("appointmentAnswer adds each appointment's status and the range", () => {
  const range = appointmentRange("2026-01-01", "2026-12-31");
  const answer = appointmentAnswer(
    {
      appointments: [
        { id: "a", title: "Past", start: "2026-01-15T09:30:00+01:00", endTimeKnown: false },
        { id: "b", title: "Ahead", start: "2026-12-01T10:00:00+01:00", end: "2026-12-01T10:30:00+01:00", endTimeKnown: true },
      ],
      hiddenByConsent: true,
    },
    range,
    Date.parse("2026-11-22T12:00:00Z"),
  );
  assert.equal(answer.from, "2026-01-01T00:00:00+01:00");
  assert.equal(answer.to, "2026-12-31T23:59:59+01:00");
  assert.equal(answer.now, "2026-11-22T13:00:00+01:00");
  assert.ok(answer.hiddenByConsent);
  assert.deepEqual(
    answer.appointments.map((a) => [a.id, a.status]),
    [
      ["a", "past"],
      ["b", "upcoming"],
    ],
  );
});
