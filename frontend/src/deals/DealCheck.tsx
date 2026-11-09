import { useApi } from "../app/useApi.ts";
import { Link } from "../app/router.tsx";
import { Notice } from "../ui/kit.tsx";

interface Issue { area: string; severity: "MUST_FIX" | "CHECK"; message: string; fix: string; tab: string }
interface CheckResult { checkedOn: string; issues: Issue[]; summary: { mustFix: number; check: number } }

/** The system's own review of the deal: what's missing, what's wrong, which dates don't line up. Re-runs on every visit. */
export function DealCheck({ dealId }: { dealId: string }) {
  const res = useApi<CheckResult>(`/api/deals/${dealId}/check`);
  if (!res.data) return res.status === "error" ? <Notice kind="error">{res.message}</Notice> : null;
  const { issues, summary } = res.data;
  if (issues.length === 0) return <Notice kind="success" title="Deal check: nothing to fix">Dates, conditions, deposit, people, documents and compliance all line up.</Notice>;
  const areas = [...new Set(issues.map((i) => i.area))];
  return (
    <section aria-label="Deal check" className={`rounded-lg border px-4 py-3 text-sm ${summary.mustFix ? "border-critical/40 bg-critical/5" : "border-warning/50 bg-warning/10"}`}>
      <p className="font-semibold text-ink">
        Deal check: {summary.mustFix > 0 && `${summary.mustFix} to fix`}{summary.mustFix > 0 && summary.check > 0 && ", "}{summary.check > 0 && `${summary.check} to check`}
      </p>
      <p className="text-ink-3">The system reviews the deal each time it's opened, so it's ready for the deal secretary.</p>
      <div className="mt-3 space-y-3">
        {areas.map((a) => (
          <div key={a}>
            <p className="font-medium text-ink">{a}</p>
            <ul className="mt-1 space-y-1.5">
              {issues.filter((i) => i.area === a).map((i) => (
                <li key={i.message} className="flex gap-2">
                  <span className={`mt-0.5 shrink-0 rounded px-1.5 text-xs font-semibold ${i.severity === "MUST_FIX" ? "bg-critical/15 text-critical" : "bg-warning/20 text-ink"}`}>
                    {i.severity === "MUST_FIX" ? "Fix" : "Check"}
                  </span>
                  <span className="text-ink-2">
                    <span className="text-ink">{i.message}.</span> {i.fix}.{" "}
                    {i.tab !== "overview" && <Link href={`/deals/${dealId}/${i.tab}`} className="underline">Go there</Link>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
