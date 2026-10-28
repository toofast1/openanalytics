"use client";

import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import * as React from "react";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { anonName } from "@/components/dashboard/anon-identity";
import {
  setGlobeVisitor,
  type GlobeVisitor,
} from "@/components/dashboard/globe-visitor-store";
import { UserAvatar } from "@/components/ui/user-avatar";
import { useRealtime } from "@/hooks/use-realtime";
import { countryCentroid } from "@/lib/country-centroids";

/**
 * OpenFreeMap globe (MapLibre GL, no API key). The canvas is transparent
 * outside the planet, so the globe floats directly on the page background.
 *
 * Live visitors ride on it as avatar markers, pinned at their country. The
 * markers are `snapshot.present` — the visitors presence itself says are
 * here (ADR-0035, frontend_tasks §28) — so the globe and the realtime board
 * can never disagree about who is online. The old model derived markers from
 * the page-view feed under a client-side 60-second window, which dropped a
 * long reader off the planet while they were heartbeating perfectly; the
 * server owns the window now, and everyone drawn here is online by
 * definition.
 *
 * A `present` row can carry `country: null` (a heartbeat with no geo, a
 * GeoLite2 miss) — there is no honest place on a planet to pin that, so
 * those visitors are neither dropped silently nor pinned somewhere invented:
 * they are counted on a ledge at the globe's edge instead.
 *
 * `country` is per-visitor and nothing finer, so a country-level pin is the
 * honest resolution (the `cities` breakdown is an aggregate top-10 with no
 * per-visitor link). Clicking a marker hands the visitor to the floating tab
 * bar, which morphs open with the details.
 */
/**
 * The style pass that turns the stock Liberty style into our globe: English
 * labels, our palette, no terrain raster. Exported because the landing's
 * globe plate must be the *same* globe — a marketing page drawing its own
 * version of a screen the product already ships is how the two drift apart.
 */
export function applyGlobeStyle(map: maplibregl.Map) {
  // The stock style renders "Latin name \n native name" — rewrite every
  // label to English only (falling back to latin/local where missing).
  const englishOnly: maplibregl.ExpressionSpecification = [
    "coalesce",
    ["get", "name:en"],
    ["get", "name:latin"],
    ["get", "name"],
  ];
  for (const layer of map.getStyle().layers) {
    if (
      layer.type === "symbol" &&
      map.getLayoutProperty(layer.id, "text-field")
    ) {
      map.setLayoutProperty(layer.id, "text-field", englishOnly);
    }
    // Country names ship in Noto Sans Bold — soften them to Regular
    if (layer.id.startsWith("label_country")) {
      map.setLayoutProperty(layer.id, "text-font", ["Noto Sans Regular"]);
    }
  }

  // Palette sampled from the reference shot: the land base itself is the
  // light green (#d8efc9) — not white — and the ocean is a cyan-leaning
  // sky blue (#81c9f9); vegetation is only a slightly deeper green.
  const recolor: Array<
    [string, "background-color" | "fill-color" | "line-color", string]
  > = [
    ["background", "background-color", "#d8efc9"],
    ["water", "fill-color", "#81c9f9"],
    ["waterway_river", "line-color", "#81c9f9"],
    ["waterway_other", "line-color", "#81c9f9"],
    ["landcover_wood", "fill-color", "hsla(102, 48%, 78%, 0.85)"],
    ["landcover_grass", "fill-color", "#cdeab8"],
    ["park", "fill-color", "#cdeab8"],
    ["landcover_ice", "fill-color", "#f4f9f6"],
    ["landcover_sand", "fill-color", "#fbf9f8"],
    ["boundary_2", "line-color", "#e9a1a5"],
    ["boundary_3", "line-color", "#f0c3c6"],
    ["boundary_disputed", "line-color", "#e9a1a5"],
  ];
  for (const [id, prop, color] of recolor) {
    if (map.getLayer(id)) map.setPaintProperty(id, prop, color);
  }
  // The terrain-shaded raster fights the flat look — hide it
  if (map.getLayer("natural_earth")) {
    map.setLayoutProperty("natural_earth", "visibility", "none");
  }
}

/**
 * Eastward auto-spin that yields to gestures, and the click-to-pause it
 * carries. Returns its own teardown.
 *
 * Only a TRUE click (press without drag) toggles the spin — a release at the
 * end of a manual rotation must not. While spinning, drags rotate the globe
 * by hand and wheel-zooms run their animation; the spin yields for exactly
 * that gesture, then continues eastward from wherever it ended.
 */
