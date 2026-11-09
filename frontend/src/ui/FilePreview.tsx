import { useEffect, useState } from "react";
import { Button } from "./kit.tsx";

/**
 * A document shown in place (PDF or image), so a reviewer doesn't have to download it. The file is fetched with the
 * signed-in session and shown from a local blob: link (the API never allows itself to be framed); the link is
 * released when the preview closes.
 */
export function FilePreview({ fileId, fileName }: { fileId: string; fileName?: string }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<{ url: string; type: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let url = "";
    let cancelled = false;
    setError(null);
    fetch(`/api/documents/files/${fileId}/content`, { credentials: "same-origin" })
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 403 ? "You can't open this file." : "The file couldn't be loaded.");
        const blob = await res.blob();
        url = URL.createObjectURL(blob);
        if (!cancelled) setView({ url, type: blob.type });
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
      setView(null);
    };
  }, [open, fileId]);
  if (!open) return <Button variant="ghost" onClick={() => setOpen(true)}>Show file</Button>;
  return (
    <div className="mt-2 w-full rounded-lg border border-line bg-sunken/50 p-2">
      <div className="mb-2 flex items-center justify-between gap-2 text-xs text-ink-2">
        <span className="truncate">{fileName ?? "Document"}</span>
        <Button variant="ghost" onClick={() => setOpen(false)}>Hide file</Button>
      </div>
      {error ? <p className="text-sm text-critical">{error}</p>
        : !view ? <p className="text-sm text-ink-2">Loading…</p>
        : view.type.startsWith("image/") ? <img src={view.url} alt={fileName ?? "Document"} className="mx-auto max-h-[70vh] max-w-full" />
        : <iframe src={view.url} title={`Preview of ${fileName ?? "the document"}`} className="h-[70vh] w-full rounded bg-card" />}
    </div>
  );
}
