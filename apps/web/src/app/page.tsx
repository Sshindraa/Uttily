import Link from 'next/link';

export default function HomePage(): React.ReactElement {
  return (
    <main>
      <h1>Uttily</h1>
      <p>Plateforme B2B2C de location d\u2019équipements.</p>
      <p>
        <Link href="/sign-in">Se connecter</Link>
      </p>
    </main>
  );
}