export function startGlobeSpin(
  map: maplibregl.Map,
  {
    speed = 0.1,
    pausable = true,
  }: {
    speed?: number;
    /**
     * Whether the pointer can stop the planet. False for a decorative globe:
     * `interactive: false` disables MapLibre's *handlers*, but the map still
     * emits `click` and `mousedown`, so without this a stray click on the
     * landing would freeze a scene nobody asked to control.
     */
    pausable?: boolean;
  } = {}
): () => void {
  let spinEnabled = true;
  let pointerDown = false;
  let dragging = false;
  let dragged = false;
  let frame = 0;

  if (!pausable) {
    const spinOnly = () => {
      const center = map.getCenter();
      center.lng += speed;
      map.jumpTo({ center });
      frame = requestAnimationFrame(spinOnly);
    };
    frame = requestAnimationFrame(spinOnly);
    return () => cancelAnimationFrame(frame);
  }
  // The spin's per-frame jumpTo cancels a gesture that is still forming
  // (press → first move), so it must hold off while the pointer is down —
  // otherwise dragging is only possible with the spin paused.
  map.on("mousedown", () => {
    pointerDown = true;
    dragged = false;
  });
  map.on("touchstart", () => {
    pointerDown = true;
    dragged = false;
  });
  const onPointerUp = () => {
    pointerDown = false;
  };
  window.addEventListener("pointerup", onPointerUp);
  map.on("dragstart", () => {
    dragging = true;
    dragged = true;
  });
  map.on("dragend", () => {
    dragging = false;
    // Cancel the release-momentum glide — a westward flick would read as
    // the globe spinning backwards
    map.stop();
  });
  map.on("click", () => {
    if (!dragged) spinEnabled = !spinEnabled;
  });
  const spin = () => {
    // A zoom animation in flight would be cancelled by jumpTo (that reads as
    // a hiccup), so the spin yields to it as it does to a drag. It used to
    // keep turning by writing to `map.transform`, which MapLibre 6 no longer
    // exposes.
    if (spinEnabled && !pointerDown && !dragging && !map.isMoving()) {
      const center = map.getCenter();
      center.lng += speed;
      map.jumpTo({ center });
    }
    frame = requestAnimationFrame(spin);
  };
  frame = requestAnimationFrame(spin);

  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("pointerup", onPointerUp);
  };
}

