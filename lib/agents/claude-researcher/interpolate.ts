// The "interpolate data" skill. The model sends the numbers it found and this
// code does the math, so estimates are calculated instead of guessed.

export interface Estimate {
  label: string;
  method: string;
  unit: string;
  low: number;
  high: number;
  midpoint: number;
  formula: string;
  extrapolated: boolean;
  label_as: "ESTIMATED";
  max_confidence: "MEDIUM" | "LOW";
  [extra: string]: unknown;
}

// Commas only for big numbers, so years print as "2026", not "2,026".
const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", {
    maximumFractionDigits: Math.abs(n) < 10 ? 2 : 0,
    useGrouping: Math.abs(n) >= 10000,
  }).format(n);

const round = (n: number) => Math.round(n * 100) / 100;

function num(value: unknown, name: string): number {
  const n = Number(value);
  if (value === undefined || value === null || value === "" || !Number.isFinite(n)) {
    throw new Error(`"${name}" must be a number.`);
  }
  return n;
}

function result(r: {
  label: string;
  unit: string;
  method: string;
  low: number;
  high: number;
  formula: string;
  extrapolated?: boolean;
  extra?: Record<string, unknown>;
}): Estimate {
  const [lo, hi] = r.low <= r.high ? [r.low, r.high] : [r.high, r.low];
  const extrapolated = r.extrapolated ?? false;
  return {
    label: r.label,
    method: r.method,
    unit: r.unit,
    low: round(lo),
    high: round(hi),
    midpoint: round((lo + hi) / 2),
    formula: r.formula,
    extrapolated,
    label_as: "ESTIMATED",
    max_confidence: extrapolated ? "LOW" : "MEDIUM",
    ...r.extra,
  };
}

export function interpolate(input: Record<string, unknown>): Estimate {
  const method = String(input.method ?? "");
  const label = String(input.label ?? "Estimate");
  const unit = String(input.unit ?? "");
  const u = unit ? ` ${unit}` : "";

  switch (method) {
    case "scale": {
      const base = num(input.base_value, "base_value");
      const rLow = num(input.ratio_low, "ratio_low");
      const rHigh = input.ratio_high === undefined ? rLow : num(input.ratio_high, "ratio_high");
      const low = base * rLow;
      const high = base * rHigh;
      const ratioText = rLow === rHigh ? `${rLow}` : `${rLow}-${rHigh}`;
      return result({
        label, unit, method, low, high,
        formula: `${fmt(base)}${u} x ${ratioText} = ${fmt(Math.min(low, high))}-${fmt(Math.max(low, high))}${u}`,
      });
    }

    case "linear": {
      const target = num(input.target_x, "target_x");
      const raw = Array.isArray(input.points) ? (input.points as Array<Record<string, unknown>>) : [];
      const points = raw.map((p, i) => ({ x: num(p.x, `points[${i}].x`), y: num(p.y, `points[${i}].y`) }));
      if (points.length < 2) throw new Error("linear needs at least 2 points.");
      points.sort((a, b) => a.x - b.x);

      // Use the two points around the target, or the two nearest ends if the target is outside the data.
      const last = points.length - 1;
      const extrapolated = target < points[0].x || target > points[last].x;
      let a = points[0];
      let b = points[1];
      if (target > points[last].x) {
        a = points[last - 1];
        b = points[last];
      } else if (!extrapolated) {
        for (let i = 0; i < last; i++) {
          if (target >= points[i].x && target <= points[i + 1].x) {
            a = points[i];
            b = points[i + 1];
            break;
          }
        }
      }
      if (a.x === b.x) throw new Error("Two points share the same x value.");

      const y = a.y + ((target - a.x) * (b.y - a.y)) / (b.x - a.x);
      const pct = input.uncertainty_pct === undefined ? (extrapolated ? 25 : 10) : num(input.uncertainty_pct, "uncertainty_pct");
      const band = pct / 100;
      return result({
        label, unit, method, extrapolated,
        low: y * (1 - band),
        high: y * (1 + band),
        formula: `line through (${fmt(a.x)}, ${fmt(a.y)}) and (${fmt(b.x)}, ${fmt(b.y)}) at x=${fmt(target)} gives ~${fmt(y)}${u}, +/-${Math.round(pct)}%`,
        extra: { point_estimate: round(y) },
      });
    }

    case "summarize": {
      const values = (Array.isArray(input.values) ? input.values : []).map((v, i) => num(v, `values[${i}]`));
      if (values.length === 0) throw new Error("summarize needs at least 1 value.");
      const sorted = [...values].sort((x, y) => x - y);
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      const mean = values.reduce((s, v) => s + v, 0) / values.length;
      return result({
        label, unit, method,
        low: sorted[0],
        high: sorted[sorted.length - 1],
        formula: `${values.length} values: range ${fmt(sorted[0])}-${fmt(sorted[sorted.length - 1])}${u}, median ${fmt(median)}, mean ${fmt(mean)}`,
        extra: { median: round(median), mean: round(mean), count: values.length },
      });
    }

    case "project_growth": {
      const start = num(input.start_value, "start_value");
      const years = num(input.years, "years");
      const rLow = num(input.growth_rate_low, "growth_rate_low");
      const rHigh = input.growth_rate_high === undefined ? rLow : num(input.growth_rate_high, "growth_rate_high");
      const low = start * (1 + rLow) ** years;
      const high = start * (1 + rHigh) ** years;
      const pct = (r: number) => `${round(r * 100)}%`;
      const rateText = rLow === rHigh ? pct(rLow) : `${pct(rLow)}-${pct(rHigh)}`;
      return result({
        label, unit, method, low, high,
        extrapolated: years > 5,
        formula: `${fmt(start)}${u} growing ${rateText}/yr for ${fmt(years)} yrs = ${fmt(Math.min(low, high))}-${fmt(Math.max(low, high))}${u}`,
      });
    }

    default:
      throw new Error(`Unknown method "${method}". Use scale, linear, summarize, or project_growth.`);
  }
}
