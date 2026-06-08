import { useEffect } from "react";
// eslint-disable-next-line import/no-extraneous-dependencies
import { TheIntroDbApiError, getMedia } from "theintrodb";

import { usePlayerMeta } from "@/components/player/hooks/usePlayerMeta";
import type { PlayerMeta } from "@/stores/player/slices/source";
import { usePlayerStore } from "@/stores/player/store";
import { usePreferencesStore } from "@/stores/preferences";

// Track the source of the current skip time (for analytics filtering)
let currentSkipTimeSource: "theintrodb" | null = null;

// Prevent multiple components from triggering overlapping fetches for the same media
let fetchingForCacheKey: string | null = null;

/** Cache key for skip segments – matches TIDB API (tmdbId + season + episode number). */
function getSkipSegmentsCacheKey(meta: PlayerMeta | null): string | null {
  if (!meta?.tmdbId) return null;
  if (meta.type === "movie") return `skip-${meta.type}-${meta.tmdbId}`;
  if (meta.type === "show" && meta.season != null && meta.episode != null) {
    return `skip-${meta.type}-${meta.tmdbId}-${meta.season.number}-${meta.episode.number}`;
  }
  return null;
}

export function useSkipTimeSource(): typeof currentSkipTimeSource {
  return currentSkipTimeSource;
}

export interface SegmentData {
  type: "intro" | "recap" | "credits" | "preview";
  start_ms: number | null;
  end_ms: number | null;
  confidence: number | null;
  submission_count: number;
}

function parseTmdbId(tmdbId: unknown): number | null {
  if (typeof tmdbId === "number" && Number.isFinite(tmdbId)) return tmdbId;
  if (typeof tmdbId === "string") {
    const trimmed = tmdbId.trim();
    if (!trimmed) return null;
    const asNumber = Number(trimmed);
    if (!Number.isFinite(asNumber)) return null;
    return asNumber;
  }
  return null;
}

export function useSkipTime() {
  const { playerMeta: meta } = usePlayerMeta();
  const cacheKey = getSkipSegmentsCacheKey(meta ?? null);
  const skipSegmentsCacheKey = usePlayerStore((s) => s.skipSegmentsCacheKey);
  const skipSegments = usePlayerStore((s) => s.skipSegments);
  const setSkipSegments = usePlayerStore((s) => s.setSkipSegments);
  const tidbKey = usePreferencesStore((s) => s.tidbKey);

  useEffect(() => {
    if (!cacheKey) return;
    // Already have segments for this media – don't refetch (e.g. when opening menu)
    if (usePlayerStore.getState().skipSegmentsCacheKey === cacheKey) return;
    // Another fetch for this key is already in progress (e.g. two components mounted)
    if (fetchingForCacheKey === cacheKey) return;
    fetchingForCacheKey = cacheKey;

    const fetchTheIntroDBSegments = async (): Promise<SegmentData[] | null> => {
      const tmdbId = parseTmdbId(meta?.tmdbId);
      if (!tmdbId) return [];

      try {
        const result = await getMedia(
          meta?.type === "show" &&
            meta.season?.number != null &&
            meta.episode?.number != null
            ? {
                tmdbId,
                season: meta.season.number,
                episode: meta.episode.number,
              }
            : { tmdbId },
          tidbKey ? { apiKey: tidbKey } : undefined,
        );

        const fetchedSegments: SegmentData[] = [];

        const addSegments = (
          type: SegmentData["type"],
          segments: Array<{
            startMs: number;
            endMs: number | null;
            confidence?: number | null;
            submissionCount?: number | null;
          }>,
        ) => {
          for (const segment of segments) {
            fetchedSegments.push({
              type,
              start_ms: segment.startMs,
              end_ms: segment.endMs,
              confidence: segment.confidence ?? null,
              submission_count: segment.submissionCount ?? 1,
            });
          }
        };

        addSegments("intro", result.intro);
        addSegments("recap", result.recap);
        addSegments("credits", result.credits);
        addSegments("preview", result.preview);

        return fetchedSegments;
      } catch (error: unknown) {
        if (error instanceof TheIntroDbApiError && error.status === 404) {
          return null;
        }
        console.error("Error fetching TIDB segments:", error);
        return [];
      }
    };

    const applySegments = (segmentsToApply: SegmentData[]) => {
      // Only update store if this fetch is still for the current media (avoid stale overwrite)
      const currentKey = getSkipSegmentsCacheKey(
        usePlayerStore.getState().meta ?? null,
      );
      if (currentKey === cacheKey) {
        setSkipSegments(cacheKey, segmentsToApply);
      }
    };

    const fetchSkipTime = async (): Promise<void> => {
      currentSkipTimeSource = null;

      try {
        const tidbSegments = await fetchTheIntroDBSegments();
        if (tidbSegments === null) {
          applySegments([]);
          return;
        }

        currentSkipTimeSource = "theintrodb";
        applySegments(tidbSegments);
      } finally {
        if (fetchingForCacheKey === cacheKey) {
          fetchingForCacheKey = null;
        }
      }
    };

    fetchSkipTime();
  }, [
    cacheKey,
    meta?.tmdbId,
    meta?.title,
    meta?.type,
    meta?.season?.number,
    meta?.episode?.number,
    setSkipSegments,
    tidbKey,
  ]);

  // Only return segments when they're for the current media (avoid showing stale data)
  return cacheKey === skipSegmentsCacheKey ? skipSegments : [];
}
