'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from './internal.module.css';

export function SupportSearchForm({ initialQuery }: { initialQuery?: string | undefined }) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery ?? '');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) {
      router.push(`/internal?q=${encodeURIComponent(query.trim())}`);
    } else {
      router.push('/internal');
    }
  };

  return (
    <form
      className={styles.searchForm}
      onSubmit={handleSubmit}
      role="search"
      aria-label="Recherche support"
    >
      <input
        type="text"
        className={styles.searchInput}
        placeholder="Rechercher par ID (UUID), Email, Nom d'organisation, Slug, Intent Stripe (pi_...)..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      <button type="submit" className={styles.searchButton}>
        🔍 Rechercher
      </button>
    </form>
  );
}
