const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/pipeline", label: "Pipeline" },
  { href: "/oversight/me", label: "My compliance" },
  { href: "/oversight/broker", label: "Broker of record" },
  { href: "/oversight/accounting", label: "Accounting" },
];

/** Top bar shared by every screen. */
export function AppNav({ current }: { current: string }) {
  return (
    <nav aria-label="Main" className="border-b border-line bg-card">
      <div className="mx-auto flex max-w-[1600px] items-center gap-6 px-4 sm:px-6 lg:px-8">
        <span className="py-3 text-sm font-semibold tracking-tight text-ink">Back Office</span>
        <ul className="flex gap-1">
          {LINKS.map((l) => {
            const active = current === l.href;
            return (
              <li key={l.href}>
                <a
                  href={l.href + location.search}
                  aria-current={active ? "page" : undefined}
                  className={`block border-b-2 px-2 py-3 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
                    active ? "border-accent text-ink" : "border-transparent text-ink-2 hover:text-ink"
                  }`}
                >
                  {l.label}
                </a>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
