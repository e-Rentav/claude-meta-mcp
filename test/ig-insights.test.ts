import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAccountInsightsParams,
  buildMediaInsightsParams,
  DEFAULT_ACCOUNT_METRICS,
  DEFAULT_MEDIA_METRICS,
} from "../src/lib/ig-insights.js";

test("default metrics are reach,views and never include impressions", () => {
  assert.deepEqual([...DEFAULT_ACCOUNT_METRICS], ["reach", "views"]);
  assert.deepEqual([...DEFAULT_MEDIA_METRICS], ["reach", "views"]);
  assert.ok(!buildAccountInsightsParams({}).metric.includes("impressions"));
  assert.ok(!buildMediaInsightsParams().metric.includes("impressions"));
});

test("account insights default to reach,views with metric_type=total_value and period=day", () => {
  assert.deepEqual(buildAccountInsightsParams({}), {
    metric: "reach,views",
    period: "day",
    metric_type: "total_value",
  });
});

test("an empty metrics array falls back to the defaults", () => {
  assert.equal(buildAccountInsightsParams({ metrics: [] }).metric, "reach,views");
  assert.equal(buildMediaInsightsParams([]).metric, "reach,views");
});

test("caller-chosen account metrics do not force metric_type", () => {
  const params = buildAccountInsightsParams({ metrics: ["follower_count"], period: "day" });
  assert.equal(params.metric, "follower_count");
  assert.equal(params.metric_type, undefined);
});

test("explicit metric_type, since and until are passed through", () => {
  assert.deepEqual(
    buildAccountInsightsParams({
      metrics: ["reach"],
      metric_type: "time_series",
      period: "week",
      since: "2026-11-01",
      until: "2026-11-15",
    }),
    { metric: "reach", period: "week", metric_type: "time_series", since: "2026-11-01", until: "2026-11-15" }
  );
});

test("media insights default to reach,views and respect caller metrics", () => {
  assert.deepEqual(buildMediaInsightsParams(), { metric: "reach,views" });
  assert.deepEqual(buildMediaInsightsParams(["saved", "shares"]), { metric: "saved,shares" });
});
