'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import type {
  PublicOfferSearchItem,
  PublicSearchDestinationOption,
  PublicSearchViewport,
} from '@uttily/core';
import type { PublicUiLocale } from '@/lib/public-search';
import styles from './search.module.css';

import type { Map as MapLibreMap, Marker as MapLibreMarker } from 'maplibre-gl';

type MapLibreModule = typeof import('maplibre-gl');

interface SearchMapProps {
  locale: PublicUiLocale;
  destination: PublicSearchDestinationOption;
  items: PublicOfferSearchItem[];
  initialViewport?: PublicSearchViewport | undefined;
  canSearch: boolean;
  isSearching: boolean;
  onSearchViewport: (viewport: PublicSearchViewport) => Promise<boolean>;
}

const MAP_LOAD_TIMEOUT_MS = 15000;

export function SearchMap({
  locale,
  destination,
  items,
  initialViewport,
  canSearch,
  isSearching,
  onSearchViewport,
}: SearchMapProps): React.ReactElement {
  const fr = locale === 'fr';
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const mapLibreRef = useRef<MapLibreModule | null>(null);
  const markersRef = useRef<MapLibreMarker[]>([]);
  const callbackRef = useRef(onSearchViewport);
  const initializingRef = useRef(true);
  const [ready, setReady] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [pendingViewport, setPendingViewport] = useState<PublicSearchViewport | null>(null);

  callbackRef.current = onSearchViewport;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let loadTimeoutId: number | undefined;
    let initializationTimeoutId: number | undefined;
    let map: MapLibreMap | null = null;

    const failClosed = (): void => {
      if (disposed) return;
      setReady(false);
      setUnavailable(true);
      const failedMap = map;
      if (failedMap) {
        try {
          failedMap.remove();
        } catch {
          // The list fallback must remain usable if provider cleanup fails.
        }
        if (mapRef.current === failedMap) mapRef.current = null;
        map = null;
      }
      const markers = markersRef.current;
      markersRef.current = [];
      for (const marker of markers) {
        try {
          marker.remove();
        } catch {
          // Provider cleanup is best effort and must not expose provider details.
        }
      }
    };

    const key = process.env.NEXT_PUBLIC_MAPTILER_API_KEY;
    if (!isUsableMapTilerKey(key)) {
      failClosed();
      return;
    }

    const styleUrl = `https://api.maptiler.com/maps/streets-v4/style.json?key=${encodeURIComponent(key)}`;
    const initialArea = initialViewport ?? {
      kind: 'VIEWPORT' as const,
      south: destination.bbox.south,
      west: destination.bbox.west,
      north: destination.bbox.north,
      east: destination.bbox.east,
    };
    const initialCenter = initialViewport ? viewportCenter(initialViewport) : destination.center;

    void (async () => {
      try {
        const maplibre = await import('maplibre-gl');
        if (disposed) return;
        if (!isWebGLAvailable()) {
          failClosed();
          return;
        }

        mapLibreRef.current = maplibre;
        map = new maplibre.Map({
          container,
          style: styleUrl,
          center: [initialCenter.longitude, initialCenter.latitude],
          zoom: 9,
          attributionControl: { compact: true },
        });
        mapRef.current = map;
        map.addControl(new maplibre.NavigationControl({ showCompass: true }), 'top-right');
        const canvas = map.getCanvas();
        canvas.setAttribute('tabindex', '0');
        canvas.setAttribute('role', 'application');
        canvas.setAttribute(
          'aria-label',
          fr ? 'Carte interactive de recherche' : 'Interactive search map',
        );

        map.on('error', failClosed);
        map.on('moveend', () => {
          if (disposed || initializingRef.current || !map) return;
          const viewport = readViewport(map);
          if (viewport) setPendingViewport(viewport);
        });
        map.once('load', () => {
          if (disposed || !map) return;
          if (!fitInitialArea(map, initialArea)) {
            map.setCenter([initialCenter.longitude, initialCenter.latitude]);
          }
          syncMarkers(maplibre, map, items, markersRef);
          setReady(true);
          if (loadTimeoutId !== undefined) window.clearTimeout(loadTimeoutId);
          initializationTimeoutId = window.setTimeout(() => {
            initializingRef.current = false;
          }, 300);
        });
        loadTimeoutId = window.setTimeout(failClosed, MAP_LOAD_TIMEOUT_MS);
      } catch {
        failClosed();
      }
    })();

    return () => {
      disposed = true;
      if (loadTimeoutId !== undefined) window.clearTimeout(loadTimeoutId);
      if (initializationTimeoutId !== undefined) {
        window.clearTimeout(initializationTimeoutId);
      }
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];
      mapRef.current?.remove();
      mapRef.current = null;
      mapLibreRef.current = null;
    };
    // A destination change remounts this component from SearchResults.
  }, [destination.publicId]);

  useEffect(() => {
    const map = mapRef.current;
    const maplibre = mapLibreRef.current;
    if (!ready || !map || !maplibre) return;
    syncMarkers(maplibre, map, items, markersRef);
  }, [items, ready]);

  if (unavailable) {
    return (
      <p className={styles.mapUnavailable} role="status">
        {fr
          ? 'La carte est momentanément indisponible. La liste reste utilisable.'
          : 'The map is temporarily unavailable. The list is still usable.'}
      </p>
    );
  }

  const handleSearch = async (): Promise<void> => {
    if (!pendingViewport || !canSearch || isSearching) return;
    const success = await callbackRef.current(pendingViewport);
    if (success) setPendingViewport(null);
  };

  return (
    <div className={styles.mapShell}>
      <div ref={containerRef} className={styles.map} aria-busy={!ready || isSearching} />
      <div className={styles.mapOverlay}>
        {pendingViewport ? (
          <button
            type="button"
            className={styles.viewportButton}
            onClick={() => void handleSearch()}
            disabled={!canSearch || isSearching}
          >
            {isSearching
              ? fr
                ? 'Recherche…'
                : 'Searching…'
              : fr
                ? 'Rechercher dans cette zone'
                : 'Search this area'}
          </button>
        ) : null}
      </div>
      <p className={styles.mapLegend}>
        {fr
          ? 'Déplacez la carte ou utilisez les contrôles de zoom, puis recherchez explicitement dans la zone visible.'
          : 'Move the map or use the zoom controls, then explicitly search the visible area.'}
      </p>
    </div>
  );
}

