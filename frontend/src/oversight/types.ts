/** Mirrors backend/src/dashboard/oversight.ts */
export interface Metric {
  key: string;
  label: string;
  value: string | number | null;
  unit: "CAD" | "count" | "date" | "days" | "text";
  definition: string;
  source: string;
  asOf: string;
  status: "ok" | "attention" | "critical";
  items?: string[];
}

export interface OversightView {
  view: "broker" | "accounting" | "agent";
  asOf: string;
  sections: { title: string; metrics: Metric[] }[];
}
