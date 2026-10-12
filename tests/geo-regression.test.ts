const { test, describe, expect, beforeAll, afterAll } = await import('vitest');
const { ConvexHttpClient } = await import('convex-test');
const schema = await import('../src/convex/schema').then(m => m.schema);
const clients = await import('../src/convex/clients').then(m => m.create);

const http = new ConvexHttpClient(schema);

describe('geo acquisition regression — core decision logic', () => {
  test('accepts a 47 m fix immediately when it is already available', () => {
    const fix = {
      latitude: 25.3211,
      longitude: 82.9861,
      accuracyMeters: 47,
      capturedAt: Date.now(),
    };
    const frameAt = Date.now();
    const accepted = acceptableFixAtCaptureWithFutureTolerance(fix, frameAt);
    expect(accepted).toEqual(fix);
  });

  test('rejects a 200000 m fix even when it is fresh', () => {
    const fix = {
      latitude: 25.3211,
      longitude: 82.9861,
      accuracyMeters: 200000,
      capturedAt: Date.now(),
    };
    expect(acceptableFixAtCaptureWithFutureTolerance(fix, Date.now())).toBeNull();
  });

  test('rejects a 101 m fix; accepts a 100 m fix', () => {
    const bad = {
      latitude: 25.3211,
      longitude: 82.9861,
      accuracyMeters: 101,
      capturedAt: Date.now(),
    };
    const good = {
      latitude: 25.3211,
      longitude: 82.9861,
      accuracyMeters: 100,
      capturedAt: Date.now(),
    };
    expect(acceptableFixAtCaptureWithFutureTolerance(bad, Date.now())).toBeNull();
    expect(acceptableFixAtCaptureWithFutureTolerance(good, Date.now())).toEqual(good);
  });

  test('rejects a stale fix whose timestamp is too old relative to the frame', () => {
    const fix = {
      latitude: 25.3211,
      longitude: 82.9861,
      accuracyMeters: 30,
      capturedAt: Date.now() - 61_000,
    };
    expect(acceptableFixAtCaptureWithFutureTolerance(fix, Date.now())).toBeNull();
  });

  test('accepts a future-dated fix within the tolerance window', () => {
    const fix = {
      latitude: 25.3211,
      longitude: 82.9861,
      accuracyMeters: 47,
      capturedAt: Date.now() + 20_000,
    };
    expect(acceptableFixAtCaptureWithFutureTolerance(fix, Date.now())).toEqual(fix);
  });

  test('rejects a future-dated fix outside the tolerance window', () => {
    const fix = {
      latitude: 25.3211,
      longitude: 82.9861,
      accuracyMeters: 47,
      capturedAt: Date.now() + 60_000,
    };
    expect(acceptableFixAtCaptureWithFutureTolerance(fix, Date.now())).toBeNull();
  });
});
