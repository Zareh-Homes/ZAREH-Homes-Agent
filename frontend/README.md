# Zareh Homes back office: frontend

React 18 + Tailwind CSS 3 (Vite).

## Dashboard

```
src/dashboard/
  types.ts                     GET /api/dashboard response
  useDashboard.ts              loads it (session cookie)
  format.ts                    money / date formatting
  components/ui.tsx            Panel, StatTile, StatusBadge, Meter, EmptyState
  components/AdminDashboard.tsx  financial summary, trust widget, FINTRAC exception queue
  components/AgentDashboard.tsx  personal analytics, PREC tax tracker, cap tracker, documents sent back
  components/Dashboard.tsx     picks the layout from the role; brokers who also sell get a toggle
  demo-data.ts                 fictional data for previews and tests
```

```bash
npm run dev          # http://localhost:5173, proxies /api to the backend on :3000
                     # add ?demo=admin | agent | broker to preview with demo data, &theme=dark for dark mode
npm run build        # demo data is excluded unless VITE_ENABLE_DEMO=true
```

Colours are tokens in `src/index.css` (light and dark chosen separately, `data-theme` overrides the OS setting). Status colours always come with an icon and a text label.

## Compliance module state

Framework-agnostic TypeScript. Screens read state through selectors and call the controller; they never call `fetch` themselves.

```
src/compliance/
  types.ts        API shapes, ApiError (with per-field errors)
  api.ts          HTTP + Server-Sent Events client
  state.ts        pure reducer + selectors (checklist, progress, blocking items, slot actions)
  controller.ts   store + async actions: loadDeal, upload, review, startNotifications, markRead
```

## React

```tsx
const api = createHttpApi();
const store = createStore();
const compliance = createComplianceController({ api, store, viewer: currentUser });

function useCompliance() {
  return useSyncExternalStore(store.subscribe, store.getState);
}

function DealChecklist({ dealId }: { dealId: string }) {
  const state = useCompliance();
  useEffect(() => { compliance.loadDeal(dealId); }, [dealId]);
  const checklist = selectChecklist(state, dealId);
  if (!checklist || checklist.status === "loading") return <Spinner />;

  return checklist.groups.map((group) => (
    <section key={group.title}>
      <h3>{group.title}</h3>
      {group.slots.map((slot) => {
        const actions = slotActions(state, slot.id, currentUser);
        const upload = state.uploads[slot.id];
        return (
          <DocumentRow
            key={slot.id}
            slot={slot}
            badge={STATUS_DISPLAY[slot.status]}
            fieldErrors={upload?.fieldErrors}       // e.g. "metadata.expiryDate"
            onUpload={actions.canUpload ? (file, meta) => compliance.upload(slot.id, file, file.name, meta) : undefined}
            onApprove={actions.canReview ? () => compliance.review(slot.id, "APPROVED") : undefined}
            onSendBack={actions.canReview ? (comment) => compliance.review(slot.id, "NEEDS_REVISION", comment) : undefined}
          />
        );
      })}
    </section>
  ));
}
```

Start live notifications once after sign-in: `const stop = await compliance.startNotifications();`. A notification about a deal that's on screen refreshes that checklist automatically.

## Test

```bash
npm install
npm test            # state tests (node:test) + component tests (Vitest)
npm run typecheck
```