export function GlobeMap({ slug }: { slug: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<maplibregl.Map | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // MapLibre 6 derives its worker's URL from its own `import.meta.url` at
    // runtime, which no bundler can follow — under Turbopack the worker 404s
    // and the globe draws no tiles. Spelling the path as a static
    // `new URL(…, import.meta.url)` makes the bundler emit the file and hand
    // back where it put it.
    maplibregl.setWorkerUrl(
      new URL("maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url).href,
    );
    const map = new maplibregl.Map({
      container,
      style: "https://tiles.openfreemap.org/styles/liberty",
      // Centered on the equator: at lat 0 the globe's latitude compensation
      // is zero, so the zoom-out floor below is exact — no dip possible
      center: [15, 0],
      // minZoom equals the starting zoom, so the default view IS the
      // zoom-out floor — the globe can only be zoomed in from here
      zoom: 2.4,
      minZoom: 2.4,
      maxZoom: 8,
      attributionControl: false,
    });

    // Globe projection's latitude compensation lets the camera slip below
    // minZoom (by log2(1/cos(lat))) — clamp it back by hand
    // Async event callback, so the setState-in-effect rule stays satisfied —
    // and markers only ever attach to a fully styled map.
    map.on("style.load", () => {
      setMap(map);
      map.setProjection({ type: "globe" });
      applyGlobeStyle(map);
    });

    const stopSpin = startGlobeSpin(map);

    return () => {
      stopSpin();
      map.remove();
      setMap(null);
      setGlobeVisitor(null);
    };
  }, []);

  return (
    // Relative, so the unknown-location ledge can sit over the planet's edge.
    <div className="relative size-full">
      <div ref={containerRef} className="size-full" />
      {map ? <VisitorMarkers map={map} slug={slug} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Live visitors as avatar markers                                     */
/* ------------------------------------------------------------------ */

type PinnedVisitor = GlobeVisitor & { lngLat: [number, number] };

/**
 * One marker per present visitor, portal-rendered so the avatar stays a React
 * component inside MapLibre's DOM marker. Several visitors from one country
 * fan out in a small spiral around the centroid instead of stacking.
 *
 * No client-side clock and no online arithmetic: `present` is the online set,
 * server-owned (ADR-0035). A visitor leaves the globe when the next snapshot
 * no longer lists them, and not a moment before.
 */
function VisitorMarkers({
  map,
  slug,
}: {
  map: maplibregl.Map;
  slug: string;
}) {
  const { snapshot } = useRealtime(slug);

  const { visitors, unplottable } = React.useMemo(() => {
    const present = snapshot?.present ?? [];
    const perCountry = new Map<string, number>();
    const pinned: PinnedVisitor[] = [];
    let unplottable = 0;
    for (const row of present) {
      const country = row.country ?? "unknown";
      const centroid = countryCentroid(country);
      if (centroid === null) {
        // No honest place on the planet — counted on the ledge instead of
        // being dropped silently or pinned somewhere invented.
        unplottable += 1;
        continue;
      }
      const index = perCountry.get(country) ?? 0;
      perCountry.set(country, index + 1);
      // Sunflower spread: countrymates ring the centroid instead of stacking.
      const angle = index * 2.39996;
      const radius = index === 0 ? 0 : 1.5 * Math.sqrt(index);
      pinned.push({
        hash: row.visitor,
        name: anonName(row.visitor),
        country,
        deviceType: row.device_type ?? "unknown",
        browser: row.browser,
        os: row.os,
        lastSeenMs: Date.parse(row.last_seen_at),
        online: true,
        lngLat: [
          centroid[0] + radius * Math.cos(angle),
          centroid[1] + radius * Math.sin(angle),
        ],
      });
    }
    return { visitors: pinned, unplottable };
  }, [snapshot]);

  /**
   * MapLibre owns the marker containers; React owns their contents. The
   * effect reconciles markers to the visitor list, then a microtask-hopped
   * state write hands the live containers to the portal render below.
   */
  const markersRef = useRef(
    new Map<string, { marker: maplibregl.Marker; el: HTMLDivElement }>()
  );
  const [portalTargets, setPortalTargets] = useState<
    Array<{ hash: string; el: HTMLDivElement }>
  >([]);

  useEffect(() => {
    const markers = markersRef.current;
    const alive = new Set(visitors.map((visitor) => visitor.hash));

    for (const [hash, entry] of markers) {
      if (!alive.has(hash)) {
        entry.marker.remove();
        markers.delete(hash);
      }
    }
    for (const visitor of visitors) {
      const existing = markers.get(visitor.hash);
      if (existing) {
        existing.marker.setLngLat(visitor.lngLat);
        continue;
      }
      const el = document.createElement("div");
      // Fully hidden on the planet's far side — the default keeps covered
      // markers faintly visible, which reads as a ghost. The transition
      // makes the horizon crossing a fade, not a pop.
      el.style.transition = "opacity 0.3s ease";
      const marker = new maplibregl.Marker({
        element: el,
        opacity: "1",
        opacityWhenCovered: "0",
      })
        .setLngLat(visitor.lngLat)
        .addTo(map);
      markers.set(visitor.hash, { marker, el });
    }

    const next = visitors
      .map((visitor) => {
        const entry = markers.get(visitor.hash);
        return entry ? { hash: visitor.hash, el: entry.el } : null;
      })
      .filter((entry): entry is { hash: string; el: HTMLDivElement } =>
        Boolean(entry)
      );
    void Promise.resolve().then(() => setPortalTargets(next));
  }, [map, visitors]);

  useEffect(() => {
    const markers = markersRef.current;
    return () => {
      for (const entry of markers.values()) entry.marker.remove();
      markers.clear();
    };
  }, []);

  const byHash = new Map(visitors.map((visitor) => [visitor.hash, visitor]));

  return (
    <>
      {portalTargets.map(({ hash, el }) => {
        const visitor = byHash.get(hash);
        if (!visitor) return null;
        return createPortal(
          <button
            aria-label={`View details for ${visitor.name}`}
            className="group relative block cursor-pointer rounded-full outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring active:scale-95"
            onClick={(event) => {
              // The map toggles its spin on plain clicks — an avatar pick
              // should not also pause the planet.
              event.stopPropagation();
              setGlobeVisitor(visitor);
            }}
            type="button"
          >
            <span className="block rounded-full border-2 border-white bg-white shadow-[0_2px_8px_rgba(0,0,0,0.25)]">
              <UserAvatar seed={visitor.hash} size={30} />
            </span>
            {/* Everyone on the planet is online by construction now — the
                dot is the live affordance, not a distinction. */}
            <span
              aria-hidden="true"
              className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-white bg-primary"
            />
          </button>,
          el,
          hash
        );
      })}

      {/* The ledge: present visitors whose row carries no country — a VPN, a
          GeoLite2 miss — have no honest pin, so they are stated at the edge
          of the map rather than dropped or invented (frontend_tasks §28). */}
      {unplottable > 0 ? (
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2">
          <span className="flex items-center gap-1.5 whitespace-nowrap rounded-full bg-card/90 px-3 py-1.5 text-xs text-muted-foreground shadow-[0_1px_2px_rgba(0,0,0,0.08)] ring-1 ring-border backdrop-blur">
            <span
              aria-hidden="true"
              className="bp-pulse size-1.5 rounded-full bg-primary"
            />
            {unplottable} online · location unknown
          </span>
        </div>
      ) : null}
    </>
  );
}
