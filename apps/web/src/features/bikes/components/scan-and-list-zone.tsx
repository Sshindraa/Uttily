'use client';

import { useState, useRef, useTransition, type DragEvent, type ChangeEvent } from 'react';
import type { EquipmentEnrichmentProposal } from '@uttily/intelligence';
import { scanEquipmentPhotoAction } from '@/app/actions/equipment-scan';
import styles from './scan-and-list-zone.module.css';

interface ScanAndListZoneProps {
  organizationId: string;
  onProposal: (proposal: EquipmentEnrichmentProposal) => void;
  onPhotoSelected?: (file: File) => void;
}

export function ScanAndListZone({
  organizationId,
  onProposal,
  onPhotoSelected,
}: ScanAndListZoneProps): React.ReactElement {
  const [isPending, startTransition] = useTransition();
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<EquipmentEnrichmentProposal | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleDragOver(e: DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }

  function handleDragLeave(e: DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      if (file) {
        processFile(file);
      }
    }
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>): void {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      if (file) {
        processFile(file);
      }
    }
  }

  function processFile(file: File): void {
    if (!file.type.startsWith('image/')) {
      setError('Veuillez fournir une image au format JPEG, PNG ou WebP.');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      setError('La taille de l’image ne doit pas dépasser 10 Mo.');
      return;
    }

    setError(null);
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    onPhotoSelected?.(file);

    const formData = new FormData();
    formData.append('photo', file);

    startTransition(async () => {
      try {
        const res = await scanEquipmentPhotoAction(
          organizationId,
          { ok: false, code: 'UNKNOWN', message: '' },
          formData,
        );

        if (!res.ok) {
          setError(res.message || 'Impossible d’analyser l’image.');
          return;
        }

        setProposal(res.data);
        onProposal(res.data);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : 'Une erreur est survenue lors de l’analyse de la photo.',
        );
      }
    });
  }

  function handleReset(): void {
    setProposal(null);
    setPreviewUrl(null);
    setError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  const brandName = proposal?.brand.value;
  const modelName = proposal?.model.value;
  const subtype = proposal?.subtype.value;
  const frameSize = proposal?.frameSize.value;
  const isFrameSizeConfident = (proposal?.frameSize.confidence ?? 0) >= 0.5 && !!frameSize;
  const specs = proposal?.specifications.value;
  const specsList = specs ? Object.entries(specs).slice(0, 4) : [];

  return (
    <div
      className={`${styles.container} ${isDragging ? styles.containerDragging : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className={styles.header}>
        <div className={styles.headerIcon} aria-hidden="true">
          ⚡
        </div>
        <div className={styles.headerText}>
          <h2>
            <span>Scan & List Copilot</span>
            <span className={styles.aiBadge}>IA Multimodale</span>
          </h2>
          <p>
            Glissez une photo de votre équipement : l’IA extrait automatiquement la marque, le
            modèle, les spécifications techniques et génère la description.
          </p>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={handleFileChange}
        className={styles.fileInput}
        id="equipment-photo-scan"
      />

      {isPending && (
        <div className={styles.loadingBox} role="status" aria-live="polite">
          {previewUrl && (
            <img
              src={previewUrl}
              alt="Photo en cours d’analyse"
              className={styles.thumbnail}
            />
          )}
          <div className={styles.spinner} />
          <div className={styles.loadingText}>Analyse visuelle en cours par le VLM…</div>
          <div className={styles.loadingSubtext}>
            Extraction de la marque, du type de cadre, des composants et rédaction commerciale
          </div>
        </div>
      )}

      {!isPending && !proposal && (
        <div
          className={styles.dropArea}
          onClick={() => fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              fileInputRef.current?.click();
            }
          }}
        >
          <div className={styles.uploadIcon} aria-hidden="true">
            📸
          </div>
          <div className={styles.dropTitle}>
            Déposez une photo de profil ou cliquez pour parcourir
          </div>
          <div className={styles.dropSubtitle}>JPEG, PNG ou WebP jusqu’à 10 Mo</div>
        </div>
      )}

      {!isPending && proposal && (
        <div className={styles.successCard}>
          <div className={styles.successHeader}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              {previewUrl && (
                <img
                  src={previewUrl}
                  alt="Aperçu équipement"
                  className={styles.thumbnailSmall}
                />
              )}
              <div className={styles.successTitle}>
                <span aria-hidden="true">✓</span>
                <span>
                  Équipement identifié : {brandName || 'Inconnu'} {modelName || ''}
                </span>
              </div>
            </div>
            <button type="button" onClick={handleReset} className={styles.resetButton}>
              Scanner une autre photo
            </button>
          </div>

          <div className={styles.badgesGrid}>
            {brandName && (
              <span className={styles.badge}>
                🏷️ Marque : <strong>{brandName}</strong> ({Math.round((proposal.brand.confidence ?? 1) * 100)}%)
              </span>
            )}
            {modelName && (
              <span className={styles.badge}>
                🚲 Modèle : <strong>{modelName}</strong> ({Math.round((proposal.model.confidence ?? 1) * 100)}%)
              </span>
            )}
            {subtype && (
              <span className={styles.badge}>
                ⚙️ Type : <strong>{subtype}</strong>
              </span>
            )}
            {isFrameSizeConfident && (
              <span className={styles.badge}>
                📏 Taille : <strong>{frameSize}</strong>
              </span>
            )}
            {specsList.map(([key, val]) => (
              <span key={key} className={styles.badge}>
                • {key}: {String(val)}
              </span>
            ))}
          </div>

          {!isFrameSizeConfident && (
            <div className={styles.abstentionNotice}>
              <span aria-hidden="true">ℹ️</span>
              <span>
                <strong>Taille non déterminée avec certitude :</strong> Par sécurité (politique
                d’abstention), le champ variante a été laissé libre pour votre vérification manuelle.
              </span>
            </div>
          )}
        </div>
      )}

      {error && <div className={styles.errorBox}>{error}</div>}
    </div>
  );
}
