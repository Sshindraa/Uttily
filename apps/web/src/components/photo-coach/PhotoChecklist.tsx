'use client';

import { type ReactElement, useEffect, useState } from 'react';
import type { PhotoSlotDefinition } from '@uttily/contracts';
import styles from './PhotoChecklist.module.css';

export interface PhotoChecklistProps {
  slot: PhotoSlotDefinition;
  imageBlob: Blob;
  isSaving: boolean;
  onRetake: () => void;
  onConfirm: () => void;
}

export function PhotoChecklist({
  slot,
  imageBlob,
  isSaving,
  onRetake,
  onConfirm,
}: PhotoChecklistProps): ReactElement {
  const [previewUrl, setPreviewUrl] = useState<string>('');
  const [checkedItems, setCheckedItems] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const url = URL.createObjectURL(imageBlob);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [imageBlob]);

  const toggleItem = (item: string) => {
    setCheckedItems((prev) => ({
      ...prev,
      [item]: !prev[item],
    }));
  };

  const allChecked =
    slot.checklistItems.length > 0 &&
    slot.checklistItems.every((item) => !!checkedItems[item]);

  return (
    <div className={styles.container}>
      <div className={styles.previewContainer}>
        {previewUrl && (
          <img
            src={previewUrl}
            alt={`Aperçu de la photo pour ${slot.title}`}
            className={styles.previewImage}
          />
        )}
      </div>

      <div className={styles.card}>
        <h3 className={styles.title}>
          {slot.title} — Vérifiez avant d'enregistrer :
        </h3>

        <ul className={styles.list}>
          {slot.checklistItems.map((item) => {
            const isChecked = !!checkedItems[item];
            return (
              <li key={item}>
                <label className={styles.item}>
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => toggleItem(item)}
                    className={styles.checkbox}
                    disabled={isSaving}
                  />
                  <span className={styles.itemLabel}>{item}</span>
                </label>
              </li>
            );
          })}
        </ul>

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.retakeBtn}
            onClick={onRetake}
            disabled={isSaving}
          >
            Reprendre
          </button>
          <button
            type="button"
            className={styles.useBtn}
            onClick={onConfirm}
            disabled={!allChecked || isSaving}
          >
            {isSaving ? 'Enregistrement…' : 'Utiliser cette photo'}
          </button>
        </div>
      </div>
    </div>
  );
}
