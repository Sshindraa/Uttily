'use client';

import { type ReactElement, useState, useEffect, useRef } from 'react';
import { BIKE_PHOTO_SLOTS, type PhotoSlotType } from '@uttily/contracts';
import type { ProductPhotoSummary } from '@uttily/core';
import { uploadProductPhotoAction } from '@/app/actions/product-photos';
import { CameraViewfinder } from './camera/CameraViewfinder';
import { PhotoGuideIntro } from './PhotoGuideIntro';
import { PhotoChecklist } from './PhotoChecklist';
import styles from './PhotoCoachModal.module.css';

export interface PhotoCoachModalProps {
  orgId: string;
  productId: string;
  slotType?: PhotoSlotType;
  isOpen: boolean;
  onClose: () => void;
  onPhotoUploaded?: (photo: ProductPhotoSummary) => void;
}

type PhotoCoachStep = 'INTRO' | 'CAMERA' | 'CHECKLIST' | 'SAVING';

const EXPERT_MODE_STORAGE_KEY = 'uttily_photo_coach_expert_mode';

export function PhotoCoachModal({
  orgId,
  productId,
  slotType = 'FULL_BIKE',
  isOpen,
  onClose,
  onPhotoUploaded,
}: PhotoCoachModalProps): ReactElement | null {
  const slot = BIKE_PHOTO_SLOTS[slotType] || BIKE_PHOTO_SLOTS.FULL_BIKE;

  const [isExpertMode, setIsExpertMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem(EXPERT_MODE_STORAGE_KEY) === 'true';
  });

  const [step, setStep] = useState<PhotoCoachStep>(() => (isExpertMode ? 'CAMERA' : 'INTRO'));
  const [capturedBlob, setCapturedBlob] = useState<Blob | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      if (!openerRef.current) {
        openerRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
      }
      setError(null);
      setCapturedBlob(null);
      setStep(isExpertMode ? 'CAMERA' : 'INTRO');
    }
  }, [isOpen, isExpertMode]);

  useEffect(() => {
    if (!isOpen) return;

    const focusableSelector =
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
    const focusInitialControl = window.requestAnimationFrame(() => closeButtonRef.current?.focus());

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;

      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [],
      ).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusInitialControl);
      document.removeEventListener('keydown', handleKeyDown);
      const opener = openerRef.current;
      if (opener?.isConnected) window.requestAnimationFrame(() => opener.focus());
      openerRef.current = null;
    };
  }, [isOpen, onClose]);

  const handleToggleExpertMode = (checked: boolean) => {
    setIsExpertMode(checked);
    if (typeof window !== 'undefined') {
      localStorage.setItem(EXPERT_MODE_STORAGE_KEY, checked ? 'true' : 'false');
    }
  };

  const handleCapture = (blob: Blob) => {
    setCapturedBlob(blob);
    setStep('CHECKLIST');
  };

  const handleRetake = () => {
    setCapturedBlob(null);
    setStep('CAMERA');
  };

  const handleConfirmAndUpload = async () => {
    if (!capturedBlob) return;

    setIsSaving(true);
    setError(null);

    try {
      const photoId = crypto.randomUUID();
      const file = new File([capturedBlob], `bike-${slotType.toLowerCase()}-${Date.now()}.jpg`, {
        type: 'image/jpeg',
      });

      const formData = new FormData();
      formData.append('productId', productId);
      formData.append('photoId', photoId);
      formData.append('slotType', slotType);
      formData.append('file', file);

      const result = await uploadProductPhotoAction(
        orgId,
        { ok: false, code: 'UNKNOWN', message: '' },
        formData,
      );

      if (result.ok) {
        onPhotoUploaded?.(result.data);
        onClose();
      } else {
        setError(result.message || 'Erreur lors de l’envoi de la photo.');
      }
    } catch {
      setError('Une erreur inattendue est survenue lors de l’enregistrement.');
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-labelledby="photo-coach-title"
      ref={dialogRef}
    >
      <div className={styles.modal}>
        <div className={styles.header}>
          <div id="photo-coach-title" className={styles.headerTitle}>
            <span>Photo Coach Uttily</span>
            <span
              style={{
                fontSize: '0.85rem',
                color: 'var(--ut-color-ink-muted)',
                fontWeight: 500,
              }}
            >
              — {slot.title}
            </span>
          </div>

          <div className={styles.headerActions}>
            <label className={styles.expertToggle}>
              <input
                type="checkbox"
                checked={isExpertMode}
                onChange={(e) => handleToggleExpertMode(e.target.checked)}
              />
              Mode rapide
            </label>
            <button
              type="button"
              className={styles.closeBtn}
              onClick={onClose}
              aria-label="Fermer le Photo Coach"
              ref={closeButtonRef}
            >
              ✕
            </button>
          </div>
        </div>

        <div className={styles.body}>
          {error && (
            <div className={styles.errorBanner} role="alert">
              {error}
            </div>
          )}

          {step === 'INTRO' && (
            <PhotoGuideIntro slot={slot} onProceedToCamera={() => setStep('CAMERA')} />
          )}

          {step === 'CAMERA' && (
            <CameraViewfinder
              slot={slot}
              slotIndex={1}
              totalSlots={3}
              onCapture={handleCapture}
              onReplayIntro={() => setStep('INTRO')}
            />
          )}

          {(step === 'CHECKLIST' || step === 'SAVING') && capturedBlob && (
            <PhotoChecklist
              slot={slot}
              imageBlob={capturedBlob}
              isSaving={isSaving}
              onRetake={handleRetake}
              onConfirm={handleConfirmAndUpload}
            />
          )}
        </div>
      </div>
    </div>
  );
}
