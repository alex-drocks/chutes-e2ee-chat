// Executed only in a child test runner by live-runner.unit.test.js.
import { getLiveContext, liveTest } from '../live-chutes.js';

globalThis.fetch = async (url) => {
  if (String(url).endsWith('/v1/models')) return Response.json({ data: [] });
  if (String(url).endsWith('/chutes/utilization')) return Response.json([]);
  throw new Error(`Unexpected network request in live-runner fixture: ${url}`);
};

liveTest('live-runner fixture', async () => {
  console.log('LIVE_BODY_EXECUTED');
  if (process.env.LIVE_FIXTURE_MODE === 'unavailable') await getLiveContext();
});