function isUsableMapTilerKey(value: string | undefined): value is string {
  if (!value || value.trim() !== value || value.length < 8 || /\s/.test(value)) return false;
  return !/^(?:your[-_ ]|change[-_ ]?me|undefined|null)/i.test(value);
}

function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

function fitInitialArea(map: MapLibreMap, area: PublicSearchViewport): boolean {
  if (!isValidViewport(area)) return false;
  try {
    if (area.west <= area.east) {
      map.fitBounds(
        [
          [area.west, area.south],
          [area.east, area.north],
        ],
        { padding: 44, duration: 0, maxZoom: 13 },
      );
    } else {
      // Keep the dateline crossing deterministic without asking MapLibre to
      // interpret an inverted LngLatBounds differently by version.
      const center = viewportCenter(area);
      map.setCenter([center.longitude, center.latitude]);
      map.setZoom(3);
    }
    return true;
  } catch {
    return false;
  }
}

function readViewport(map: MapLibreMap): PublicSearchViewport | null {
  try {
    const bounds = map.getBounds();
    const viewport: PublicSearchViewport = {
      kind: 'VIEWPORT',
      south: clamp(bounds.getSouth(), -90, 90),
      west: normalizeLongitude(bounds.getWest()),
      north: clamp(bounds.getNorth(), -90, 90),
      east: normalizeLongitude(bounds.getEast()),
    };
    return isValidViewport(viewport) ? viewport : null;
  } catch {
    return null;
  }
}

function normalizeLongitude(value: number): number {
  const wrapped = ((((value + 180) % 360) + 360) % 360) - 180;
  if (wrapped === -180 && value > 0) return 180;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isValidViewport(viewport: PublicSearchViewport): boolean {
  return (
    viewport.kind === 'VIEWPORT' &&
    Number.isFinite(viewport.south) &&
    Number.isFinite(viewport.west) &&
    Number.isFinite(viewport.north) &&
    Number.isFinite(viewport.east) &&
    viewport.south >= -90 &&
    viewport.south <= 90 &&
    viewport.north >= -90 &&
    viewport.north <= 90 &&
    viewport.west >= -180 &&
    viewport.west <= 180 &&
    viewport.east >= -180 &&
    viewport.east <= 180 &&
    viewport.south < viewport.north
  );
}

function viewportCenter(viewport: PublicSearchViewport): { latitude: number; longitude: number } {
  const longitude =
    viewport.west <= viewport.east
      ? (viewport.west + viewport.east) / 2
      : viewport.west + (viewport.east + 360 - viewport.west) / 2;
  return {
    latitude: (viewport.south + viewport.north) / 2,
    longitude: longitude > 180 ? longitude - 360 : longitude,
  };
}

function syncMarkers(
  maplibre: MapLibreModule,
  map: MapLibreMap,
  items: PublicOfferSearchItem[],
  markersRef: { current: MapLibreMarker[] },
): void {
  markersRef.current.forEach((marker) => marker.remove());
  markersRef.current = items.map((item) => {
    const element = document.createElement('span');
    element.className =
      item.geographicMatch === 'VIEWPORT_ALTERNATIVE' ? styles.markerAlternative! : styles.marker!;
    element.setAttribute('aria-hidden', 'true');
    return new maplibre.Marker({ element, anchor: 'bottom' })
      .setLngLat([item.longitude, item.latitude])
      .addTo(map);
  });
}
