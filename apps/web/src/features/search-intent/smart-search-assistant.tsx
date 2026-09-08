'use client';

import { useState, useEffect, useTransition, type FormEvent } from 'react';
import { abstain, confident, type IntentProposal } from '@uttily/intelligence';

import { compileSearchIntentAction } from '@/app/actions/intent-search';
import styles from './smart-search-assistant.module.css';

interface SmartSearchAssistantProps {
  locale: 'fr' | 'en';
  onApplyProposal: (proposal: IntentProposal) => void;
  onConfirmSearch?: () => void;
  disabled?: boolean;
}

const CHIPS_FR = [
  '🚴 Tour du lac d’Annecy en VTT électrique ce samedi',
  '⛷️ Ski à Chamonix pour 2 personnes ce week-end',
  '🚣 Kayak pour moi seul demain après-midi',
];

const CHIPS_EN = [
  '🚴 Lake Annecy tour with e-bikes this Saturday',
  '⛷️ Skiing in Chamonix for 2 people this weekend',
  '🚣 Kayak for solo trip tomorrow afternoon',
];

const CATEGORY_NAMES_FR: Record<string, string> = {
  bike: 'Vélo',
  kayak: 'Kayak',
  ski: 'Ski',
  surf: 'Surf',
  paddle: 'Paddle',
  pedalboat: 'Pédalo',
};

const CATEGORY_NAMES_EN: Record<string, string> = {
  bike: 'Bike',
  kayak: 'Kayak',
  ski: 'Ski',
  surf: 'Surf',
  paddle: 'Paddleboard',
  pedalboat: 'Pedal boat',
};

function getCategoryEmoji(slug?: string): string {
  if (!slug) return '📦';
  const lower = slug.toLowerCase();
  if (lower.includes('bike') || lower.includes('velo') || lower.includes('vtt')) return '🚲';
  if (lower.includes('ski') || lower.includes('snowboard')) return '⛷️';
  if (lower.includes('kayak') || lower.includes('canoe')) return '🛶';
  if (lower.includes('paddle')) return '🏄';
  if (lower.includes('surf')) return '🏄';
  if (lower.includes('trailer') || lower.includes('remorque')) return '🛞';
  return '📦';
}

function getCategoryDisplayName(slug: string, locale: 'fr' | 'en'): string {
  const dict = locale === 'fr' ? CATEGORY_NAMES_FR : CATEGORY_NAMES_EN;
  return dict[slug.toLowerCase()] ?? slug;
}

export function formatNaturalDate(
  startDate?: string,
  endDateExclusive?: string,
  locale: 'fr' | 'en' = 'fr',
): string {
  if (!startDate) return '';
  const fr = locale === 'fr';

  const parseCivil = (s: string): Date | null => {
    const parts = s.split('-');
    if (parts.length !== 3) return null;
    return new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 12, 0, 0));
  };

  const start = parseCivil(startDate);
  if (!start) return startDate;

  let endCivil: Date | null = null;
  if (endDateExclusive) {
    const parsedEnd = parseCivil(endDateExclusive);
    if (parsedEnd) {
      parsedEnd.setUTCDate(parsedEnd.getUTCDate() - 1);
      // Guarantee end date is never before start date
      if (parsedEnd.getTime() < start.getTime()) {
        endCivil = new Date(start.getTime());
      } else {
        endCivil = parsedEnd;
      }
    }
  }

  // Single-day rental (e.g. "ce samedi" -> "Samedi 12 septembre" / "Saturday, September 12")
  if (!endCivil || endCivil.toISOString().slice(0, 10) === startDate) {
    const fullFormatter = new Intl.DateTimeFormat(fr ? 'fr-FR' : 'en-US', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone: 'UTC',
    });
    const formatted = fullFormatter.format(start);
    return formatted.charAt(0).toUpperCase() + formatted.slice(1);
  }

  // Multi-day rental (e.g. "12 sept. – 14 sept.")
  const shortDateFormatter = new Intl.DateTimeFormat(fr ? 'fr-FR' : 'en-US', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  return `${shortDateFormatter.format(start)} – ${shortDateFormatter.format(endCivil)}`;
}

