import { Suspense } from "react";
import type { Metadata } from "next";
import { TryOnStudio } from "@/components/tryon/TryOnStudio";

export const metadata: Metadata = {
  title: "Virtual Try-On",
  description:
    "Place any Aurelia ring on your own finger in real time using your camera. Runs entirely in your browser — no video is uploaded.",
};

export default function TryOnPage() {
  return (
    // useSearchParams needs a Suspense boundary so the shell can still be
    // prerendered while the studio waits for the URL on the client.
    <Suspense fallback={<StudioSkeleton />}>
      <TryOnStudio />
    </Suspense>
  );
}

function StudioSkeleton() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8 lg:py-12">
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="aspect-[3/4] w-full animate-pulse rounded-3xl bg-surface-muted sm:aspect-[4/3] lg:aspect-square" />
        <div className="space-y-4">
          <div className="h-8 w-2/3 animate-pulse rounded bg-surface-muted" />
          <div className="h-4 w-1/3 animate-pulse rounded bg-surface-muted" />
          <div className="h-24 w-full animate-pulse rounded bg-surface-muted" />
        </div>
      </div>
    </div>
  );
}
