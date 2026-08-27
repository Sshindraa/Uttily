'use client';

import { type ChangeEvent, type ReactElement, useEffect, useRef } from 'react';
import type { PhotoSlotDefinition } from '@uttily/contracts';
import { PhotoGuideAnimationAdapter } from '../adapter';
import { captureVideoFrame } from './captureFrame';
import { useCamera } from './useCamera';
import styles from './CameraViewfinder.module.css';

export interface CameraViewfinderProps {
  slot: PhotoSlotDefinition;
  slotIndex: number;
  totalSlots: number;
  onCapture: (blob: Blob) => void;
  onReplayIntro: () => void;
}

export function CameraViewfinder({
  slot,
  slotIndex,
  totalSlots,
  onCapture,
  onReplayIntro,
}: CameraViewfinderProps): ReactElement {
  const { stream, isLoading, error, isSupported } = useCamera(true);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  const handleShutterClick = async () => {
    if (!videoRef.current) return;
    try {
      const blob = await captureVideoFrame(videoRef.current);
      onCapture(blob);
    } catch {
      // Fallback vers sélection de fichier en cas d'erreur de capture frame
      fileInputRef.current?.click();
    }
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onCapture(file);
    }
  };

  const OverlayComponent = PhotoGuideAnimationAdapter.resolveOverlay(slot.guide.overlayKey);

  if (!isSupported || error) {
    return (
      <div className={styles.container} role="region" aria-label="Viseur alternatif">
        <div className={styles.fallbackState}>
          <p>{error || 'Caméra non disponible sur cet appareil.'}</p>
          <button
            type="button"
            className={styles.fallbackBtn}
            onClick={() => fileInputRef.current?.click()}
          >
            Choisir une photo depuis l'appareil
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            className={styles.hiddenInput}
            onChange={handleFileChange}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container} role="region" aria-label={`Viseur photo pour ${slot.title}`}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={styles.video}
        aria-label="Flux vidéo de prise de vue"
      />

      {/* Ghost Overlay SVG anatomique transparent */}
      <OverlayComponent className={styles.overlay} />

      {/* Réticules holographiques de cadrage aux 4 coins */}
      <div className={styles.reticleTopLeft} aria-hidden="true" />
      <div className={styles.reticleTopRight} aria-hidden="true" />
      <div className={styles.reticleBottomLeft} aria-hidden="true" />
      <div className={styles.reticleBottomRight} aria-hidden="true" />

      {/* Barre supérieure : titre slot & bouton exemple */}
      <div className={styles.topBar}>
        <span className={styles.badge}>
          {slot.title} — {slotIndex}/{totalSlots}
        </span>
        <button
          type="button"
          className={styles.exampleBtn}
          onClick={onReplayIntro}
          aria-label="Revoir l'animation de cadrage"
        >
          Exemple ↺
        </button>
      </div>

      {/* Barre inférieure : indication & déclencheur */}
      <div className={styles.bottomBar}>
        <div className={styles.hint}>{slot.guide.helperHint}</div>
        <button
          type="button"
          className={styles.shutterBtn}
          onClick={handleShutterClick}
          disabled={isLoading}
          aria-label="Prendre la photo"
        >
          <div className={styles.shutterInner}>
            <div className={styles.shutterDot} />
          </div>
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        className={styles.hiddenInput}
        onChange={handleFileChange}
      />
    </div>
  );
}