export function SmartSearchAssistant({
  locale,
  onApplyProposal,
  onConfirmSearch,
  disabled = false,
}: SmartSearchAssistantProps): React.ReactElement {
  const fr = locale === 'fr';
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [appliedProposal, setAppliedProposal] = useState<IntentProposal | null>(null);

  const chips = fr ? CHIPS_FR : CHIPS_EN;

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  function handleSubmit(e?: FormEvent, forcedQuery?: string): void {
    if (e) e.preventDefault();
    const textToSubmit = (forcedQuery ?? query).trim();
    if (!textToSubmit) return;

    setSubmittedQuery(textToSubmit);
    setError(null);
    startTransition(async () => {
      try {
        const res = await compileSearchIntentAction(textToSubmit, locale);
        if (!res.ok) {
          setError(res.message);
          return;
        }

        setAppliedProposal(res.data);
        onApplyProposal(res.data);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : fr
              ? 'Erreur lors de l’analyse.'
              : 'Error during analysis.',
        );
      }
    });
  }

  function handleChipClick(chipText: string): void {
    const cleanText = chipText.replace(/^[\p{Emoji}\s]+/u, '');
    setQuery(cleanText);
    setSubmittedQuery(cleanText);
    handleSubmit(undefined, cleanText);
  }

  function handleRemoveDestination(): void {
    if (!appliedProposal) return;
    const updated: IntentProposal = {
      ...appliedProposal,
      destination: abstain(),
      destinationPublicId: abstain(),
    };
    setAppliedProposal(updated);
    onApplyProposal(updated);
  }

  function handleRemoveDate(): void {
    if (!appliedProposal) return;
    const updated: IntentProposal = {
      ...appliedProposal,
      dates: abstain(),
    };
    setAppliedProposal(updated);
    onApplyProposal(updated);
  }

  function handleRemovePeople(): void {
    if (!appliedProposal) return;
    const updated: IntentProposal = {
      ...appliedProposal,
      peopleCount: abstain(),
    };
    setAppliedProposal(updated);
    onApplyProposal(updated);
  }

  function handleSelectPeopleCount(count: number): void {
    if (!appliedProposal) return;
    const updated: IntentProposal = {
      ...appliedProposal,
      peopleCount: confident(count, 1.0, 'Sélectionné par l’utilisateur'),
    };
    setAppliedProposal(updated);
    onApplyProposal(updated);
  }

  function handleRemoveRequirement(index: number): void {
    if (!appliedProposal) return;
    const updatedReqs = appliedProposal.requirements.filter((_, i) => i !== index);
    const updated: IntentProposal = {
      ...appliedProposal,
      requirements: updatedReqs,
    };
    setAppliedProposal(updated);
    onApplyProposal(updated);
  }

  function handleConfirmAction(): void {
    setIsOpen(false);
    if (onConfirmSearch) {
      onConfirmSearch();
    }
  }

  const destinationName = appliedProposal?.destination?.value ?? null;
  const datesVal = appliedProposal?.dates?.value ?? null;
  const naturalDate = datesVal
    ? formatNaturalDate(datesVal.startDate, datesVal.endDateExclusive, locale)
    : null;
  const peopleCount = appliedProposal?.peopleCount?.value ?? null;
  const peopleText = peopleCount != null
    ? `${peopleCount} ${peopleCount > 1 ? (fr ? 'personnes' : 'people') : (fr ? 'personne' : 'person')}`
    : null;

  const requirements = appliedProposal?.requirements ?? [];

  const isTextModifiedAfterSubmit =
    appliedProposal !== null &&
    query.trim() !== submittedQuery.trim() &&
    query.trim().length > 0;
  const showSubmitButton = !appliedProposal || isTextModifiedAfterSubmit;


  if (!isOpen) {
    return (
      <div className={styles.container}>
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          className={styles.togglePill}
          disabled={disabled}
          aria-label={fr ? 'Décrivez votre sortie' : 'Describe your trip'}
        >
          <span className={styles.sparkleIcon} aria-hidden="true">
            ✨
          </span>
          <span>{fr ? 'Décrivez votre sortie' : 'Describe your trip'}</span>
          <span className={styles.aiBadge}>IA</span>
        </button>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div
        className={styles.card}
        role="region"
        aria-label={fr ? 'Préparez votre sortie' : 'Plan your trip'}
      >
        <div className={styles.cardHeader}>
          <div className={styles.cardTitle}>
            <span className={styles.sparkleIcon} aria-hidden="true">
              ✨
            </span>
            <span>{fr ? 'Préparez votre sortie' : 'Plan your trip'}</span>
            <span className={styles.aiBadge}>IA</span>
          </div>
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            className={styles.closeButton}
            aria-label={fr ? 'Fermer l’assistant' : 'Close assistant'}
          >
            ✕
          </button>
        </div>


            <form onSubmit={handleSubmit} className={styles.form}>
              <div className={styles.inputRow}>
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={
                    fr
                      ? 'On est 2 adultes et un enfant, vélos électriques à Annecy ce samedi…'
                      : 'We are 2 adults and 1 child, e-bikes in Annecy this Saturday…'
                  }
                  className={styles.input}
                  disabled={isPending || disabled}
                  autoFocus
                />
                {showSubmitButton && (
                  <button
                    type="submit"
                    disabled={isPending || disabled || !query.trim()}
                    className={styles.submitBtn}
                  >
                    {isPending ? (
                      <span>{fr ? 'Analyse…' : 'Analyzing…'}</span>
                    ) : isTextModifiedAfterSubmit ? (
                      <span>{fr ? 'Mettre à jour' : 'Update'}</span>
                    ) : (
                      <span>{fr ? 'Préparer ma sortie' : 'Plan my trip'}</span>
                    )}
                  </button>
                )}
              </div>

              {error && <div className={styles.errorBox}>{error}</div>}

              {/* État 1 : Avant interprétation -> Afficher les exemples */}
              {!appliedProposal && (
                <div className={styles.chipsRow}>
                  <span className={styles.chipLabel}>
                    {fr ? 'Exemples :' : 'Examples:'}
                  </span>
                  {chips.map((chipText) => (
                    <button
                      key={chipText}
                      type="button"
                      className={styles.chip}
                      onClick={() => handleChipClick(chipText)}
                      disabled={isPending || disabled}
                    >
                      {chipText}
                    </button>
                  ))}
                </div>
              )}

              {/* État 2 : Après interprétation -> Remplacer les exemples par les chips éditables et CTA final */}
              {appliedProposal && (
                <div className={styles.understoodSection}>
                  <div className={styles.understoodHeader}>
                    <span className={styles.understoodCheck} aria-hidden="true">
                      ✓
                    </span>
                    <span className={styles.understoodLabel}>
                      {fr ? 'J’ai compris votre sortie' : 'I understood your trip'}
                    </span>
                  </div>

                  <div className={styles.understoodChips}>
                    {destinationName ? (
                      <span className={styles.editableChip}>
                        <span>📍 {destinationName}</span>
                        <button
                          type="button"
                          onClick={handleRemoveDestination}
                          className={styles.removeChipBtn}
                          aria-label={fr ? `Supprimer ${destinationName}` : `Remove ${destinationName}`}
                        >
                          ×
                        </button>
                      </span>
                    ) : (
                      <span className={styles.unspecifiedChip}>
                        <span>📍 {fr ? 'Destination à préciser' : 'Destination to specify'}</span>
                      </span>
                    )}

                    {naturalDate ? (
                      <span className={styles.editableChip}>
                        <span>📅 {naturalDate}</span>
                        <button
                          type="button"
                          onClick={handleRemoveDate}
                          className={styles.removeChipBtn}
                          aria-label={fr ? 'Supprimer la date' : 'Remove date'}
                        >
                          ×
                        </button>
                      </span>
                    ) : (
                      <span className={styles.unspecifiedChip}>
                        <span>📅 {fr ? 'Dates à préciser' : 'Dates to specify'}</span>
                      </span>
                    )}

                    {peopleText ? (
                      <span className={styles.editableChip}>
                        <span>👤 {peopleText}</span>
                        <button
                          type="button"
                          onClick={handleRemovePeople}
                          className={styles.removeChipBtn}
                          aria-label={fr ? 'Réinitialiser le nombre de personnes' : 'Reset people count'}
                        >
                          ×
                        </button>
                      </span>
                    ) : (
                      <span className={styles.unspecifiedChip}>
                        <span>👤 {fr ? 'Personnes à préciser' : 'People to specify'}</span>
                      </span>
                    )}

                    {requirements.length > 0 ? (
                      requirements.map((req, idx) => (
                        <span key={idx} className={styles.editableChip}>
                          <span>
                            {getCategoryEmoji(req.categorySlug)}{' '}
                            {getCategoryDisplayName(req.categorySlug, locale)}
                            {req.electricPreferred ? (fr ? ' · Électrique' : ' · Electric') : ''}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleRemoveRequirement(idx)}
                            className={styles.removeChipBtn}
                            aria-label={fr ? `Supprimer ${req.categorySlug}` : `Remove ${req.categorySlug}`}
                          >
                            ×
                          </button>
                        </span>
                      ))
                    ) : (
                      <span className={styles.unspecifiedChip}>
                        <span>🚲 {fr ? 'Équipement à préciser' : 'Equipment to specify'}</span>
                      </span>
                    )}
                  </div>

                  {peopleCount == null && (
                    <div className={styles.missingPrompt}>
                      <span className={styles.missingPromptTitle}>
                        {fr
                          ? 'Pour trouver le bon équipement, combien serez-vous ?'
                          : 'To find the right equipment, how many will you be?'}
                      </span>
                      <div className={styles.peopleSelector}>
                        {[1, 2, 3, 4].map((count) => (
                          <button
                            key={count}
                            type="button"
                            className={styles.peopleBtn}
                            onClick={() => handleSelectPeopleCount(count)}
                          >
                            {count === 4 ? '4+' : String(count)}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className={styles.confirmRow}>
                    <button
                      type="button"
                      onClick={handleConfirmAction}
                      className={styles.confirmBtn}
                    >
                      <span>{fr ? 'Voir les solutions disponibles →' : 'View available solutions →'}</span>
                    </button>
                  </div>
                </div>
              )}
            </form>
      </div>
    </div>
  );
}

